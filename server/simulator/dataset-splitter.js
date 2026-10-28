'use strict';

const { SeededRNG } = require('./seeded-rng');
const { DATASET_SCHEMA_VERSION, validateDecisionDataset,
  validateEnvironmentRollout } = require('./dataset-contract');
const { SCENARIO_CHOICES } = require('./dataset-validator');

const SPLIT_VERSION = 'dataset-split-p1.1';
const NAMES = ['train', 'val', 'test'];
const DEFAULT_RATIOS = Object.freeze({ train: 0.7, val: 0.15, test: 0.15 });
const keyOf = metadata => JSON.stringify([metadata.scenario_instance_id, metadata.seed]);

function targetCounts(total, ratios) {
  if (!ratios || NAMES.some(name => !Number.isFinite(ratios[name]) || ratios[name] <= 0)
    || Math.abs(NAMES.reduce((sum, name) => sum + ratios[name], 0) - 1) > 1e-9) {
    throw new RangeError('split ratios must be positive and sum to one');
  }
  const counts = Object.fromEntries(NAMES.map(name => [name, Math.floor(total * ratios[name])]));
  const remainder = total - NAMES.reduce((sum, name) => sum + counts[name], 0);
  const fractions = NAMES.map(name => ({ name, fraction: total * ratios[name] - counts[name] }))
    .sort((a, b) => b.fraction - a.fraction || NAMES.indexOf(a.name) - NAMES.indexOf(b.name));
  for (let index = 0; index < remainder; index += 1) counts[fractions[index].name] += 1;
  for (const name of NAMES) if (!counts[name]) {
    const donor = NAMES.filter(other => counts[other] > 1)
      .sort((a, b) => counts[b] - counts[a])[0];
    if (!donor) throw new RangeError('not enough groups for three isolated splits');
    counts[donor] -= 1;
    counts[name] += 1;
  }
  return counts;
}

function scenarioCoverage(groups) {
  return Object.fromEntries(Object.entries(SCENARIO_CHOICES).map(([dimension, choices]) =>
    [dimension, Object.fromEntries(choices.map(choice =>
      [choice, groups.filter(group => group.scenario_dimensions?.[dimension] === choice).length]))]));
}

function coverageGain(group, selected) {
  const covered = new Set(selected.flatMap(item => Object.keys(SCENARIO_CHOICES)
    .map(dimension => `${dimension}:${item.scenario_dimensions?.[dimension]}`)));
  return Object.keys(SCENARIO_CHOICES).filter(dimension =>
    !covered.has(`${dimension}:${group.scenario_dimensions?.[dimension]}`)).length;
}

function checkSplitLeakage(result) {
  const errors = [];
  const owners = { group: new Map(), episode: new Map(), rollout: new Map() };
  for (const name of NAMES) {
    for (const kind of ['decision', 'environment']) for (const row of result.splits[kind][name]) {
      const keys = { group: keyOf(row.metadata),
        episode: row.metadata.episode_id, rollout: row.metadata.trajectory_id };
      for (const [type, key] of Object.entries(keys)) {
        if (key === null || key === undefined) continue;
        const previous = owners[type].get(key);
        if (previous && previous !== name) errors.push(`${type}:${key}:${previous}/${name}`);
        owners[type].set(key, name);
      }
    }
  }
  for (const name of NAMES) {
    const listed = new Set(result.manifest.groups[name].map(group => group.group_id));
    for (const kind of ['decision', 'environment']) for (const row of result.splits[kind][name])
      if (!listed.has(keyOf(row.metadata))) errors.push(`unlisted group:${name}`);
    if (listed.size !== result.manifest.groups[name].length)
      errors.push(`duplicate manifest group:${name}`);
  }
  return { pass: errors.length === 0, errors,
    unique_groups: owners.group.size, unique_episodes: owners.episode.size,
    unique_rollouts: owners.rollout.size };
}

function splitDatasets({ decisionDataset, environmentDataset, seed = 42,
  ratios = DEFAULT_RATIOS } = {}) {
  validateDecisionDataset(decisionDataset);
  validateEnvironmentRollout(environmentDataset);
  new SeededRNG(seed);
  const groupsByKey = new Map();
  const collect = (row, kind) => {
    const metadata = row.metadata;
    const key = keyOf(metadata);
    if (!groupsByKey.has(key)) groupsByKey.set(key, { group_id: key,
      scenario_instance_id: metadata.scenario_instance_id, seed: metadata.seed,
      scenario_dimensions: metadata.scenario_dimensions,
      episode_ids: new Set(), rollout_ids: new Set(),
      decision_samples: 0, environment_samples: 0 });
    const group = groupsByKey.get(key);
    if (JSON.stringify(group.scenario_dimensions) !== JSON.stringify(metadata.scenario_dimensions))
      throw new Error('inconsistent scenario dimensions within split group');
    group[`${kind}_samples`] += 1;
    if (metadata.episode_id) group.episode_ids.add(metadata.episode_id);
    if (metadata.trajectory_id) group.rollout_ids.add(metadata.trajectory_id);
  };
  decisionDataset.samples.forEach(row => collect(row, 'decision'));
  environmentDataset.samples.forEach(row => collect(row, 'environment'));
  if (groupsByKey.size < 3) throw new RangeError('at least three scenario-seed groups required');
  const counts = targetCounts(groupsByKey.size, ratios);
  const rng = new SeededRNG(seed);
  const available = [...groupsByKey.values()].sort((a, b) => a.group_id.localeCompare(b.group_id));
  for (let index = available.length - 1; index > 0; index -= 1) {
    const other = rng.nextInt(0, index);
    [available[index], available[other]] = [available[other], available[index]];
  }
  const assigned = { train: [], val: [], test: [] };
  // Small held-out sets first: greedily maximize distinct scenario labels without
  // ever duplicating a scenario-seed group. Deterministic shuffle resolves ties.
  for (const name of ['test', 'val']) while (assigned[name].length < counts[name]) {
    let bestIndex = 0, bestGain = -1;
    for (let index = 0; index < available.length; index += 1) {
      const gain = coverageGain(available[index], assigned[name]);
      if (gain > bestGain) { bestGain = gain; bestIndex = index; }
    }
    assigned[name].push(available.splice(bestIndex, 1)[0]);
  }
  assigned.train = available;
  const owner = new Map(NAMES.flatMap(name => assigned[name].map(group => [group.group_id, name])));
  const splits = { decision: {}, environment: {} };
  for (const name of NAMES) {
    splits.decision[name] = decisionDataset.samples.filter(row => owner.get(keyOf(row.metadata)) === name);
    splits.environment[name] = environmentDataset.samples.filter(row => owner.get(keyOf(row.metadata)) === name);
  }
  const first = decisionDataset.samples[0]?.metadata || environmentDataset.samples[0].metadata;
  const generationVersion = [first.simulator_version, first.scenario_parameter_version,
    first.visitor_profile_version].join('|');
  const manifest = { dataset_version: DATASET_SCHEMA_VERSION,
    split_version: SPLIT_VERSION, generation_version: generationVersion, seed,
    ratios: { ...ratios }, grouping_keys: ['scenario_instance_id', 'seed',
      'episode_id', 'trajectory_id'], source_tier: 'T4', synthetic: true,
    groups: Object.fromEntries(NAMES.map(name => [name, assigned[name].map(group => ({
      group_id: group.group_id, scenario_instance_id: group.scenario_instance_id,
      seed: group.seed, episode_ids: [...group.episode_ids].sort(),
      rollout_ids: [...group.rollout_ids].sort() }))])),
    group_counts: Object.fromEntries(NAMES.map(name => [name, assigned[name].length])),
    sample_counts: Object.fromEntries(NAMES.map(name => [name, {
      decision: splits.decision[name].length, environment: splits.environment[name].length }])),
    scenario_coverage: Object.fromEntries(NAMES.map(name =>
      [name, scenarioCoverage(assigned[name])])),
    coverage_gaps: Object.fromEntries(NAMES.map(name => [name,
      Object.entries(scenarioCoverage(assigned[name])).flatMap(([dimension, choices]) =>
        Object.entries(choices).filter(([, count]) => !count)
          .map(([choice]) => `${dimension}:${choice}`))])) };
  const result = { splits, manifest };
  result.leakage_check = checkSplitLeakage(result);
  if (!result.leakage_check.pass) throw new Error(`split leakage: ${result.leakage_check.errors.join(', ')}`);
  return result;
}

module.exports = { SPLIT_VERSION, DEFAULT_RATIOS, splitDatasets, checkSplitLeakage };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleScenario } = require('../server/simulator/scenario-sampler');
const { generateDecisionDataset, generateEnvironmentRollout } = require('../server/simulator/dataset-builder');
const { splitDatasets, checkSplitLeakage } = require('../server/simulator/dataset-splitter');

const base = { crowd_level: 'LOW', calendar_type: 'WEEKDAY', weather: 'CLEAR',
  visitor_speed_distribution: 'NORMAL', dwell_distribution: 'NORMAL',
  road_condition: 'NORMAL', event_condition: 'NORMAL_EVENT', observation_quality: 'CLEAN' };
const dimensions = [base,
  { ...base, crowd_level: 'MEDIUM', weather: 'HOT', observation_quality: 'NOISY' },
  { ...base, crowd_level: 'HIGH', calendar_type: 'WEEKEND', weather: 'RAIN',
    road_condition: 'LOCAL_CLOSURE', event_condition: 'EVENT_DELAY',
    observation_quality: 'MISSING' },
  { ...base, calendar_type: 'WEEKEND', weather: 'RAIN',
    road_condition: 'LOCAL_CLOSURE', observation_quality: 'DELAYED' },
  { ...base, crowd_level: 'MEDIUM', event_condition: 'EVENT_DELAY',
    observation_quality: 'MIXED' }];
const scenarioInstances = dimensions.map((item, index) =>
  sampleScenario({ seed: 42, index: index + 1, dimensions: item }));
const seeds = [42, 43, 44];
const decisionDataset = generateDecisionDataset({ scenarioInstances, seeds,
  episodes_per_scenario: 1, max_decisions: 4 });
const environmentDataset = generateEnvironmentRollout({ scenarioInstances, seeds, steps: 12 });
const options = { decisionDataset, environmentDataset, seed: 7717 };
const result = splitDatasets(options);

test('TS1 default ratio allocates complete scenario-seed groups', () => {
  assert.deepEqual(result.manifest.group_counts, { train: 11, val: 2, test: 2 });
  assert.deepEqual(result.manifest.ratios, { train: 0.7, val: 0.15, test: 0.15 });
  assert.equal(result.leakage_check.unique_groups, 15);
});
test('TS2 all decision and environment samples are assigned once', () => {
  assert.equal(['train', 'val', 'test'].reduce((sum, name) =>
    sum + result.splits.decision[name].length, 0), decisionDataset.samples.length);
  assert.equal(['train', 'val', 'test'].reduce((sum, name) =>
    sum + result.splits.environment[name].length, 0), environmentDataset.samples.length);
});
test('TS3 one episode and all its steps stay in one split', () => {
  const owners = new Map();
  for (const name of ['train', 'val', 'test']) for (const row of result.splits.decision[name]) {
    const previous = owners.get(row.metadata.episode_id);
    assert.ok(!previous || previous === name);
    owners.set(row.metadata.episode_id, name);
  }
  assert.equal(owners.size, decisionDataset.episode_summaries.length);
});
test('TS4 rollout steps and paired scenario-seed episodes share a split', () => {
  const owners = new Map();
  for (const name of ['train', 'val', 'test']) for (const kind of ['decision', 'environment'])
    for (const row of result.splits[kind][name]) {
      const key = JSON.stringify([row.metadata.scenario_instance_id, row.metadata.seed]);
      const previous = owners.get(key);
      assert.ok(!previous || previous === name);
      owners.set(key, name);
    }
  assert.equal(owners.size, 15);
});
test('TS5 manifest records versions, provenance, counts and coverage gaps', () => {
  const manifest = result.manifest;
  assert.equal(manifest.dataset_version, 'dataset-p1.1');
  assert.equal(manifest.split_version, 'dataset-split-p1.1');
  assert.ok(manifest.generation_version.includes('visitor-p1.2'));
  assert.equal(manifest.source_tier, 'T4');
  assert.equal(manifest.synthetic, true);
  assert.deepEqual(manifest.grouping_keys,
    ['scenario_instance_id', 'seed', 'episode_id', 'trajectory_id']);
  assert.ok(manifest.scenario_coverage.train.crowd_level.LOW > 0);
  assert.ok(manifest.coverage_gaps.val.length > 0);
  assert.ok(manifest.coverage_gaps.test.length > 0);
});
test('TS6 same split seed reproduces the complete manifest', () => {
  assert.deepEqual(splitDatasets(options).manifest, result.manifest);
});
test('TS7 configurable ratios retain group isolation', () => {
  const custom = splitDatasets({ ...options,
    ratios: { train: 0.6, val: 0.2, test: 0.2 } });
  assert.deepEqual(custom.manifest.group_counts, { train: 9, val: 3, test: 3 });
  assert.equal(custom.leakage_check.pass, true);
});
test('TS8 leakage checker catches moved episode, rollout and scenario group', () => {
  const tampered = { manifest: result.manifest, splits: {
    decision: { ...result.splits.decision, val: [...result.splits.decision.val,
      result.splits.decision.train[0]] }, environment: result.splits.environment } };
  const leak = checkSplitLeakage(tampered);
  assert.equal(leak.pass, false);
  assert.ok(leak.errors.some(error => error.startsWith('group:')));
  assert.ok(leak.errors.some(error => error.startsWith('episode:')));
});
test('TS9 splitting does not mutate source datasets', () => {
  const beforeDecision = structuredClone(decisionDataset);
  const beforeEnvironment = structuredClone(environmentDataset);
  splitDatasets(options);
  assert.deepEqual(decisionDataset, beforeDecision);
  assert.deepEqual(environmentDataset, beforeEnvironment);
});
test('TS10 invalid ratios and too few groups are refused', () => {
  assert.throws(() => splitDatasets({ ...options,
    ratios: { train: 0.8, val: 0.2, test: 0.2 } }), /ratios/);
  const oneScenario = [scenarioInstances[0]];
  const littleDecision = generateDecisionDataset({ scenarioInstances: oneScenario,
    seeds: [42], episodes_per_scenario: 1 });
  const littleEnvironment = generateEnvironmentRollout({ scenarioInstances: oneScenario,
    seeds: [42], steps: 12 });
  assert.throws(() => splitDatasets({ decisionDataset: littleDecision,
    environmentDataset: littleEnvironment }), /three scenario-seed groups/);
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { sampleScenario } = require('./scenario-sampler');
const { DATASET_SCHEMA_VERSION, HORIZONS, projectDecisionRoles,
  projectEnvironmentRoles } = require('./dataset-contract');
const { generateDecisionDataset, generateEnvironmentRollout } = require('./dataset-builder');
const { validateDatasetBatch } = require('./dataset-validator');
const { splitDatasets, SPLIT_VERSION } = require('./dataset-splitter');
const { toMillis } = require('../planner/time');

const DATASET_VERSION = 'v0.1';
const GENERATION_SEEDS = Object.freeze([42, 43, 44]);
const SPLIT_SEED = 7717;
const SCENARIO_TEMPLATE_COUNT = 15;
const EPISODES_PER_GROUP = 2;
const MAX_DECISIONS = 7;
const ENVIRONMENT_STEPS = 24;
const SPLITS = ['train', 'val', 'test'];
const ACTIONS = ['VISIT_POI', 'ATTEND_EVENT', 'REST', 'WAIT', 'EXIT'];

function scenarioTemplates(count = SCENARIO_TEMPLATE_COUNT) {
  if (!Number.isInteger(count) || count < 5 || count > 15)
    throw new RangeError('scenario template count must be 5..15');
  const qualities = ['CLEAN', 'NOISY', 'MISSING', 'DELAYED', 'MIXED'];
  const crowd = ['LOW', 'MEDIUM', 'HIGH'];
  const weather = ['CLEAR', 'RAIN', 'HOT'];
  const speed = ['SLOWER', 'NORMAL', 'FASTER'];
  const dwell = ['SHORT', 'NORMAL', 'LONG'];
  return Array.from({ length: count }, (_, index) => sampleScenario({
    scenario_family: 'DATASET_V01', seed: GENERATION_SEEDS[0], index: index + 1,
    dimensions: { crowd_level: crowd[index % 3],
      calendar_type: index % 2 ? 'WEEKEND' : 'WEEKDAY',
      weather: weather[Math.floor(index / 5)],
      visitor_speed_distribution: speed[(index + 1) % 3],
      dwell_distribution: dwell[(index + 2) % 3],
      road_condition: index % 4 === 0 || index % 4 === 3 ? 'LOCAL_CLOSURE' : 'NORMAL',
      event_condition: index % 4 === 1 || index % 4 === 3 ? 'EVENT_DELAY' : 'NORMAL_EVENT',
      observation_quality: qualities[index % 5] }
  }));
}

function visitorProfileSpecs() {
  return [
    { preference_weights: { culture: 1.5, scenery: 0.5, show: 0.5, view: 0.5 },
      plan_acceptance_rate: 0.8, deviation_rate: 0.2, early_exit_base: 0.03 },
    { initial_fatigue: 0.7,
      preference_weights: { culture: 0.5, scenery: 1.5, show: 1.5, view: 1.5 },
      plan_acceptance_rate: 0.7, deviation_rate: 0.3, early_exit_base: 0.1 }
  ];
}

function combineBatches(decisionBatches, environmentBatches) {
  const decisions = decisionBatches.flatMap(batch => batch.samples);
  const episodes = decisionBatches.flatMap(batch => batch.episode_summaries);
  const environments = environmentBatches.flatMap(batch => batch.samples);
  const trajectories = environmentBatches.flatMap(batch => batch.trajectory_summaries);
  const actionCounts = Object.fromEntries(ACTIONS.map(action => [action,
    decisionBatches.reduce((sum, batch) => sum + batch.stats.action_counts[action], 0)]));
  const decisionDataset = { dataset_type: 'DECISION_TRANSITION',
    schema_version: DATASET_SCHEMA_VERSION, source_tier: 'T4', synthetic: true,
    samples: decisions, episode_summaries: episodes,
    stats: { episode_count: episodes.length, sample_count: decisions.length,
      action_counts: actionCounts } };
  const environmentDataset = { dataset_type: 'FIXED_5_MIN_ENVIRONMENT',
    schema_version: DATASET_SCHEMA_VERSION, step_min: 5,
    source_tier: 'T4', synthetic: true, samples: environments,
    trajectory_summaries: trajectories,
    stats: { sample_count: environments.length,
      valid_targets: Object.fromEntries(Object.keys(HORIZONS).map(key =>
        [key, environments.filter(row => row.target_available[key]).length])) } };
  return { decisionDataset, environmentDataset };
}

function observationMissingStats(samples) {
  let missing = 0, total = 0;
  for (const sample of samples) {
    const observation = sample.input?.observation || sample.observed_input?.observation;
    const visit = value => {
      if (typeof value === 'boolean') { total += 1; if (value) missing += 1; }
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(observation.missing_mask);
  }
  return { masked_fields: missing, maskable_fields: total,
    rate: total ? Math.round(missing / total * 1e6) / 1e6 : 0,
    basis: 'observation.missing_mask true flags / all mask flags' };
}

function buildDatasetV01({ templateCount = SCENARIO_TEMPLATE_COUNT } = {}) {
  const templates = scenarioTemplates(templateCount);
  const profiles = visitorProfileSpecs();
  const decisionBatches = [], environmentBatches = [];
  for (let offset = 0; offset < templates.length; offset += 5) {
    const scenarioInstances = templates.slice(offset, offset + 5);
    decisionBatches.push(generateDecisionDataset({ scenarioInstances, visitorProfiles: profiles,
      seeds: GENERATION_SEEDS, episodes_per_scenario: EPISODES_PER_GROUP,
      max_decisions: MAX_DECISIONS }));
    environmentBatches.push(generateEnvironmentRollout({ scenarioInstances,
      seeds: GENERATION_SEEDS, steps: ENVIRONMENT_STEPS }));
  }
  const { decisionDataset, environmentDataset } = combineBatches(decisionBatches,
    environmentBatches);
  const validation = validateDatasetBatch({ decisionDataset, environmentDataset });
  if (!validation.valid) throw new Error(`dataset validation failed: ${JSON.stringify(validation.errors)}`);
  const split = splitDatasets({ decisionDataset, environmentDataset, seed: SPLIT_SEED });
  if (!split.leakage_check.pass || SPLITS.some(name =>
    !split.splits.decision[name].length || !split.splits.environment[name].length))
    throw new Error('empty split or group leakage');
  if (Object.keys(HORIZONS).some(key => !validation.horizon_coverage[key].count))
    throw new Error('missing valid future horizon');
  const gapCount = ['val', 'test'].reduce((sum, name) =>
    sum + split.manifest.coverage_gaps[name].length, 0);
  if (templateCount === SCENARIO_TEMPLATE_COUNT && gapCount >= 10)
    throw new Error('scenario coverage did not improve over 15-group review batch');
  return { decisionDataset, environmentDataset, validation, split,
    missing: { decision: observationMissingStats(decisionDataset.samples),
      environment: observationMissingStats(environmentDataset.samples) } };
}

function recordsDigest(built) {
  const hash = crypto.createHash('sha256');
  for (const name of SPLITS) {
    for (const row of built.split.splits.decision[name])
      hash.update(JSON.stringify(projectDecisionRoles(row)) + '\n');
    for (const row of built.split.splits.environment[name]) {
      const roles = projectEnvironmentRoles(row);
      roles.FUTURE_TARGET = { ...roles.FUTURE_TARGET,
        availability: row.target_available };
      hash.update(JSON.stringify(roles) + '\n');
    }
  }
  return hash.digest('hex');
}

function field(field_name, data_type, unit, nullable, role, missing_encoding = null,
  description = '') {
  return { field_name, data_type, unit, nullable, missing_encoding, role, description };
}

function schemaDocument() {
  return { dataset_version: DATASET_VERSION, dataset_schema_version: DATASET_SCHEMA_VERSION,
    source_tier: 'T4', synthetic: true,
    jsonl: 'UTF-8; one JSON object per line; each split file contains one sample per line',
    roles: {
      decision: ['POLICY_INPUT', 'ACTION_LABEL', 'TRANSITION_MODEL_INPUT',
        'TARGET', 'AUDIT', 'METADATA'],
      environment: ['OBSERVED_INPUT', 'LATENT_CURRENT', 'FUTURE_TARGET',
        'AUDIT', 'METADATA'] },
    dynamic_ids: 'pois, roads, events and legal_actions use the repository graph/ID contract; keys are IDs, not column positions',
    fields: {
      decision: [
        field('POLICY_INPUT.observation', 'object', null, false, 'MODEL/POLICY INPUT',
          'field-level null + missing_mask', 'Only information available before choosing an action'),
        field('POLICY_INPUT.visitor_state', 'object', null, false, 'MODEL/POLICY INPUT'),
        field('POLICY_INPUT.visitor_state.remaining_time_min', 'number', 'min', false, 'MODEL/POLICY INPUT'),
        field('POLICY_INPUT.visitor_state.fatigue', 'number', 'ratio 0..1', false, 'MODEL/POLICY INPUT'),
        field('POLICY_INPUT.legal_actions', 'array<object>', null, false, 'MODEL/POLICY INPUT'),
        field('ACTION_LABEL.chosen_action', 'object', null, false, 'ACTION LABEL'),
        field('TRANSITION_MODEL_INPUT.observation', 'object', null, false, 'TRANSITION INPUT'),
        field('TRANSITION_MODEL_INPUT.visitor_state', 'object', null, false, 'TRANSITION INPUT'),
        field('TRANSITION_MODEL_INPUT.chosen_action', 'object', null, false, 'TRANSITION INPUT'),
        field('TRANSITION_MODEL_INPUT.delta_t_min', 'number', 'min', false, 'TRANSITION INPUT',
          null, 'Measured after action completion; never a current action-selection policy input'),
        field('TARGET.reward.total', 'number', 'synthetic reward', false, 'TRAINING TARGET'),
        field('TARGET.reward.components', 'object<string, number|null>', 'normalized score', true,
          'TRAINING TARGET', 'null means component not applicable'),
        field('TARGET.next_observation', 'object', null, false, 'TRAINING TARGET'),
        field('TARGET.next_visitor_state', 'object', null, false, 'TRAINING TARGET'),
        field('TARGET.latent_target', 'object', null, false, 'TRAINING TARGET'),
        field('TARGET.done', 'boolean', null, false, 'TRAINING TARGET'),
        field('TARGET.termination_reason', 'string|null', null, true,
          'TRAINING TARGET', 'null until terminal'),
        field('AUDIT.transition_audit', 'object', null, false, 'AUDIT ONLY'),
        field('AUDIT.policy_audit', 'object', null, false, 'AUDIT ONLY'),
        field('METADATA.episode_id', 'string', null, false, 'METADATA'),
        field('METADATA.scenario_instance_id', 'string', null, false, 'METADATA'),
        field('METADATA.seed', 'integer', null, false, 'METADATA'),
        field('METADATA.source_tier', 'string', null, false, 'METADATA')
      ],
      environment: [
        field('OBSERVED_INPUT.observation', 'object', null, false, 'MODEL/POLICY INPUT',
          'field-level null + missing_mask', 'Default deployment world-model input'),
        field('OBSERVED_INPUT.observation.timestamp', 'string', 'local simulation time', false,
          'MODEL/POLICY INPUT'),
        field('OBSERVED_INPUT.observation.pois.*.queue_count', 'integer|null', 'persons', true,
          'MODEL/POLICY INPUT', 'null and missing_mask=true when not observed'),
        field('OBSERVED_INPUT.observation.roads.*.travel_time_min', 'number|null', 'min', true,
          'MODEL/POLICY INPUT', 'null and missing_mask=true when not observed'),
        field('LATENT_CURRENT.environment_state', 'object', null, false, 'AUDIT/ORACLE ONLY',
          null, 'Do not feed into a default deployment model'),
        field('LATENT_CURRENT.environment_state.pois.*.queue_count', 'integer', 'persons', false,
          'AUDIT/ORACLE ONLY'),
        field('LATENT_CURRENT.environment_state.roads.*.travel_time_min', 'number', 'min', false,
          'AUDIT/ORACLE ONLY'),
        field('LATENT_CURRENT.environment_state.population.park_population', 'integer', 'persons',
          false, 'AUDIT/ORACLE ONLY'),
        field('FUTURE_TARGET.target_5', 'object|null', 't+5 min', true,
          'TRAINING TARGET', 'null with availability=false at tail'),
        field('FUTURE_TARGET.target_15', 'object|null', 't+15 min', true,
          'TRAINING TARGET', 'null with availability=false at tail'),
        field('FUTURE_TARGET.target_30', 'object|null', 't+30 min', true,
          'TRAINING TARGET', 'null with availability=false at tail'),
        field('FUTURE_TARGET.target_60', 'object|null', 't+60 min', true,
          'TRAINING TARGET', 'null with availability=false at tail'),
        field('FUTURE_TARGET.availability', 'object<string, boolean>', null, false,
          'TRAINING TARGET'),
        field('AUDIT.expected_edge_occupancy', 'object<string, integer>', 'persons', false,
          'AUDIT ONLY'),
        field('METADATA.trajectory_id', 'string', null, false, 'METADATA'),
        field('METADATA.scenario_instance_id', 'string', null, false, 'METADATA'),
        field('METADATA.seed', 'integer', null, false, 'METADATA'),
        field('METADATA.step_index', 'integer', '5-min step', false, 'METADATA'),
        field('METADATA.source_tier', 'string', null, false, 'METADATA')
      ] } };
}

function readme(waitCount) {
  return `# dataset_v0.1\n\n` +
    `这是景策万象第一版 **T4 仿真合成**数据，用于 A 编写 DataLoader、训练 baseline 和接口联调，` +
    `不是万岁山真实运营观测。\n\n` +
    `- \`environment/{train,val,test}.jsonl\`：每 5 分钟一条环境样本。建议 A 先用 ` +
    `\`OBSERVED_INPUT\` 训练 15/30/60 分钟环境预测 baseline；按 ` +
    `\`FUTURE_TARGET.availability\` 过滤尾部不可用目标。\n` +
    `- \`decision/{train,val,test}.jsonl\`：动作级转移。之后可用 ` +
    `\`TRANSITION_MODEL_INPUT\` 预测 \`TARGET\`；动作选择只能读取 \`POLICY_INPUT\`，` +
    `真实 \`delta_t_min\` 在动作结束后才知道。\n` +
    `- UTF-8 JSONL，每行一个独立 JSON 对象，可逐行 \`JSON.parse\`；不要把同组 step ` +
    `再次随机分散到其他集合。\n` +
    `- \`schema.json\` 解释字段、单位、缺失编码和角色；\`dataset_manifest.json\` ` +
    `记录版本、规模与文件校验和；\`split_manifest.json\` 记录分组和覆盖；` +
    `\`validation_report.json\` 记录质量检查与限制。\n\n` +
    `当前限制：未用真实运营数据校准；部分参数是 T4 假设；提前离园和动作分布是` +
    `合成行为分布；本版 WAIT=${waitCount}（参见 validation_report.json）；` +
    `不能据此宣称真实景区预测准确率。\n`;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeJsonl(file, rows, kind) {
  const handle = fs.openSync(file, 'w');
  try {
    for (const row of rows) {
      const roles = kind === 'decision' ? projectDecisionRoles(row)
        : projectEnvironmentRoles(row);
      if (kind === 'environment') roles.FUTURE_TARGET = {
        ...roles.FUTURE_TARGET, availability: row.target_available };
      fs.writeSync(handle, JSON.stringify(roles) + '\n');
    }
  } finally { fs.closeSync(handle); }
}

function fileInfo(file) {
  return { bytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

async function verifyJsonl(file, kind, expectedCount) {
  let count = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file,
    { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    count += 1;
    if (row.METADATA?.source_tier !== 'T4' || row.METADATA?.synthetic !== true)
      throw new Error(`${kind} JSONL missing T4 provenance`);
    if (kind === 'decision') {
      if (!row.POLICY_INPUT || !row.TRANSITION_MODEL_INPUT || !row.TARGET
        || !row.AUDIT || Object.hasOwn(row.POLICY_INPUT, 'delta_t_min')
        || !row.POLICY_INPUT.legal_actions.some(item =>
          JSON.stringify(item.action) === JSON.stringify(row.ACTION_LABEL.chosen_action)))
        throw new Error('invalid decision JSONL role or chosen action');
    } else {
      if (!row.OBSERVED_INPUT || !row.LATENT_CURRENT || !row.FUTURE_TARGET
        || Object.hasOwn(row.OBSERVED_INPUT, 'environment_state'))
        throw new Error('invalid environment JSONL roles');
      for (const [key, offset] of Object.entries(HORIZONS)) {
        const target = row.FUTURE_TARGET[key];
        if (row.FUTURE_TARGET.availability[key] !== (target !== null)
          || target && (target.step_index !== row.METADATA.step_index + offset
            || toMillis(target.environment.timestamp)
              - toMillis(row.OBSERVED_INPUT.observation.timestamp) !== offset * 300000))
          throw new Error(`misaligned ${key} in environment JSONL`);
      }
    }
  }
  if (count !== expectedCount) throw new Error(`JSONL count mismatch: ${file}`);
  return count;
}

async function exportDatasetV01(outputDir = path.resolve(__dirname, '..', '..', 'dataset_v0.1'),
  { templateCount = SCENARIO_TEMPLATE_COUNT } = {}) {
  if (fs.existsSync(outputDir)) throw new Error(`output already exists: ${outputDir}`);
  const built = buildDatasetV01({ templateCount });
  const contentDigest = recordsDigest(built);
  const replay = buildDatasetV01({ templateCount });
  if (recordsDigest(replay) !== contentDigest)
    throw new Error('same-seed full dataset regeneration differs');
  const tempDir = fs.mkdtempSync(path.join(path.dirname(outputDir), '.dataset_v0.1.tmp-'));
  let published = false;
  try {
    for (const kind of ['decision', 'environment']) fs.mkdirSync(path.join(tempDir, kind));
    const fileStats = {};
    for (const kind of ['decision', 'environment']) for (const name of SPLITS) {
      const relative = `${kind}/${name}.jsonl`;
      const rows = built.split.splits[kind][name];
      const file = path.join(tempDir, relative);
      writeJsonl(file, rows, kind);
      fileStats[relative] = { ...fileInfo(file), sample_count: rows.length };
    }
    const first = built.decisionDataset.samples[0].metadata;
    const splitManifest = { ...built.split.manifest,
      episode_counts: Object.fromEntries(SPLITS.map(name => [name,
        built.split.manifest.groups[name].reduce((sum, group) => sum + group.episode_ids.length, 0)])),
      rollout_counts: Object.fromEntries(SPLITS.map(name => [name,
        built.split.manifest.groups[name].reduce((sum, group) => sum + group.rollout_ids.length, 0)])),
      leakage_check: built.split.leakage_check };
    const validationReport = { ...built.validation,
      missing_rate: built.missing,
      invalid_sample_count: 0, invalid_rate: 0, nan_inf_count: 0,
      queue_violation_count: 0, population_conservation_violation_count: 0,
      edge_occupancy_violation_count: 0,
      leakage_violation_count: built.split.leakage_check.errors.length,
      split_scenario_coverage: splitManifest.scenario_coverage,
      known_limitations: [
        'T4 synthetic assumptions are not calibrated against real park operations',
        'Early-exit and action distributions describe simulation behavior only',
        ...built.validation.warnings.map(warning => `validation warning: ${warning}`),
        ...SPLITS.flatMap(name => splitManifest.coverage_gaps[name]
          .map(gap => `${name} missing ${gap}`))
      ],
      same_seed_replay: { pass: true, sha256: contentDigest } };
    writeJson(path.join(tempDir, 'schema.json'), schemaDocument());
    writeJson(path.join(tempDir, 'split_manifest.json'), splitManifest);
    writeJson(path.join(tempDir, 'validation_report.json'), validationReport);
    fs.writeFileSync(path.join(tempDir, 'README.md'),
      readme(built.validation.behavior_coverage.action_counts.WAIT), 'utf8');
    const datasetManifest = { dataset_version: DATASET_VERSION,
      dataset_schema_version: DATASET_SCHEMA_VERSION, graph_version: first.graph_version,
      simulator_version: first.simulator_version, parameter_version: first.parameter_version,
      visitor_profile_version: first.visitor_profile_version,
      observation_version: first.observation_version, reward_version: first.reward_version,
      episode_schema_version: first.episode_schema_version,
      dataset_builder_version: DATASET_SCHEMA_VERSION, split_version: SPLIT_VERSION,
      source_tier: 'T4', synthetic: true,
      generation_time: new Date().toISOString(),
      generation_config: { scenario_templates: templateCount,
        scenario_seeds: GENERATION_SEEDS, split_seed: SPLIT_SEED,
        episodes_per_group: EPISODES_PER_GROUP, max_decisions: MAX_DECISIONS,
        environment_steps: ENVIRONMENT_STEPS },
      scenario_group_count: built.split.leakage_check.unique_groups,
      episode_count: built.decisionDataset.episode_summaries.length,
      decision_sample_count: built.decisionDataset.samples.length,
      environment_sample_count: built.environmentDataset.samples.length,
      split_counts: splitManifest.sample_counts, files: fileStats,
      same_seed_content_sha256: contentDigest,
      statement: '本数据集为仿真合成数据，用于世界模型 DataLoader、baseline 训练和接口联调，不代表万岁山真实运营观测。' };
    writeJson(path.join(tempDir, 'dataset_manifest.json'), datasetManifest);
    for (const kind of ['decision', 'environment'])
      await verifyJsonl(path.join(tempDir, kind, 'train.jsonl'), kind,
        splitManifest.sample_counts.train[kind]);
    if (fs.existsSync(outputDir)) throw new Error(`output appeared during export: ${outputDir}`);
    fs.renameSync(tempDir, outputDir);
    published = true;
    return { output_dir: outputDir, total_bytes: Object.values(fileStats)
      .reduce((sum, info) => sum + info.bytes, 0),
    manifest: datasetManifest, validation: validationReport, split: splitManifest };
  } finally {
    if (!published && fs.existsSync(tempDir)) {
      const resolvedTemp = path.resolve(tempDir);
      const resolvedParent = path.resolve(path.dirname(outputDir));
      if (path.dirname(resolvedTemp) !== resolvedParent
        || !path.basename(resolvedTemp).startsWith('.dataset_v0.1.tmp-'))
        throw new Error('refusing to remove an unexpected export temporary path');
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  const output = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  exportDatasetV01(output).then(result => {
    process.stdout.write(JSON.stringify({ output_dir: result.output_dir,
      scenario_group_count: result.manifest.scenario_group_count,
      episode_count: result.manifest.episode_count,
      decision_sample_count: result.manifest.decision_sample_count,
      environment_sample_count: result.manifest.environment_sample_count,
      split_counts: result.manifest.split_counts,
      horizon_coverage: result.validation.horizon_coverage,
      action_counts: result.validation.behavior_coverage.action_counts,
      early_exit_rate: result.validation.episode_statistics.early_exit_rate,
      coverage_gaps: result.split.coverage_gaps,
      leakage: result.split.leakage_check,
      file_stats: result.manifest.files }, null, 2) + '\n');
  }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}

module.exports = { DATASET_VERSION, scenarioTemplates, visitorProfileSpecs,
  buildDatasetV01, recordsDigest, schemaDocument, verifyJsonl, exportDatasetV01 };

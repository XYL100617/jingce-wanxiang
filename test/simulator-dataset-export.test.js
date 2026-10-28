'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { scenarioTemplates, schemaDocument, verifyJsonl, exportDatasetV01 } =
  require('../server/simulator/export-dataset');
const { generateDecisionDataset, generateEnvironmentRollout } =
  require('../server/simulator/dataset-builder');
const { projectDecisionRoles, projectEnvironmentRoles } =
  require('../server/simulator/dataset-contract');

function removeOwnedTemp(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith('jingce-jsonl-test-')
      && !path.basename(resolved).startsWith('jingce-export-test-'))
    throw new Error('unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('EX1 15 deterministic templates cover the requested scenario dimensions', () => {
  const first = scenarioTemplates();
  assert.deepEqual(first, scenarioTemplates());
  assert.equal(first.length, 15);
  const expected = {
    crowd_level: ['LOW', 'MEDIUM', 'HIGH'],
    calendar_type: ['WEEKDAY', 'WEEKEND'],
    weather: ['CLEAR', 'RAIN', 'HOT'],
    road_condition: ['NORMAL', 'LOCAL_CLOSURE'],
    event_condition: ['NORMAL_EVENT', 'EVENT_DELAY'],
    observation_quality: ['CLEAN', 'NOISY', 'MISSING', 'DELAYED', 'MIXED']
  };
  for (const [dimension, choices] of Object.entries(expected))
    assert.deepEqual(new Set(first.map(item => item.dimensions[dimension])),
      new Set(choices));
});

test('EX2 schema documents role, type, unit and missing encoding', () => {
  const schema = schemaDocument();
  assert.equal(schema.dataset_version, 'v0.1');
  for (const fields of Object.values(schema.fields)) for (const item of fields)
    assert.deepEqual(Object.keys(item), ['field_name', 'data_type', 'unit', 'nullable',
      'missing_encoding', 'role', 'description']);
  assert.ok(schema.fields.decision.find(item =>
    item.field_name === 'TRANSITION_MODEL_INPUT.delta_t_min'
      && item.role === 'TRANSITION INPUT'));
  assert.ok(schema.fields.environment.find(item =>
    item.field_name === 'LATENT_CURRENT.environment_state'
      && item.role === 'AUDIT/ORACLE ONLY'));
});

test('EX3 exported JSONL roles parse and preserve legal actions and horizons', async () => {
  const scene = scenarioTemplates(5)[0];
  const decision = generateDecisionDataset({ scenarioInstances: [scene],
    seeds: [42], episodes_per_scenario: 1, max_decisions: 4 });
  const environment = generateEnvironmentRollout({ scenarioInstances: [scene],
    seeds: [42], steps: 12 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingce-jsonl-test-'));
  try {
    const decisionFile = path.join(directory, 'decision.jsonl');
    const environmentFile = path.join(directory, 'environment.jsonl');
    const decisionRow = projectDecisionRoles(decision.samples[0]);
    const environmentRow = projectEnvironmentRoles(environment.samples[0]);
    environmentRow.FUTURE_TARGET = { ...environmentRow.FUTURE_TARGET,
      availability: environment.samples[0].target_available };
    fs.writeFileSync(decisionFile, JSON.stringify(decisionRow) + '\n');
    fs.writeFileSync(environmentFile, JSON.stringify(environmentRow) + '\n');
    assert.equal(await verifyJsonl(decisionFile, 'decision', 1), 1);
    assert.equal(await verifyJsonl(environmentFile, 'environment', 1), 1);
    assert.equal(decisionRow.POLICY_INPUT.delta_t_min, undefined);
    assert.equal(environmentRow.OBSERVED_INPUT.environment_state, undefined);
  } finally { removeOwnedTemp(directory); }
});

test('EX4 readback rejects a wrong manifest count', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingce-jsonl-test-'));
  try {
    const file = path.join(directory, 'empty.jsonl');
    fs.writeFileSync(file, '');
    await assert.rejects(verifyJsonl(file, 'decision', 1), /count mismatch/);
  } finally { removeOwnedTemp(directory); }
});

test('EX5 complete export creates six isolated JSONL files and matching metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingce-export-test-'));
  const output = path.join(directory, 'dataset_v0.1');
  try {
    const result = await exportDatasetV01(output, { templateCount: 5 });
    assert.equal(result.output_dir, output);
    const expected = ['README.md', 'schema.json', 'dataset_manifest.json',
      'split_manifest.json', 'validation_report.json',
      ...['decision', 'environment'].flatMap(kind =>
        ['train', 'val', 'test'].map(split => `${kind}/${split}.jsonl`))];
    for (const relative of expected) assert.ok(fs.statSync(path.join(output, relative)).isFile(),
      `missing ${relative}`);
    assert.equal(expected.length, 11);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'dataset_manifest.json'), 'utf8'));
    const split = JSON.parse(fs.readFileSync(path.join(output, 'split_manifest.json'), 'utf8'));
    const validation = JSON.parse(fs.readFileSync(path.join(output, 'validation_report.json'), 'utf8'));
    const schema = JSON.parse(fs.readFileSync(path.join(output, 'schema.json'), 'utf8'));
    assert.equal(manifest.generation_config.scenario_templates, 5);
    assert.equal(manifest.scenario_group_count, 15);
    assert.equal(schema.dataset_version, manifest.dataset_version);
    assert.equal(validation.valid, true);
    assert.equal(validation.same_seed_replay.pass, true);
    assert.equal(split.leakage_check.pass, true);
    for (const [relative, info] of Object.entries(manifest.files)) {
      const file = path.join(output, relative);
      assert.equal(fs.statSync(file).size, info.bytes);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        info.sha256);
      const [kind, filename] = relative.split('/');
      const splitName = filename.replace('.jsonl', '');
      assert.equal(info.sample_count, split.sample_counts[splitName][kind]);
      assert.equal(await verifyJsonl(file, kind, info.sample_count), info.sample_count);
      const allowedGroups = new Map(split.groups[splitName].map(group =>
        [group.group_id, group]));
      const lines = readline.createInterface({ input: fs.createReadStream(file,
        { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        const metadata = JSON.parse(line).METADATA;
        const group = allowedGroups.get(JSON.stringify([
          metadata.scenario_instance_id, metadata.seed]));
        assert.ok(group, `${relative} contains a group from another split`);
        assert.ok(kind === 'decision'
          ? group.episode_ids.includes(metadata.episode_id)
          : group.rollout_ids.includes(metadata.trajectory_id));
      }
    }
    assert.equal(Object.values(manifest.files).reduce((sum, info) =>
      sum + info.sample_count, 0),
    manifest.decision_sample_count + manifest.environment_sample_count);
    for (const kind of ['decision', 'environment']) {
      const ids = ['train', 'val', 'test'].map(name => new Set(split.groups[name]
        .map(group => group.group_id)));
      assert.ok(ids.every((set, index) => ids.every((other, otherIndex) =>
        index === otherIndex || [...set].every(id => !other.has(id)))));
      assert.ok(['train', 'val', 'test'].every(name =>
        fs.statSync(path.join(output, kind, `${name}.jsonl`)).size > 0));
    }
    await assert.rejects(exportDatasetV01(output, { templateCount: 5 }),
      /output already exists/);
    assert.equal(fs.readdirSync(directory).filter(name =>
      name.startsWith('.dataset_v0.1.tmp-')).length, 0);
  } finally { removeOwnedTemp(directory); }
});

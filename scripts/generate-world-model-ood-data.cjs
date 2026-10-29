'use strict';

// Generate an isolated, Map1-aligned T4 stress dataset with scenario-template
// holdout. B's simulator directory is an explicit input until its branch is
// integrated; output must be a new directory and is never overwritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const simulatorRoot = path.resolve(process.argv[2] || '');
const outputRoot = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('usage: node scripts/generate-world-model-ood-data.cjs <B-repo-root> <new-output-directory>');
}
if (!fs.existsSync(path.join(simulatorRoot, 'server', 'simulator', 'dataset-builder.js')))
  throw new Error('B simulator source not found');
if (fs.existsSync(outputRoot)) throw new Error(`refusing to overwrite existing output: ${outputRoot}`);

const { sampleScenario } = require(path.join(simulatorRoot, 'server', 'simulator', 'scenario-sampler.js'));
const { generateEnvironmentRollout } = require(path.join(simulatorRoot, 'server', 'simulator', 'dataset-builder.js'));
const currentGraph = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'data', 'scenic_graph.json'), 'utf8'));
const sourceGraph = JSON.parse(fs.readFileSync(path.join(simulatorRoot, 'server', 'data', 'scenic_graph.json'), 'utf8'));
const topology = graph => JSON.stringify({
  nodes: graph.nodes.map(node => [node.node_id, node.poi_id || null]).sort((a, b) => a[0].localeCompare(b[0])),
  edges: graph.edges.map(edge => [edge.edge_id, edge.from_node_id, edge.to_node_id]).sort((a, b) => a[0].localeCompare(b[0]))
});
if (topology(currentGraph) !== topology(sourceGraph))
  throw new Error('B simulator Map1 node/POI/edge topology differs from current project; dataset export refused');

const dims = (crowd_level, calendar_type, weather, visitor_speed_distribution,
  dwell_distribution, road_condition, event_condition, observation_quality) => ({
  crowd_level, calendar_type, weather, visitor_speed_distribution,
  dwell_distribution, road_condition, event_condition, observation_quality
});
const templateGroups = [
  { split: 'train', index: 1, d: dims('LOW','WEEKDAY','CLEAR','FASTER','SHORT','NORMAL','NORMAL_EVENT','CLEAN') },
  { split: 'train', index: 2, d: dims('MEDIUM','WEEKDAY','RAIN','SLOWER','NORMAL','NORMAL','EVENT_DELAY','NOISY') },
  { split: 'train', index: 3, d: dims('HIGH','WEEKEND','CLEAR','NORMAL','LONG','LOCAL_CLOSURE','EVENT_DELAY','MIXED') },
  { split: 'train', index: 4, d: dims('MEDIUM','WEEKEND','HOT','MIXED','SHORT','NORMAL','NORMAL_EVENT','MISSING') },
  { split: 'train', index: 5, d: dims('LOW','WEEKEND','RAIN','FASTER','LONG','LOCAL_CLOSURE','NORMAL_EVENT','DELAYED') },
  { split: 'train', index: 6, d: dims('HIGH','WEEKDAY','HOT','SLOWER','SHORT','LOCAL_CLOSURE','EVENT_DELAY','DELAYED') },
  { split: 'train', index: 7, d: dims('MEDIUM','WEEKDAY','CLEAR','MIXED','LONG','LOCAL_CLOSURE','NORMAL_EVENT','NOISY') },
  { split: 'train', index: 8, d: dims('HIGH','WEEKEND','RAIN','NORMAL','SHORT','LOCAL_CLOSURE','NORMAL_EVENT','CLEAN') },
  { split: 'val', index: 9, d: dims('MEDIUM','WEEKEND','RAIN','MIXED','LONG','LOCAL_CLOSURE','EVENT_DELAY','DELAYED') },
  { split: 'val', index: 10, d: dims('LOW','WEEKDAY','HOT','SLOWER','SHORT','LOCAL_CLOSURE','EVENT_DELAY','MIXED') },
  { split: 'test', index: 11, d: dims('HIGH','WEEKDAY','RAIN','MIXED','LONG','LOCAL_CLOSURE','EVENT_DELAY','MISSING') },
  { split: 'test', index: 12, d: dims('LOW','WEEKEND','CLEAR','SLOWER','NORMAL','NORMAL','EVENT_DELAY','NOISY') }
];
const seeds = [701, 702, 703];
const rows = { train: [], val: [], test: [] };
const groupIds = { train: [], val: [], test: [] };

for (const group of templateGroups) for (const seed of seeds) {
  const scenario = sampleScenario({ scenario_family: 'WM_DOMAIN_OOD_V1', seed,
    index: group.index, dimensions: group.d });
  const result = generateEnvironmentRollout({ scenarioInstances: [scenario], seeds: [seed], steps: 36 });
  rows[group.split].push(...result.samples.map(row => {
    const observation = { ...row.observed_input.observation,
      simulator_version: row.metadata.simulator_version };
    return {
    OBSERVED_INPUT: { observation },
    LATENT_CURRENT: row.latent_current,
    FUTURE_TARGET: { ...row.future_target, availability: row.target_available },
    AUDIT: row.audit,
    METADATA: row.metadata
  }; }));
  groupIds[group.split].push({ scenario_instance_id: scenario.scenario_instance_id,
    seed, template_index: group.index, dimensions: group.d });
  process.stdout.write(`${group.split} template ${group.index} seed ${seed}: ${result.samples.length} rows\n`);
}

function writeJson(file, object) {
  fs.writeFileSync(file, `${JSON.stringify(object, null, 2)}\n`, 'utf8');
}
function writeSplit(split) {
  const directory = path.join(outputRoot, 'environment');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${split}.jsonl`);
  const body = rows[split].map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(file, body, 'utf8');
  return { samples: rows[split].length, bytes: Buffer.byteLength(body),
    sha256: crypto.createHash('sha256').update(body).digest('hex') };
}
fs.mkdirSync(outputRoot, { recursive: false });
const files = Object.fromEntries(['train','val','test'].map(split =>
  [`environment/${split}.jsonl`, writeSplit(split)]));
const manifest = {
  dataset_version: 'map1-domain-randomized-ood-v0.1',
  source_tier: 'T4', synthetic: true, graph_version: '1.0',
  simulator_version: rows.train[0]?.METADATA.simulator_version,
  graph_topology_sha256: crypto.createHash('sha256').update(topology(currentGraph)).digest('hex'),
  schedule_source: 'B simulator program reference; event identity/map1 match only; randomized synthetic windows',
  groups: groupIds, group_counts: Object.fromEntries(Object.entries(groupIds).map(([k,v]) => [k,v.length])),
  split_policy: 'Hold out complete scenario templates: train 1-8, validation 9-10, test 11-12; each template has 3 independent seeds; no template or seed group crosses splits.',
  steps_per_trajectory: 36, step_minutes: 5, files,
  limitation: 'All crowd, queue, event dynamics and schedule windows are simulator-generated T4 assumptions; this is a stress/generalization experiment, not real-world calibration.'
};
writeJson(path.join(outputRoot, 'dataset_manifest.json'), manifest);
writeJson(path.join(outputRoot, 'split_manifest.json'), { group_ids: groupIds, leakage_check: {
  pass: new Set(Object.values(groupIds).flat().map(group => group.scenario_instance_id)).size === 36,
  group_count: 36, split_template_indexes: { train: [1,2,3,4,5,6,7,8], val: [9,10], test: [11,12] }
}});
writeJson(path.join(outputRoot, 'scenario-templates.json'), templateGroups);
process.stdout.write(`${JSON.stringify({ output: outputRoot, group_counts: manifest.group_counts, files }, null, 2)}\n`);

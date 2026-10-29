'use strict';

// Simulation-only two-stage POI count experiment. The first model estimates
// whether a queue is non-zero; the second estimates count conditional on a
// non-zero target. Hyperparameters are selected on validation MAE only.
const fs = require('node:fs');
const path = require('node:path');
const trainer = require('./train-graph-temporal-world-model');
const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.argv[2] || process.env.WORLD_MODEL_DATASET_DIR ||
  'D:/jingxing/b-data-governance-v1-inspect/dataset_schedule_events_v0.3c/environment');
const reportPath = path.resolve(process.argv[3] || path.join(root, 'server/world-model/poi-hurdle-report-v0.1.json'));
const modelPath = path.join(root, 'server/world-model/graph-temporal-v0.5-stratified.json');
const lambdaGrid = [10, 30, 100, 300];
const positiveLambdaGrid = [0.1, 1, 10, 100];

async function readSplit(name) {
  const rows = [];
  const input = path.join(dataDir, `${name}.jsonl`);
  if (!fs.existsSync(input)) throw new Error(`Missing ${input}; provide the dataset environment directory as argv[2].`);
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line));
  const byTrajectory = new Map();
  for (const row of rows) {
    const id = row.METADATA.trajectory_id;
    if (!byTrajectory.has(id)) byTrajectory.set(id, []);
    byTrajectory.get(id).push(row);
  }
  for (const trajectory of byTrajectory.values()) {
    trajectory.sort((a, b) => a.METADATA.step_index - b.METADATA.step_index);
    for (let i = 0; i < trajectory.length; i++) rowHistory(trajectory[i], trajectory, i);
  }
  return rows;
}
function rowHistory(row, trajectory, i) { row.__history = trajectory.slice(Math.max(0, i - 2), i); }

function evaluate(rows, horizon, classifiers, positiveModels, directModels) {
  const totals = { hurdle: { n: 0, abs: 0, sq: 0 }, direct: { n: 0, abs: 0, sq: 0 }, zero: { n: 0, abs: 0, sq: 0 } };
  for (const row of rows) for (const id of trainer.poiIds) {
    const y = trainer.target(row, 'poi', id, horizon);
    if (!Number.isFinite(y)) continue;
    const features = trainer.poiFeatures(row, id, horizon);
    const p = trainer.predictNonzero(classifiers[id], features);
    const positiveMean = trainer.predict(positiveModels[id], features);
    const expected = Math.max(0, p * Math.max(0, positiveMean));
    const direct = Math.max(0, trainer.predict(directModels[id], features));
    for (const [name, prediction] of [['hurdle', expected], ['direct', direct], ['zero', 0]]) {
      const error = prediction - y;
      totals[name].n++;
      totals[name].abs += Math.abs(error);
      totals[name].sq += error * error;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, {
    n: value.n, mae: value.abs / value.n, rmse: Math.sqrt(value.sq / value.n)
  }]));
}

async function main() {
  const split = Object.fromEntries(await Promise.all(['train', 'val', 'test'].map(async name => [name, await readSplit(name)])));
  const reference = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const metrics = {};
  for (const horizon of trainer.horizons) {
    let best = null;
    for (const classifierLambda of lambdaGrid) for (const positiveLambda of positiveLambdaGrid) {
      const classifiers = {}, positiveModels = {};
      for (const id of trainer.poiIds) {
        classifiers[id] = trainer.fitNonzero(split.train, id, horizon, classifierLambda);
        const positiveRows = split.train.filter(row => {
          const y = trainer.target(row, 'poi', id, horizon);
          return Number.isFinite(y) && y > 0;
        });
        positiveModels[id] = trainer.fit(positiveRows, 'poi', id, horizon, trainer.poiFeatures, positiveLambda);
      }
      const validation = evaluate(split.val, horizon, classifiers, positiveModels, reference.models.poi[horizon]);
      const candidate = { classifier_lambda: classifierLambda, positive_count_lambda: positiveLambda,
        classifiers, positiveModels, validation };
      if (!best || validation.hurdle.mae < best.validation.hurdle.mae) best = candidate;
    }
    metrics[horizon] = {
      selected_on_validation: { classifier_lambda: best.classifier_lambda, positive_count_lambda: best.positive_count_lambda },
      validation: best.validation,
      test: evaluate(split.test, horizon, best.classifiers, best.positiveModels, reference.models.poi[horizon])
    };
  }
  const result = {
    experiment: 'zero-inflated two-stage POI queue count',
    model_version: 'synthetic-world-model-poi-hurdle-v0.1',
    dataset_version: 'schedule-enriched-poi-events-v0.3c-stratified',
    source_tier: 'T4', synthetic: true,
    selection_policy: 'classifier and conditional-count regularization selected by validation MAE; test split used once after selection',
    split_samples: Object.fromEntries(Object.entries(split).map(([name, rows]) => [name, rows.length])),
    metrics,
    limitations: ['Synthetic simulator labels only; no real crowd calibration.',
      'This is an offline comparison and is not used by runtime or route planning.',
      'The expected count combines two fitted stages and may be poorly calibrated under distribution shift.']
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath, metrics }, null, 2)}\n`);
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { evaluate };

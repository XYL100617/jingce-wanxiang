'use strict';

// Train a local, observation-driven POI forecaster. Input must be real,
// permissioned park observations; synthetic rows are rejected by design.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const graph = require('../server/data/scenic_graph.json');

const GRAPH_VERSION = '1.0';
const GRAPH_FINGERPRINT = crypto.createHash('sha256').update(JSON.stringify({
  nodes: graph.nodes.map(node => node.node_id).sort(),
  poi_bindings: graph.nodes.filter(node => node.poi_id).map(node => [node.node_id, node.poi_id]).sort((a, b) => a[0].localeCompare(b[0])),
  edges: graph.edges.map(edge => [edge.edge_id, edge.from_node_id, edge.to_node_id]).sort((a, b) => a[0].localeCompare(b[0]))
})).digest('hex');
// Matches the existing 10-minute EnvironmentForecast sampling grid.
const HORIZONS = [10, 20, 30, 60];
const LAMBDAS = [0.01, 0.1, 1, 10, 100];
const POIS = graph.nodes.filter(node => node.poi_id).map(node => node.poi_id).sort();
const NODE_BY_POI = new Map(graph.nodes.filter(node => node.poi_id).map(node => [node.poi_id, node.node_id]));
const NEIGHBORS = new Map(graph.nodes.map(node => [node.node_id, new Set()]));
for (const edge of graph.edges) {
  NEIGHBORS.get(edge.from_node_id)?.add(edge.to_node_id);
  NEIGHBORS.get(edge.to_node_id)?.add(edge.from_node_id);
}
const ADJACENT_POIS = new Map(POIS.map(poi => [poi,
  [...(NEIGHBORS.get(NODE_BY_POI.get(poi)) || [])]
    .map(nodeId => graph.nodes.find(node => node.node_id === nodeId)?.poi_id).filter(Boolean)]));

function localDateTime(timestamp) {
  const match = timestamp.match(/(Z|([+-])(\d{2}):?(\d{2}))$/i);
  const offsetMin = !match || match[1].toUpperCase() === 'Z' ? 0
    : (match[2] === '+' ? 1 : -1) * (Number(match[3]) * 60 + Number(match[4]));
  return new Date(Date.parse(timestamp) + offsetMin * 60000);
}
function localDateKey(timestamp) { return localDateTime(timestamp).toISOString().slice(0, 10); }

function validateObservation(row, lineNo = '?') {
  const fail = message => { throw new Error(`line ${lineNo}: ${message}`); };
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('row must be an object');
  if (row.source_tier !== 'REAL' || row.synthetic !== false) fail('only source_tier=REAL and synthetic=false rows are accepted');
  if (row.graph_version !== GRAPH_VERSION) fail(`graph_version must be ${GRAPH_VERSION}`);
  if (row.graph_fingerprint !== GRAPH_FINGERPRINT) fail('graph_fingerprint does not match the current Map 1 node/edge topology');
  if (!['manual_queue_measurement', 'official_wait_time', 'sensor_count'].includes(row.source_kind)) fail('source_kind must identify the real measurement method');
  if (typeof row.source_id !== 'string' || !row.source_id.trim()) fail('source_id is required for provenance');
  if (row.authorized_for_modeling !== true) fail('authorized_for_modeling must be true');
  if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(row.timestamp))
    fail('timestamp must be ISO-8601 with timezone');
  if (!row.poi_states || typeof row.poi_states !== 'object' || Array.isArray(row.poi_states)) fail('poi_states is required');
  for (const [id, value] of Object.entries(row.poi_states)) {
    if (!POIS.includes(id)) fail(`unknown POI id ${id}`);
    if (!value || typeof value !== 'object') fail(`poi_states.${id} must be an object`);
    for (const key of ['queue_min', 'crowd_ratio']) {
      if (value[key] != null && (!Number.isFinite(value[key]) || value[key] < 0 || (key === 'crowd_ratio' && value[key] > 1)))
        fail(`poi_states.${id}.${key} is out of range`);
    }
    if (value.open != null && typeof value.open !== 'boolean') fail(`poi_states.${id}.open must be boolean`);
  }
  if (row.weather != null && typeof row.weather !== 'object') fail('weather must be an object');
  if (row.events != null && (!Array.isArray(row.events) || row.events.some(event => !event || typeof event !== 'object')))
    fail('events must be an array of known schedule/event objects');
}

async function readObservations(filePath) {
  const rows = [], seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`line ${lineNo}: invalid JSON`); }
    validateObservation(row, lineNo);
    const time = Date.parse(row.timestamp);
    if (seen.has(time)) throw new Error(`line ${lineNo}: duplicate timestamp ${row.timestamp}`);
    seen.add(time); rows.push(row);
  }
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (rows.length < 20) throw new Error(`need at least 20 real snapshots; found ${rows.length}`);
  return rows;
}

function dateBuckets(rows) {
  const dates = [...new Set(rows.map(row => localDateKey(row.timestamp)))].sort();
  if (dates.length < 14) throw new Error(`need at least 14 distinct observation dates; found ${dates.length}`);
  const trainEnd = Math.max(1, Math.floor(dates.length * 0.6));
  const valEnd = Math.max(trainEnd + 1, Math.floor(dates.length * 0.8));
  const splitByDate = new Map(dates.map((date, index) => [date, index < trainEnd ? 'train' : index < valEnd ? 'val' : 'test']));
  return { dates, splitByDate };
}

function eventsFor(row, poiId, horizon) {
  const nodeId = NODE_BY_POI.get(poiId), now = Date.parse(row.timestamp), future = now + horizon * 60000;
  let active = 0, upcoming = 0;
  for (const event of row.events || []) {
    if (event.node_id !== nodeId && event.poi_id !== poiId) continue;
    const start = Date.parse(event.start_time || event.timestamp || '');
    const end = Date.parse(event.end_time || '');
    if (Number.isFinite(start) && Number.isFinite(end) && start <= future && future < end) active += 1;
    else if (Number.isFinite(start) && start >= now && start <= future) upcoming += 1;
  }
  return [active, upcoming];
}

function features(row, poiId, horizon) {
  const state = row.poi_states[poiId] || {};
  const date = localDateTime(row.timestamp), hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const dayAngle = 2 * Math.PI * date.getUTCDay() / 7, hourAngle = 2 * Math.PI * hour / 24;
  const q = state.queue_min, c = state.crowd_ratio;
  const adjacent = (ADJACENT_POIS.get(poiId) || []).map(id => row.poi_states[id]?.queue_min).filter(Number.isFinite);
  const neighborMean = adjacent.length ? adjacent.reduce((a, b) => a + b, 0) / adjacent.length : 0;
  const [eventActive, eventUpcoming] = eventsFor(row, poiId, horizon);
  const weather = row.weather || {};
  return [q ?? 0, q == null ? 1 : 0, c ?? 0, c == null ? 1 : 0, neighborMean, hourAngle ? Math.sin(hourAngle) : 0,
    Math.cos(hourAngle), Math.sin(dayAngle), Math.cos(dayAngle), Number(state.open === false),
    eventActive, eventUpcoming, Number(weather.rain_mm || 0), Number(weather.temperature_c || 0)];
}

function solve(matrix, vector) {
  const n = vector.length, a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) continue;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let k = col; k <= n; k++) a[col][k] /= scale;
    for (let row = 0; row < n; row++) if (row !== col) {
      const factor = a[row][col];
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map(row => row[n]);
}

function fit(samples, lambda) {
  if (!samples.length) return null;
  const d = samples[0].x.length, means = Array(d).fill(0), scales = Array(d).fill(0);
  for (const sample of samples) for (let i = 0; i < d; i++) means[i] += sample.x[i] / samples.length;
  for (const sample of samples) for (let i = 0; i < d; i++) scales[i] += (sample.x[i] - means[i]) ** 2 / samples.length;
  for (let i = 0; i < d; i++) scales[i] = Math.sqrt(scales[i]) || 1;
  const size = d + 1, gram = Array.from({ length: size }, () => Array(size).fill(0)), rhs = Array(size).fill(0);
  for (const sample of samples) {
    const v = [1, ...sample.x.map((value, i) => (value - means[i]) / scales[i])];
    for (let i = 0; i < size; i++) {
      rhs[i] += v[i] * sample.y;
      for (let j = 0; j < size; j++) gram[i][j] += v[i] * v[j];
    }
  }
  for (let i = 1; i < size; i++) gram[i][i] += lambda;
  return { means, scales, coefficients: solve(gram, rhs), sample_count: samples.length, regularization: lambda };
}
function predict(model, x) {
  if (!model) return null;
  return [1, ...x.map((value, i) => (value - model.means[i]) / model.scales[i])]
    .reduce((sum, value, i) => sum + value * model.coefficients[i], 0);
}

function makePairs(rows, splits, poiId, horizon, targetField) {
  const times = rows.map(row => Date.parse(row.timestamp)), maxGapMs = 3 * 60000;
  const samples = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], date = localDateKey(row.timestamp), split = splits.get(date);
    const value = row.poi_states[poiId]?.[targetField];
    if (!split || !Number.isFinite(value)) continue;
    const targetTime = times[i] + horizon * 60000;
    let best = -1, bestGap = Infinity;
    for (let j = i + 1; j < rows.length && times[j] <= targetTime + maxGapMs; j++) {
      const gap = Math.abs(times[j] - targetTime);
      if (gap < bestGap) { best = j; bestGap = gap; }
    }
    if (best < 0 || bestGap > maxGapMs) continue;
    const targetDate = localDateKey(rows[best].timestamp);
    if (splits.get(targetDate) !== split) continue;
    const y = rows[best].poi_states[poiId]?.[targetField];
    if (!Number.isFinite(y)) continue;
    samples.push({ split, x: features(row, poiId, horizon), y,
      baseline: value, date });
  }
  return samples;
}

function metrics(samples, model) {
  const errors = samples.map(sample => {
    const prediction = Math.max(0, predict(model, sample.x));
    return { error: prediction - sample.y, baseError: sample.baseline - sample.y };
  });
  if (!errors.length) return { n: 0, mae: null, persistence_mae: null, rmse: null };
  return { n: errors.length,
    mae: errors.reduce((sum, item) => sum + Math.abs(item.error), 0) / errors.length,
    persistence_mae: errors.reduce((sum, item) => sum + Math.abs(item.baseError), 0) / errors.length,
    rmse: Math.sqrt(errors.reduce((sum, item) => sum + item.error ** 2, 0) / errors.length) };
}

async function train(rows) {
  const { dates, splitByDate } = dateBuckets(rows), output = {};
  const fields = ['queue_min', 'crowd_ratio'];
  for (const field of fields) {
    output[field] = {};
    for (const horizon of HORIZONS) {
      const models = {}, poiMetrics = {};
      let allVal = [], allTest = [], allPersistTest = [];
      for (const poiId of POIS) {
        const pairs = makePairs(rows, splitByDate, poiId, horizon, field);
        const trainSamples = pairs.filter(item => item.split === 'train');
        const valSamples = pairs.filter(item => item.split === 'val');
        const testSamples = pairs.filter(item => item.split === 'test');
        if (trainSamples.length < 50 || valSamples.length < 10 || testSamples.length < 10) continue;
        let best = null;
        for (const lambda of LAMBDAS) {
          const candidate = fit(trainSamples, lambda), result = metrics(valSamples, candidate);
          if (!best || result.mae < best.validation.mae) best = { lambda, candidate, validation: result };
        }
        const finalModel = fit([...trainSamples, ...valSamples], best.lambda);
        const test = metrics(testSamples, finalModel);
        models[poiId] = finalModel;
        poiMetrics[poiId] = { train_n: trainSamples.length, validation_n: valSamples.length, test_n: testSamples.length,
          lambda: best.lambda, validation: best.validation, test };
        allVal = allVal.concat(valSamples.map(item => ({ ...item, predicted: Math.max(0, predict(best.candidate, item.x)) })));
        allTest = allTest.concat(testSamples.map(item => ({ ...item, predicted: Math.max(0, predict(finalModel, item.x)) })));
      }
      const aggregate = items => {
        if (!items.length) return { n: 0, mae: null, persistence_mae: null, rmse: null };
        return { n: items.length,
          mae: items.reduce((s, r) => s + Math.abs(r.predicted - r.y), 0) / items.length,
          persistence_mae: items.reduce((s, r) => s + Math.abs(r.baseline - r.y), 0) / items.length,
          rmse: Math.sqrt(items.reduce((s, r) => s + (r.predicted - r.y) ** 2, 0) / items.length) };
      };
      output[field][horizon] = { models, validation: aggregate(allVal), test: aggregate(allTest), poi_metrics: poiMetrics };
    }
  }
  const eligible = fields.every(field => HORIZONS.every(h => {
    const metric = output[field][h].test;
    return metric.n >= 100 && metric.mae <= metric.persistence_mae * 0.95;
  }));
  return { dates, output, eligible };
}

async function main() {
  const inputArg = process.argv[2] || process.env.REAL_POI_OBSERVATIONS;
  const input = inputArg ? path.resolve(inputArg) : '';
  const artifactPath = path.resolve(process.argv[3] || path.join(__dirname, '..', 'server/world-model/real-poi-model.json'));
  if (!input || !fs.existsSync(input)) throw new Error('usage: node scripts/train-local-real-poi-model.js <permissioned-observations.jsonl> [model-output.json]');
  const rows = await readObservations(input), result = await train(rows);
  const artifact = { model_type: 'per-POI multi-horizon ridge with graph-neighbor context', model_version: 'wansui-real-poi-v0.1',
    source_tier: 'REAL', synthetic: false, graph_version: GRAPH_VERSION, graph_fingerprint: GRAPH_FINGERPRINT,
    graph_contract: { node_ids: graph.nodes.map(node => node.node_id).sort(), poi_ids: POIS,
      edges: graph.edges.map(edge => [edge.edge_id, edge.from_node_id, edge.to_node_id]).sort((a, b) => a[0].localeCompare(b[0])) },
    trained_at: new Date().toISOString(), observation_dates: result.dates, snapshot_count: rows.length,
    split: 'chronological 60/20/20 by date; target pairs crossing split boundaries are discarded',
    feature_policy: 'current and lagged queue/crowd, one-hop neighboring queues, local time/day cycle, open flag, known event window and weather; future labels and simulator latent state excluded',
    horizons_min: HORIZONS, metrics: result.output, eligible_for_planning: result.eligible,
    eligibility_rule: 'each target and horizon must have at least 100 held-out pairs and >=5% MAE improvement over persistence',
    limitations: result.eligible ? ['Real observation data only covers supplied dates, POIs and operating conditions; monitor drift and keep fallback enabled.']
      : ['Held-out performance did not meet the activation gate. Keep rule forecast active.', 'This dataset is observational and local; estimates outside covered conditions are unsupported.'] };
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, 'utf8');
  const summaryMetrics = Object.fromEntries(Object.entries(result.output).map(([field, horizons]) =>
    [field, Object.fromEntries(HORIZONS.map(horizon => [horizon, horizons[horizon].test]))]));
  process.stdout.write(`${JSON.stringify({ artifact: artifactPath, dates: result.dates.length, snapshots: rows.length,
    eligible_for_planning: result.eligible, metrics: summaryMetrics }, null, 2)}\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateObservation, dateBuckets, features, fit, predict, makePairs, train, HORIZONS, POIS, GRAPH_VERSION, GRAPH_FINGERPRINT };

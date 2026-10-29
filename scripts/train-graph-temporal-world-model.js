'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
// Freeze the graph snapshot used to create the training data and coefficients.
const graph = require('../server/world-model/training-graph-v0.2.json');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.argv[2] || process.env.WORLD_MODEL_DATASET_DIR || path.join(root, 'dataset_schedule_v0.2-fixed', 'environment'));
const output = path.resolve(process.argv[3] || process.env.WORLD_MODEL_OUTPUT || path.join(root, 'server', 'world-model', 'graph-temporal-v0.3.json'));
const modelVersion = process.env.WORLD_MODEL_VERSION || 'synthetic-world-model-v0.3';
const datasetVersion = process.env.WORLD_MODEL_DATASET_VERSION || 'schedule-enriched-v0.2-fixed';
const simulatorVersion = process.env.WORLD_MODEL_SIMULATOR_VERSION || 'sim-dr-p1.1+program-schedule-randomization';
const reportPath = path.resolve(process.env.WORLD_MODEL_REPORT || path.join(path.dirname(output),
  path.basename(output).replace(/^graph-temporal-/, 'graph-temporal-report-').replace(/\.json$/, '.json')));
const horizons = ['target_5', 'target_15', 'target_30', 'target_60'];
const poiIds = graph.nodes.filter(node => node.poi_id).map(node => node.poi_id).sort();
const edgeById = new Map(graph.edges.map(edge => [edge.edge_id, edge]));
const nodeById = new Map(graph.nodes.map(node => [node.node_id, node]));

function adjacency() {
  const result = new Map(graph.nodes.map(node => [node.node_id, new Set()]));
  for (const edge of graph.edges) {
    result.get(edge.from_node_id)?.add(edge.to_node_id);
    result.get(edge.to_node_id)?.add(edge.from_node_id);
  }
  return result;
}
const neighbors = adjacency();
const incidentEdges = new Map(graph.nodes.map(node => [node.node_id, []]));
for (const edge of graph.edges) {
  incidentEdges.get(edge.from_node_id).push(edge);
  incidentEdges.get(edge.to_node_id).push(edge);
}
const adjacentEdges = new Map(graph.edges.map(edge => [edge.edge_id, new Set()]));
for (const edge of graph.edges) {
  for (const nodeId of [edge.from_node_id, edge.to_node_id])
    for (const other of incidentEdges.get(nodeId)) if (other.edge_id !== edge.edge_id)
      adjacentEdges.get(edge.edge_id).add(other.edge_id);
}

async function readSplit(name) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dataDir, `${name}.jsonl`)), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line));
  const byTrajectory = new Map();
  for (const row of rows) {
    const id = row.METADATA.trajectory_id;
    if (!byTrajectory.has(id)) byTrajectory.set(id, []);
    byTrajectory.get(id).push(row);
  }
  for (const trajectory of byTrajectory.values()) {
    trajectory.sort((a, b) => a.METADATA.step_index - b.METADATA.step_index);
    for (let i = 0; i < trajectory.length; i++) trajectory[i].__history = trajectory.slice(Math.max(0, i - 2), i);
  }
  return rows;
}

function queue(observation, poiId) {
  const value = observation?.pois?.[poiId]?.queue_count;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function roadRatio(observation, edgeId) {
  const edge = edgeById.get(edgeId), value = observation?.roads?.[edgeId]?.travel_time_min;
  return edge && Number.isFinite(value) && edge.base_travel_time_min > 0
    ? value / edge.base_travel_time_min : null;
}
function eventLoad(observation, targetNodeIds = null) {
  let total = 0;
  for (const event of Object.values(observation?.events || {})) {
    const distanceWeight = !targetNodeIds ? 1 : event.node_id === targetNodeIds[0] ? 1
      : targetNodeIds.slice(1).includes(event.node_id) ? 0.5 : 0;
    if (!distanceWeight) continue;
    const queueCount = Number.isFinite(event.event_queue_count) ? event.event_queue_count : 0;
    const attending = Number.isFinite(event.attending_count) ? event.attending_count : 0;
    total += distanceWeight * (queueCount + attending);
  }
  return total;
}
function localEventCountdown(observation, targetNodeIds) {
  const now = Date.parse(String(observation?.timestamp || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(now)) return 0;
  let result = 0;
  for (const event of Object.values(observation.events || {})) {
    const weight = event.node_id === targetNodeIds[0] ? 1
      : targetNodeIds.slice(1).includes(event.node_id) ? 0.5 : 0;
    const start = Date.parse(String(event.start_time || '').replace(' ', 'T') + 'Z');
    if (!weight || !Number.isFinite(start)) continue;
    const distanceMin = Math.abs(start - now) / 60000;
    if (distanceMin <= 120) result += weight * (1 - distanceMin / 120);
  }
  return result;
}
function timeFeatures(observation) {
  const date = new Date(Date.parse(String(observation?.timestamp || '').replace(' ', 'T') + 'Z'));
  const hour = Number.isFinite(date.getTime()) ? date.getUTCHours() + date.getUTCMinutes() / 60 : 12;
  const angle = 2 * Math.PI * hour / 24;
  return [Math.sin(angle), Math.cos(angle)];
}
function weatherFeatures(observation) {
  const category = observation?.weather?.category;
  return [category === 'RAIN' ? 1 : 0, category === 'HOT' ? 1 : 0];
}
function historyFeature(row, id, field, edge = false) {
  const history = row.__history || [];
  const values = history.map(item => edge ? roadRatio(item.OBSERVED_INPUT.observation, id)
    : queue(item.OBSERVED_INPUT.observation, id)).filter(Number.isFinite);
  return values.length ? values.at(-1) : null;
}
function scheduledEventWindowLoad(observation, targetOffsetMin, targetNodeIds) {
  const now = Date.parse(String(observation?.timestamp || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(now)) return 0;
  const targetTime = now + targetOffsetMin * 60000;
  let total = 0;
  for (const event of Object.values(observation.events || {})) {
    const weight = event.node_id === targetNodeIds[0] ? 1
      : targetNodeIds.slice(1).includes(event.node_id) ? 0.5 : 0;
    const board = Date.parse(String(event.boarding_open_time || event.start_time || '').replace(' ', 'T') + 'Z');
    const end = Date.parse(String(event.end_time || '').replace(' ', 'T') + 'Z');
    if (!weight || !Number.isFinite(board) || !Number.isFinite(end) || targetTime < board || targetTime > end || event.cancelled === true) continue;
    const capacity = Number.isFinite(event.capacity) ? event.capacity
      : (Number.isFinite(event.attending_count) ? event.attending_count : 0) + (Number.isFinite(event.event_queue_count) ? event.event_queue_count : 0);
    total += weight * capacity;
  }
  return total;
}
function poiFeatures(row, poiId, horizon = 'target_5') {
  const observation = row.OBSERVED_INPUT.observation;
  const node = graph.nodes.find(item => item.poi_id === poiId);
  const adjacentNodeIds = [...(neighbors.get(node.node_id) || [])];
  const adjacentPois = adjacentNodeIds.map(id => nodeById.get(id)?.poi_id).filter(Boolean);
  const own = queue(observation, poiId);
  const neighborValues = adjacentPois.map(id => queue(observation, id)).filter(Number.isFinite);
  const roads = incidentEdges.get(node.node_id) || [];
  const ratios = roads.map(edge => roadRatio(observation, edge.edge_id)).filter(Number.isFinite);
  const closed = roads.filter(edge => observation.roads?.[edge.edge_id]?.is_open === false).length;
  const localNodes = [node.node_id, ...adjacentNodeIds];
  const targetOffsetMin = Number(String(horizon).replace('target_', '')) || 5;
  const [hourSin, hourCos] = timeFeatures(observation);
  const [rain, hot] = weatherFeatures(observation);
  return [own ?? 0, own === null ? 1 : 0,
    neighborValues.length ? neighborValues.reduce((a, b) => a + b, 0) / neighborValues.length : 0,
    ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1,
    roads.length ? closed / roads.length : 0,
    eventLoad(observation, localNodes), eventLoad(observation),
    localEventCountdown(observation, localNodes),
    scheduledEventWindowLoad(observation, targetOffsetMin, localNodes),
    scheduledEventWindowLoad(observation, targetOffsetMin, [node.node_id]),
    historyFeature(row, poiId, 'queue_count') ?? own ?? 0,
    (row.__history || []).length > 1 ? queue(row.__history.at(-2).OBSERVED_INPUT.observation, poiId) ?? own ?? 0 : own ?? 0,
    hourSin, hourCos, rain, hot];
}
function roadFeatures(row, edgeId) {
  const observation = row.OBSERVED_INPUT.observation, edge = edgeById.get(edgeId);
  const localNodeIds = [edge.from_node_id, edge.to_node_id];
  const nearby = [...new Set(localNodeIds.flatMap(id => [id, ...(neighbors.get(id) || [])]))];
  const localPois = nearby.map(id => nodeById.get(id)?.poi_id).filter(Boolean);
  const localQueues = localPois.map(id => queue(observation, id)).filter(Number.isFinite);
  const neighboringRatios = [...(adjacentEdges.get(edgeId) || [])]
    .map(id => roadRatio(observation, id)).filter(Number.isFinite);
  const localEdges = [...new Set(localNodeIds.flatMap(id => incidentEdges.get(id) || []))];
  const closed = localEdges.filter(item => observation.roads?.[item.edge_id]?.is_open === false).length;
  const [hourSin, hourCos] = timeFeatures(observation);
  const [rain, hot] = weatherFeatures(observation);
  const nowRatio = roadRatio(observation, edgeId);
  const lagOne = historyFeature(row, edgeId, 'travel_time_min', true);
  const lagTwo = (row.__history || []).length > 1
    ? roadRatio(row.__history.at(-2).OBSERVED_INPUT.observation, edgeId) : null;
  return [nowRatio ?? 1, neighboringRatios.length
      ? neighboringRatios.reduce((a, b) => a + b, 0) / neighboringRatios.length : 1,
    localQueues.length ? localQueues.reduce((a, b) => a + b, 0) / localQueues.length : 0,
    eventLoad(observation, localNodeIds.concat(nearby.filter(id => !localNodeIds.includes(id)))),
    eventLoad(observation), localEventCountdown(observation, nearby),
    localEdges.length ? closed / localEdges.length : 0,
    lagOne ?? nowRatio ?? 1, lagTwo ?? nowRatio ?? 1,
    observation.roads?.[edgeId]?.is_open === false ? 1 : 0,
    hourSin, hourCos, rain, hot];
}
function target(row, entityType, entityId, horizon) {
  if (row.FUTURE_TARGET.availability[horizon] !== true) return null;
  const environment = row.FUTURE_TARGET[horizon]?.environment;
  if (!environment) return null;
  if (entityType === 'poi') return environment.pois?.[entityId]?.queue_count ?? null;
  const edge = edgeById.get(entityId);
  const minutes = environment.roads?.[entityId]?.travel_time_min;
  if (!edge || !Number.isFinite(minutes) || environment.roads[entityId].is_open !== true) return null;
  return minutes / edge.base_travel_time_min;
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
function fit(rows, entityType, entityId, horizon, featureFn, lambda = 0.5) {
  const records = [];
  for (const row of rows) {
    const y = target(row, entityType, entityId, horizon);
    if (!Number.isFinite(y)) continue;
    const raw = featureFn(row, entityId, horizon);
    if (!raw.every(Number.isFinite)) continue;
    records.push({ raw, y });
  }
  const dimensions = records[0]?.raw.length || 0;
  const means = Array(dimensions).fill(0), scales = Array(dimensions).fill(0);
  for (const record of records) for (let i = 0; i < dimensions; i++) means[i] += record.raw[i] / records.length;
  for (const record of records) for (let i = 0; i < dimensions; i++) scales[i] += (record.raw[i] - means[i]) ** 2 / records.length;
  for (let i = 0; i < dimensions; i++) scales[i] = Math.sqrt(scales[i]) || 1;
  const size = dimensions + 1, gram = Array.from({ length: size }, () => Array(size).fill(0)), rhs = Array(size).fill(0);
  for (const record of records) {
    const vector = [1, ...record.raw.map((value, i) => (value - means[i]) / scales[i])];
    for (let i = 0; i < size; i++) {
      rhs[i] += vector[i] * record.y;
      for (let j = 0; j < size; j++) gram[i][j] += vector[i] * vector[j];
    }
  }
  for (let i = 1; i < size; i++) gram[i][i] += lambda;
  return { means, scales, coefficients: solve(gram, rhs), sample_count: records.length };
}
function predict(model, raw) {
  if (!model || !raw.every(Number.isFinite)) return null;
  const vector = [1, ...raw.map((value, index) => (value - model.means[index]) / model.scales[index])];
  return vector.reduce((sum, value, index) => sum + value * model.coefficients[index], 0);
}
function fitNonzero(rows, poiId, horizon, lambda = 100) {
  const records = [];
  for (const row of rows) {
    const y = target(row, 'poi', poiId, horizon), raw = poiFeatures(row, poiId, horizon);
    if (Number.isFinite(y) && raw.every(Number.isFinite)) records.push({ raw, y: y > 0 ? 1 : 0 });
  }
  const dimensions = records[0]?.raw.length || 0, means = Array(dimensions).fill(0), scales = Array(dimensions).fill(0);
  for (const record of records) for (let i = 0; i < dimensions; i++) means[i] += record.raw[i] / records.length;
  for (const record of records) for (let i = 0; i < dimensions; i++) scales[i] += (record.raw[i] - means[i]) ** 2 / records.length;
  for (let i = 0; i < dimensions; i++) scales[i] = Math.sqrt(scales[i]) || 1;
  const vectors = records.map(record => [1, ...record.raw.map((value, i) => (value - means[i]) / scales[i])]);
  const prevalence = records.reduce((sum, record) => sum + record.y, 0) / Math.max(1, records.length);
  const coefficients = Array(dimensions + 1).fill(0);
  coefficients[0] = Math.log(Math.max(1e-5, prevalence) / Math.max(1e-5, 1 - prevalence));
  for (let iteration = 0; iteration < 30; iteration++) {
    const hessian = Array.from({ length: dimensions + 1 }, () => Array(dimensions + 1).fill(0));
    const gradient = Array(dimensions + 1).fill(0);
    for (let r = 0; r < records.length; r++) {
      const vector = vectors[r];
      const z = vector.reduce((sum, value, i) => sum + value * coefficients[i], 0);
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const weight = Math.max(1e-5, probability * (1 - probability)), residual = records[r].y - probability;
      for (let i = 0; i <= dimensions; i++) {
        gradient[i] += vector[i] * residual;
        for (let j = 0; j <= dimensions; j++) hessian[i][j] += vector[i] * vector[j] * weight;
      }
    }
    for (let i = 1; i <= dimensions; i++) { hessian[i][i] += lambda; gradient[i] -= lambda * coefficients[i]; }
    const step = solve(hessian, gradient);
    for (let i = 0; i <= dimensions; i++) coefficients[i] += step[i];
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return { means, scales, coefficients, sample_count: records.length, positive_rate: prevalence, regularization: lambda };
}
function predictNonzero(config, raw) {
  if (!config || !raw.every(Number.isFinite)) return null;
  const z = [1, ...raw.map((value, i) => (value - config.means[i]) / config.scales[i])]
    .reduce((sum, value, i) => sum + value * config.coefficients[i], 0);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
function evaluateNonzero(rows, horizon, models) {
  const scores = []; let brier = 0, positives = 0;
  for (const row of rows) for (const id of poiIds) {
    const y = target(row, 'poi', id, horizon); if (!Number.isFinite(y)) continue;
    const label = y > 0 ? 1 : 0, probability = predictNonzero(models[id], poiFeatures(row, id, horizon));
    scores.push({ probability, label }); brier += (probability - label) ** 2; positives += label;
  }
  scores.sort((a, b) => b.probability - a.probability);
  let hits = 0, averagePrecision = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i].label) { hits++; averagePrecision += hits / (i + 1); }
  const top = scores.slice(0, Math.ceil(scores.length * .1));
  return { n: scores.length, positive_rate: positives / scores.length,
    average_precision: positives ? averagePrecision / positives : null,
    prevalence_baseline_average_precision: positives / scores.length,
    brier: brier / scores.length,
    prevalence_baseline_brier: (positives / scores.length) * (1 - positives / scores.length),
    top10_precision: top.filter(item => item.label).length / top.length };
}
function evaluate(rows, entityType, entityIds, horizon, models, baselineModels) {
  let n = 0, absolute = 0, squared = 0, persistenceAbsolute = 0, simpleAbsolute = 0, zeroAbsolute = 0;
  const errors = [];
  for (const row of rows) for (const id of entityIds) {
    const y = target(row, entityType, id, horizon);
    if (!Number.isFinite(y)) continue;
    const fullRaw = (entityType === 'poi' ? poiFeatures : roadFeatures)(row, id, horizon);
    const baseRaw = entityType === 'poi' ? [fullRaw[0]] : [fullRaw[0]];
    const full = predict(models[id], fullRaw);
    const simple = predict(baselineModels[id], baseRaw);
    if (!Number.isFinite(full) || !Number.isFinite(simple)) continue;
    const edge = entityType === 'road' ? edgeById.get(id) : null;
    const currentRaw = baseRaw[0];
    const scale = edge ? edge.base_travel_time_min : 1;
    const yValue = y * scale, fullValue = Math.max(entityType === 'road' ? 1 : 0, full) * scale;
    const simpleValue = Math.max(entityType === 'road' ? 1 : 0, simple) * scale;
    const persistenceValue = Math.max(entityType === 'road' ? 1 : 0, currentRaw) * scale;
    const error = fullValue - yValue;
    n++; absolute += Math.abs(error); squared += error ** 2;
    simpleAbsolute += Math.abs(simpleValue - yValue); persistenceAbsolute += Math.abs(persistenceValue - yValue);
    if (entityType === 'poi') zeroAbsolute += Math.abs(yValue);
    errors.push(Math.abs(error));
  }
  errors.sort((a, b) => a - b);
  return { n, mae: n ? absolute / n : null, rmse: n ? Math.sqrt(squared / n) : null,
    simple_current_only_mae: n ? simpleAbsolute / n : null,
    persistence_mae: n ? persistenceAbsolute / n : null,
    zero_baseline_mae: entityType === 'poi' && n ? zeroAbsolute / n : null,
    absolute_error_p90: errors.length ? errors[Math.ceil(errors.length * 0.9) - 1] : null };
}
async function main() {
  const split = Object.fromEntries(await Promise.all(['train', 'val', 'test'].map(async name => [name, await readSplit(name)])));
  const models = { poi_nonzero: {} }, baselines = {}, metrics = {};
  for (const [entityType, ids, featureFn] of [['poi', poiIds, poiFeatures], ['road', [...edgeById.keys()].sort(), roadFeatures]]) {
    models[entityType] = {}; baselines[entityType] = {}; metrics[entityType] = {};
    for (const horizon of horizons) {
      const current = {}, simple = {};
      for (const id of ids) {
        current[id] = fit(split.train, entityType, id, horizon, featureFn);
        simple[id] = fit(split.train, entityType, id, horizon,
          (row, key) => [(entityType === 'poi' ? poiFeatures(row, key)[0] : roadFeatures(row, key)[0])]);
      }
      models[entityType][horizon] = current; baselines[entityType][horizon] = simple;
      const val = evaluate(split.val, entityType, ids, horizon, current, simple);
      const test = evaluate(split.test, entityType, ids, horizon, current, simple);
      metrics[entityType][horizon] = { validation: val, test,
        feature_names: entityType === 'poi'
          ? ['own_queue', 'own_queue_missing', 'neighbor_queue_mean', 'local_road_delay_ratio', 'local_closed_road_fraction', 'local_event_load', 'global_event_load', 'local_event_time_proximity', 'local_scheduled_event_window_capacity', 'poi_scheduled_event_window_capacity', 'lag1_queue', 'lag2_queue', 'hour_sin', 'hour_cos', 'rain', 'hot']
          : ['current_road_delay_ratio', 'neighbor_road_delay_ratio', 'nearby_poi_queue_mean', 'local_event_load', 'global_event_load', 'local_event_time_proximity', 'local_closed_road_fraction', 'lag1_road_ratio', 'lag2_road_ratio', 'current_is_closed', 'hour_sin', 'hour_cos', 'rain', 'hot'] };
    }
  }
  const nonzeroMetrics = {};
  for (const horizon of horizons) {
    const candidates = [];
    for (const regularization of [10, 30, 100, 300]) {
      const candidateModels = {};
      for (const id of poiIds) candidateModels[id] = fitNonzero(split.train, id, horizon, regularization);
      const validation = evaluateNonzero(split.val, horizon, candidateModels);
      candidates.push({ regularization, validation, models: candidateModels });
    }
    candidates.sort((a, b) => b.validation.average_precision - a.validation.average_precision);
    const selected = candidates[0];
    models.poi_nonzero[horizon] = selected.models;
    nonzeroMetrics[horizon] = { regularization_selected_on_validation: selected.regularization,
      candidate_validation: candidates.map(({ regularization, validation }) => ({ regularization, validation })),
      validation: selected.validation,
      fixed_regularization_100_test: evaluateNonzero(split.test, horizon,
        candidates.find(candidate => candidate.regularization === 100).models),
      test: evaluateNonzero(split.test, horizon, selected.models) };
  }
  const manifestPath = path.join(path.dirname(dataDir), 'split_manifest.json');
  const splitManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const groupCounts = splitManifest?.group_counts || { train: 42, val: 9, test: 9 };
  const artifact = { model_type: 'graph-local temporal ridge regression plus nonzero-queue logistic head', model_version: modelVersion,
    dataset_version: datasetVersion, dataset_schema_version: 'dataset-p1.1',
    graph_version: '1.0', simulator_version: simulatorVersion,
    source_tier: 'T4', synthetic: true, fitted_at: new Date().toISOString(),
    graph_contract: { node_ids: graph.nodes.map(node => node.node_id).sort(),
      poi_ids: poiIds, edges: graph.edges.map(edge => ({ edge_id: edge.edge_id,
        from_node_id: edge.from_node_id, to_node_id: edge.to_node_id,
        base_travel_time_min: edge.base_travel_time_min })).sort((a, b) => a.edge_id.localeCompare(b.edge_id)) },
    feature_policy: 'observed current state + previous two observations + one-hop graph context + horizon-aware scheduled event window, local road/weather/time features; future latent fields are excluded',
    road_policy: 'predict open-road travel-time ratios; road availability is passed through from observed input and is never inferred or reopened by the learned model',
    training_group_counts: groupCounts,
    metrics: { ...metrics, poi_nonzero_probability: nonzeroMetrics }, models,
    limitations: ['T4 simulation only; not calibrated against real operations',
      'linear model captures local graph and temporal signals but is not a GNN/RNN',
      'POI nonzero-queue ranking is only modestly above prevalence; 60-minute Brier does not beat the constant-rate baseline',
      'validation P90 interval is empirical residual quantile and not calibrated coverage',
      'not eligible to replace planner rule forecast until real external validation'] };
  fs.writeFileSync(output, `${JSON.stringify(artifact)}\n`, 'utf8');
  const summary = Object.fromEntries(['poi','road','poi_nonzero_probability'].map(type => [type,
    Object.fromEntries(horizons.map(horizon => [horizon, type === 'poi_nonzero_probability' ? nonzeroMetrics[horizon].test : metrics[type][horizon].test]))]));
  fs.writeFileSync(reportPath,
    `${JSON.stringify({ dataset_version: artifact.dataset_version, model_version: artifact.model_version,
      test_metrics: summary, train_groups: groupCounts.train, validation_groups: groupCounts.val, test_groups: groupCounts.test,
      event_reference_policy: 'program names and exact Map1 venue node IDs come from undated user images and a dated third-party guide; all training event windows are randomized T4 values',
      source_tier: 'T4', synthetic: true }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, rows: Object.fromEntries(Object.entries(split).map(([name, rows]) => [name, rows.length])), metrics: summary }, null, 2)}\n`);
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { readSplit, queue, poiFeatures, roadFeatures, target, fit, predict, fitNonzero, predictNonzero, evaluate, evaluateNonzero, poiIds, edgeById, horizons };

'use strict';

const model = require('./graph-temporal-v0.3.json');

function sameList(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }
function verifyGraph(graph) {
  const contract = model.graph_contract;
  const nodeIds = (graph.nodes || []).map(node => node.node_id).sort();
  const poiIds = (graph.nodes || []).filter(node => node.poi_id).map(node => node.poi_id).sort();
  const edges = (graph.edges || []).map(edge => ({ edge_id: edge.edge_id,
    from_node_id: edge.from_node_id, to_node_id: edge.to_node_id }))
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));
  if (!sameList(nodeIds, contract.node_ids) || !sameList(poiIds, contract.poi_ids) ||
      edges.length !== contract.edges.length || edges.some((edge, i) =>
        edge.edge_id !== contract.edges[i].edge_id || edge.from_node_id !== contract.edges[i].from_node_id || edge.to_node_id !== contract.edges[i].to_node_id))
    throw new Error('当前规划图节点/道路拓扑与模型训练图不一致');
}

const trainingEdges = new Map(model.graph_contract.edges.map(edge => [edge.edge_id, edge]));
const nodes = new Map();
const neighbors = new Map();
const incidentEdges = new Map();
const adjacentEdges = new Map();
function indexGraph(graph) {
  verifyGraph(graph);
  nodes.clear(); neighbors.clear(); incidentEdges.clear(); adjacentEdges.clear();
  for (const node of graph.nodes) { nodes.set(node.node_id, node); neighbors.set(node.node_id, new Set()); incidentEdges.set(node.node_id, []); }
  for (const edge of model.graph_contract.edges) {
    neighbors.get(edge.from_node_id).add(edge.to_node_id); neighbors.get(edge.to_node_id).add(edge.from_node_id);
    incidentEdges.get(edge.from_node_id).push(edge); incidentEdges.get(edge.to_node_id).push(edge);
    adjacentEdges.set(edge.edge_id, new Set());
  }
  for (const edge of model.graph_contract.edges) for (const nodeId of [edge.from_node_id, edge.to_node_id])
    for (const other of incidentEdges.get(nodeId)) if (other.edge_id !== edge.edge_id) adjacentEdges.get(edge.edge_id).add(other.edge_id);
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}
function queue(obs, id) {
  const value = obs?.pois?.[id]?.queue_count;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function roadRatio(obs, id) {
  const edge = trainingEdges.get(id), value = obs?.roads?.[id]?.travel_time_min;
  return edge && Number.isFinite(value) && edge.base_travel_time_min > 0 ? value / edge.base_travel_time_min : null;
}
function eventLoad(obs, targetNodeIds = null) {
  let total = 0;
  for (const event of Object.values(obs?.events || {})) {
    const weight = !targetNodeIds ? 1 : event.node_id === targetNodeIds[0] ? 1 : targetNodeIds.slice(1).includes(event.node_id) ? .5 : 0;
    if (weight) total += weight * ((Number.isFinite(event.event_queue_count) ? event.event_queue_count : 0) + (Number.isFinite(event.attending_count) ? event.attending_count : 0));
  }
  return total;
}
function localEventCountdown(obs, targetNodeIds) {
  const now = parseTimestamp(obs?.timestamp); if (!Number.isFinite(now)) return 0;
  let result = 0;
  for (const event of Object.values(obs?.events || {})) {
    const weight = event.node_id === targetNodeIds[0] ? 1 : targetNodeIds.slice(1).includes(event.node_id) ? .5 : 0;
    const start = parseTimestamp(event.start_time);
    if (!weight || !Number.isFinite(start)) continue;
    const distance = Math.abs(start - now) / 60000;
    if (distance <= 120) result += weight * (1 - distance / 120);
  }
  return result;
}
function scheduledEventWindowLoad(obs, targetOffsetMin, targetNodeIds) {
  const now = parseTimestamp(obs?.timestamp); if (!Number.isFinite(now)) return 0;
  const targetTime = now + targetOffsetMin * 60000;
  let total = 0;
  for (const event of Object.values(obs?.events || {})) {
    const weight = event.node_id === targetNodeIds[0] ? 1 : targetNodeIds.slice(1).includes(event.node_id) ? .5 : 0;
    const board = parseTimestamp(event.boarding_open_time || event.start_time), end = parseTimestamp(event.end_time);
    if (!weight || !Number.isFinite(board) || !Number.isFinite(end) || targetTime < board || targetTime > end || event.cancelled === true) continue;
    const capacity = Number.isFinite(event.capacity) ? event.capacity
      : (Number.isFinite(event.attending_count) ? event.attending_count : 0) + (Number.isFinite(event.event_queue_count) ? event.event_queue_count : 0);
    total += weight * capacity;
  }
  return total;
}
function timeFeatures(obs) {
  const date = new Date(parseTimestamp(obs?.timestamp));
  const hour = Number.isFinite(date.getTime()) ? date.getUTCHours() + date.getUTCMinutes() / 60 : 12;
  const angle = 2 * Math.PI * hour / 24;
  return [Math.sin(angle), Math.cos(angle)];
}
function weatherFeatures(obs) { return [obs?.weather?.category === 'RAIN' ? 1 : 0, obs?.weather?.category === 'HOT' ? 1 : 0]; }
function historyValue(history, id, edge) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obs = history[i]; const value = edge ? roadRatio(obs, id) : queue(obs, id);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function poiFeatures(obs, id, history, horizonMin) {
  const node = [...nodes.values()].find(item => item.poi_id === id);
  const adjacent = [...neighbors.get(node.node_id)];
  const adjacentPois = adjacent.map(nodeId => nodes.get(nodeId)?.poi_id).filter(Boolean);
  const own = queue(obs, id), neighborValues = adjacentPois.map(other => queue(obs, other)).filter(Number.isFinite);
  const roads = incidentEdges.get(node.node_id), ratios = roads.map(edge => roadRatio(obs, edge.edge_id)).filter(Number.isFinite);
  const closed = roads.filter(edge => obs.roads?.[edge.edge_id]?.is_open === false).length;
  const localNodes = [node.node_id, ...adjacent], [hourSin, hourCos] = timeFeatures(obs), [rain, hot] = weatherFeatures(obs);
  const lag1 = historyValue(history, id, false) ?? own ?? 0;
  const lag2 = history.length > 1 ? queue(history.at(-2), id) ?? own ?? 0 : own ?? 0;
  return [own ?? 0, own === null ? 1 : 0, neighborValues.length ? neighborValues.reduce((a,b)=>a+b,0)/neighborValues.length : 0,
    ratios.length ? ratios.reduce((a,b)=>a+b,0)/ratios.length : 1, roads.length ? closed/roads.length : 0,
    eventLoad(obs, localNodes), eventLoad(obs), localEventCountdown(obs, localNodes),
    scheduledEventWindowLoad(obs, horizonMin, localNodes), scheduledEventWindowLoad(obs, horizonMin, [node.node_id]),
    lag1, lag2, hourSin, hourCos, rain, hot];
}
function roadFeatures(obs, id, history) {
  const edge = trainingEdges.get(id), localNodes = [edge.from_node_id, edge.to_node_id];
  const nearby = [...new Set(localNodes.flatMap(nodeId => [nodeId, ...neighbors.get(nodeId)]))];
  const localPois = nearby.map(nodeId => nodes.get(nodeId)?.poi_id).filter(Boolean);
  const queues = localPois.map(poiId => queue(obs, poiId)).filter(Number.isFinite);
  const adjacent = [...adjacentEdges.get(id)].map(edgeId => roadRatio(obs, edgeId)).filter(Number.isFinite);
  const localEdges = [...new Set(localNodes.flatMap(nodeId => incidentEdges.get(nodeId)))];
  const closed = localEdges.filter(item => obs.roads?.[item.edge_id]?.is_open === false).length;
  const [hourSin, hourCos] = timeFeatures(obs), [rain, hot] = weatherFeatures(obs), current = roadRatio(obs, id);
  const lag1 = historyValue(history, id, true) ?? current ?? 1;
  const lag2 = history.length > 1 ? roadRatio(history.at(-2), id) ?? current ?? 1 : current ?? 1;
  return [current ?? 1, adjacent.length ? adjacent.reduce((a,b)=>a+b,0)/adjacent.length : 1,
    queues.length ? queues.reduce((a,b)=>a+b,0)/queues.length : 0,
    eventLoad(obs, nearby), eventLoad(obs), localEventCountdown(obs, nearby), localEdges.length ? closed/localEdges.length : 0,
    lag1, lag2, obs.roads?.[id]?.is_open === false ? 1 : 0, hourSin, hourCos, rain, hot];
}
function estimate(config, raw) {
  if (!config || !raw.every(Number.isFinite)) return null;
  return [1, ...raw.map((value, i) => (value - config.means[i]) / config.scales[i])]
    .reduce((sum, value, i) => sum + value * config.coefficients[i], 0);
}
function probability(config, raw) {
  if (!config || !raw.every(Number.isFinite)) return null;
  const z = [1, ...raw.map((value, i) => (value - config.means[i]) / config.scales[i])]
    .reduce((sum, value, i) => sum + value * config.coefficients[i], 0);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
function validateObservation(obs) {
  if (!obs || typeof obs !== 'object' || Array.isArray(obs)) throw new TypeError('observation must be an object');
  if (obs.synthetic !== true || obs.source_tier !== 'T4') throw new TypeError('only explicitly marked T4 synthetic observations are accepted');
  if (!Number.isFinite(parseTimestamp(obs.timestamp))) throw new TypeError('observation.timestamp must be a parseable timestamp');
  if (!obs.pois || typeof obs.pois !== 'object' || !obs.roads || typeof obs.roads !== 'object') throw new TypeError('observation must include pois and roads');
  for (const [id, value] of Object.entries(obs.pois)) if (!nodesHasPoi(id) || (value?.queue_count != null && (!Number.isFinite(value.queue_count) || value.queue_count < 0))) throw new TypeError(`invalid poi observation: ${id}`);
  for (const [id, value] of Object.entries(obs.roads)) if (!trainingEdges.has(id) || (value?.travel_time_min != null && (!Number.isFinite(value.travel_time_min) || value.travel_time_min < 0)) || (value?.is_open != null && typeof value.is_open !== 'boolean')) throw new TypeError(`invalid road observation: ${id}`);
  if (obs.events != null && (typeof obs.events !== 'object' || Array.isArray(obs.events))) throw new TypeError('observation.events must be an object');
  for (const event of Object.values(obs.events || {})) if (!nodes.has(event?.node_id)) throw new TypeError('event.node_id is not in the training graph');
}
function nodesHasPoi(id) { return [...nodes.values()].some(node => node.poi_id === id); }
function describe() {
  return { model_version: model.model_version, dataset_version: model.dataset_version, source_tier: model.source_tier,
    synthetic: model.synthetic, graph_version: model.graph_version, training_group_counts: model.training_group_counts,
    mode: 'experimental_shadow', affects_planning: false,
    metrics: Object.fromEntries(['poi','road'].map(type => [type, Object.fromEntries(Object.entries(model.metrics[type]).map(([h, result]) => [h, {
      test_mae: result.test.mae, test_rmse: result.test.rmse, simple_current_only_test_mae: result.test.simple_current_only_mae,
      persistence_test_mae: result.test.persistence_mae, validation_absolute_error_p90: result.validation.absolute_error_p90, test_sample_count: result.test.n
    }]))])),
    poi_nonzero_probability: Object.fromEntries(Object.entries(model.metrics.poi_nonzero_probability).map(([h, result]) => [h, {
      test_average_precision: result.test.average_precision,
      test_prevalence_baseline_average_precision: result.test.prevalence_baseline_average_precision,
      test_brier: result.test.brier, test_prevalence_baseline_brier: result.test.prevalence_baseline_brier,
      test_positive_rate: result.test.positive_rate, test_top10_precision: result.test.top10_precision
    }])), limitations: model.limitations };
}
function predict(graph, observation, history = []) {
  indexGraph(graph); validateObservation(observation);
  if (!Array.isArray(history) || history.length > 2) throw new TypeError('history must contain at most two previous observations');
  for (const item of history) validateObservation(item);
  const horizons = {};
  for (const horizon of Object.keys(model.metrics.poi)) {
    const poi_predictions = {}, road_predictions = {};
    const horizonMin = Number(horizon.replace('target_', ''));
    for (const node of nodes.values()) if (node.poi_id) {
      const id = node.poi_id, raw = poiFeatures(observation, id, history, horizonMin), config = model.models.poi[horizon][id];
      const nonzero_probability = probability(model.models.poi_nonzero[horizon][id], raw);
      if (!Number.isFinite(queue(observation, id))) { poi_predictions[id] = { available:false, queue_count:null, nonzero_probability, reason:'MISSING_OBSERVATION' }; continue; }
      const count = Math.max(0, estimate(config, raw));
      const halfWidth = model.metrics.poi[horizon].validation.absolute_error_p90;
      poi_predictions[id] = { available:true, queue_count:Number(count.toFixed(4)),
        nonzero_probability:Number(nonzero_probability.toFixed(4)),
        lower_bound:Number(Math.max(0, count - halfWidth).toFixed(4)), upper_bound:Number((count + halfWidth).toFixed(4)),
        interval_method:'validation P90 absolute residual (empirical, uncalibrated coverage)' };
    }
    for (const edge of model.graph_contract.edges) {
      const id = edge.edge_id, current = observation.roads[id];
      if (!current || !Number.isFinite(current.travel_time_min)) { road_predictions[id] = { available:false, travel_time_min:null, is_open:current?.is_open ?? null, reason:'MISSING_OBSERVATION' }; continue; }
      if (current.is_open === false) { road_predictions[id] = { available:true, travel_time_min:null, is_open:false, reason:'CLOSED_ROAD_PASSTHROUGH' }; continue; }
      const config = model.models.road[horizon][id], ratio = Math.max(1 / edge.base_travel_time_min, estimate(config, roadFeatures(observation, id, history)));
      const minutes = ratio * edge.base_travel_time_min;
      const halfWidth = model.metrics.road[horizon].validation.absolute_error_p90;
      road_predictions[id] = { available:true, travel_time_min:Number(minutes.toFixed(4)),
        lower_bound:Number(Math.max(edge.base_travel_time_min, minutes - halfWidth).toFixed(4)), upper_bound:Number((minutes + halfWidth).toFixed(4)), is_open:true,
        interval_method:'validation P90 absolute residual (empirical, uncalibrated coverage)' };
    }
    horizons[horizon.slice('target_'.length)] = { poi_predictions, road_predictions };
  }
  return { ...describe(), generated_at:new Date().toISOString(), observation_timestamp:observation.timestamp, horizons,
    warning:'T4 仿真数据实验性预测；queue_count 为连续回归值，nonzero_probability 为未来队列非零的实验风险概率，两者均未用真实客流/路况校准，不改变规则预测或路线规划。道路封闭状态只按输入透传。' };
}
module.exports = { describe, predict, validateObservation, verifyGraph };

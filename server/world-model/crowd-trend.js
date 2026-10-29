'use strict';

const crypto = require('node:crypto');
const model = require('./crowd-trend-model-v0.1.json');

const FEATURES = model.feature_names;
const TREND_THRESHOLD = 0.03;

function topology(graph) {
  return {
    nodes: (graph.nodes || []).map(node => [node.node_id, node.poi_id || null])
      .sort((a, b) => a[0].localeCompare(b[0])),
    edges: (graph.edges || []).map(edge => [edge.edge_id, edge.from_node_id, edge.to_node_id])
      .sort((a, b) => a[0].localeCompare(b[0]))
  };
}

function verifyGraph(graph) {
  const actual = topology(graph);
  const expected = { nodes: model.graph_contract.nodes, edges: model.graph_contract.edges };
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('当前图节点/POI/edge 拓扑与 crowd-trend 模型训练图不一致');
  const capacities = (graph.nodes || []).map(node => [node.node_id, node.capacity ?? null])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(capacities) !== JSON.stringify(model.graph_contract.feature_graph.node_capacities))
    throw new Error('当前 POI 容量与 crowd-trend 模型训练特征不一致');
}

function parseLocalTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d(?::\d\d)?)/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}Z`);
}

function treePredict(ensemble, features, logistic = false) {
  let value = ensemble.baseline;
  for (const tree of ensemble.trees) {
    let index = 0;
    while (!tree[index][5]) {
      const [featureIndex, threshold, left, right, missingLeft] = tree[index];
      const feature = features[featureIndex];
      index = !Number.isFinite(feature) ? (missingLeft ? left : right)
        : (feature <= threshold ? left : right);
    }
    value += tree[index][6];
  }
  if (!logistic) return value;
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
}

function buildFeatureContext(graph, observation) {
  const nodes = new Map(graph.nodes.map(node => [node.node_id, node]));
  const poiNodes = new Map(graph.nodes.filter(node => node.poi_id).map(node => [node.poi_id, node]));
  const neighbors = new Map(graph.nodes.map(node => [node.node_id, new Set()]));
  const incident = new Map(graph.nodes.map(node => [node.node_id, []]));
  const edgePairs = new Map();
  const nodeCapacities = new Map(model.graph_contract.feature_graph.node_capacities);
  const edgeBaseTimes = new Map(model.graph_contract.feature_graph.edge_base_travel_times);
  for (const edge of graph.edges) {
    neighbors.get(edge.from_node_id).add(edge.to_node_id);
    neighbors.get(edge.to_node_id).add(edge.from_node_id);
    incident.get(edge.from_node_id).push(edge);
    incident.get(edge.to_node_id).push(edge);
    edgePairs.set([edge.from_node_id, edge.to_node_id].sort().join('|'), edge);
  }
  const now = parseLocalTime(observation.timestamp);
  return { nodes, poiNodes, neighbors, incident, edgePairs, nodeCapacities, edgeBaseTimes, now };
}

function featuresForPoi(graph, observation, poiId, horizonMin, context, history = []) {
  const node = context.poiNodes.get(poiId);
  if (!node) return null;
  const nodeId = node.node_id;
  const localNodes = new Set([nodeId, ...context.neighbors.get(nodeId)]);
  const neighborPois = [...context.neighbors.get(nodeId)]
    .map(id => context.nodes.get(id)?.poi_id).filter(Boolean);
  const poi = observation.pois?.[poiId];
  const crowd = poi?.crowd_ratio;
  if (!Number.isFinite(crowd) || crowd < 0 || crowd > 1) return null;
  const queue = Number.isFinite(poi.queue_count) ? poi.queue_count : 0;
  const neighborStates = neighborPois.map(id => observation.pois?.[id]).filter(Boolean);
  const neighborCrowds = neighborStates.map(item => item.crowd_ratio).filter(Number.isFinite);
  const neighborQueues = neighborStates.map(item => item.queue_count).filter(Number.isFinite);
  const roads = observation.roads || {};
  const edgeIds = context.incident.get(nodeId);
  const roadRatios = edgeIds.map(edge => {
    const time = roads[edge.edge_id]?.travel_time_min;
    const base = context.edgeBaseTimes.get(edge.edge_id);
    return Number.isFinite(time) && base > 0 ? time / base : null;
  }).filter(Number.isFinite);
  const events = Object.values(observation.events || {});
  let localLoad = 0, globalLoad = 0, countdown = 0, scheduledCapacity = 0;
  if (Number.isFinite(context.now)) {
    const targetTime = context.now + horizonMin * 60000;
    for (const event of events) {
      const weight = event.node_id === nodeId ? 1 : localNodes.has(event.node_id) ? 0.5 : 0;
      const load = (Number.isFinite(event.event_queue_count) ? event.event_queue_count : 0)
        + (Number.isFinite(event.attending_count) ? event.attending_count : 0);
      globalLoad += load;
      localLoad += weight * load;
      const start = parseLocalTime(event.boarding_open_time || event.start_time);
      const end = parseLocalTime(event.end_time);
      if (weight && Number.isFinite(start)) {
        const minutes = Math.abs(start - context.now) / 60000;
        if (minutes <= 120) countdown += weight * (1 - minutes / 120);
        if (Number.isFinite(end) && targetTime >= start && targetTime <= end && event.cancelled !== true)
          scheduledCapacity += weight * (Number.isFinite(event.capacity) ? event.capacity : load);
      }
    }
  }
  const hour = Number.isFinite(context.now) ? new Date(context.now).getUTCHours()
    + new Date(context.now).getUTCMinutes() / 60 : 12;
  const weather = observation.weather?.category;
  const lag = history.slice(-2).map(item => item.pois?.[poiId]?.crowd_ratio)
    .map(value => Number.isFinite(value) ? value : crowd);
  while (lag.length < 2) lag.unshift(crowd);
  const features = [
    crowd, queue, Math.log1p(queue), poi.is_open === true ? 1 : 0,
    (context.nodeCapacities.get(nodeId) || 0) / 1000,
    neighborCrowds.length ? neighborCrowds.reduce((a, b) => a + b, 0) / neighborCrowds.length : crowd,
    neighborCrowds.length ? Math.max(...neighborCrowds) : crowd,
    neighborQueues.length ? neighborQueues.reduce((a, b) => a + b, 0) / neighborQueues.length : 0,
    roadRatios.length ? roadRatios.reduce((a, b) => a + b, 0) / roadRatios.length : 1,
    edgeIds.length ? edgeIds.filter(edge => roads[edge.edge_id]?.is_open === false).length / edgeIds.length : 0,
    localLoad / 100, globalLoad / 100, countdown, scheduledCapacity / 100,
    Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24),
    weather === 'RAIN' ? 1 : 0, weather === 'HOT' ? 1 : 0,
    lag.at(-1), lag.at(-2), horizonMin / 60
  ];
  for (let index = 0; index < features.length; index += 1)
    features[index] = Number(features[index].toFixed(12));
  if (features.length !== FEATURES.length || features.some(value => !Number.isFinite(value)))
    throw new Error(`crowd-trend feature contract error for POI ${poiId}`);
  return features;
}

function describe() {
  return { model_version: model.model_version, schema_version: model.schema_version,
    source_tier: model.source_tier, synthetic: model.synthetic,
    simulator_version: model.simulator_version,
    mode: 'experimental_shadow', affects_planning: false,
    target: model.target, horizons_min: Object.keys(model.horizon_models).map(Number),
    poi_count: model.graph_contract.nodes.filter(([, poiId]) => poiId).length,
    graph_topology_sha256: crypto.createHash('sha256').update(JSON.stringify({
      nodes: model.graph_contract.nodes, edges: model.graph_contract.edges
    })).digest('hex'),
    limitation: '仅适用于当前 T4 模拟分布；不是万岁山真实客流/拥挤预测，且不改变现有规划结果。' };
}

function featureVector(graph, observation, poiId, horizonMin, history = []) {
  verifyGraph(graph);
  if (!Object.hasOwn(model.horizon_models, String(horizonMin))) throw new Error('unsupported crowd-trend horizon');
  return featuresForPoi(graph, observation, poiId, horizonMin,
    buildFeatureContext(graph, observation), history);
}

function predict(graph, observation, { horizonMin = 30, routes = [], history = [], allowCompatibleSyntheticRuntime = false } = {}) {
  verifyGraph(graph);
  if (!observation || observation.source_tier !== 'T4' || observation.synthetic !== true)
    throw new Error('crowd-trend 仅接受 source_tier=T4 且 synthetic=true 的模拟观测');
  const compatibleRuntime = allowCompatibleSyntheticRuntime === true
    && observation.simulator_version === 'app-forecast-sim-v1';
  if (observation.simulator_version !== model.simulator_version && !compatibleRuntime)
    throw new Error(`crowd-trend 仅接受 simulator_version=${model.simulator_version} 的观测`);
  if (!Object.hasOwn(model.horizon_models, String(horizonMin)))
    throw new Error('horizonMin 必须是 5、15、30 或 60');
  if (!observation.pois || typeof observation.pois !== 'object'
      || !observation.roads || typeof observation.roads !== 'object')
    throw new Error('模拟观测缺少 POI 或道路状态');
  if (!Array.isArray(history) || history.length > 2
      || history.some(item => !item || item.source_tier !== 'T4' || item.synthetic !== true))
    throw new Error('history 最多两条且必须是 T4 模拟观测');
  const context = buildFeatureContext(graph, observation);
  const horizonModel = model.horizon_models[String(horizonMin)];
  const predictions = {};
  for (const [poiId, node] of context.poiNodes) {
    const poi = observation.pois[poiId];
    if (poi?.is_open === false) continue;
    const features = featuresForPoi(graph, observation, poiId, horizonMin, context, history);
    if (!features) continue;
    const modelRatio = treePredict(horizonModel.crowd_ratio_regressor, features);
    const weight = horizonModel.validation_blend_weight;
    predictions[poiId] = { poi_id: poiId, node_id: node.node_id,
      current_crowd_ratio: poi.crowd_ratio,
      predicted_crowd_ratio: Math.max(0, Math.min(1, weight * modelRatio + (1 - weight) * poi.crowd_ratio)),
      upward_trend_probability: treePredict(horizonModel.upward_trend_classifier, features, true),
      upward_trend_definition: `crowd_ratio 上升至少 ${TREND_THRESHOLD}`,
      source_tier: 'T4', synthetic: true };
  }
  const routeScores = routes.map(route => {
    if (!route || typeof route.route_id !== 'string' || !Array.isArray(route.node_ids))
      throw new Error('每条候选路线需提供 route_id 和 node_ids 数组');
    for (const nodeId of route.node_ids) if (!context.nodes.has(nodeId))
      throw new Error(`候选路线包含未知地图1 node_id: ${nodeId}`);
    const routeEdges = [];
    for (let index = 1; index < route.node_ids.length; index += 1) {
      const edge = context.edgePairs.get([route.node_ids[index - 1], route.node_ids[index]].sort().join('|'));
      if (!edge) throw new Error(`候选路线不是地图1连通路径: ${route.node_ids[index - 1]} -> ${route.node_ids[index]}`);
      routeEdges.push(edge.edge_id);
    }
    const closedEdges = routeEdges.filter(edgeId => observation.roads?.[edgeId]?.is_open === false);
    const poiIds = route.node_ids.map(nodeId => context.nodes.get(nodeId)?.poi_id)
      .filter(poiId => poiId && predictions[poiId]);
    const values = poiIds.map(poiId => predictions[poiId]);
    return { route_id: route.route_id, poi_ids: poiIds,
      predicted_crowd_ratio_mean: values.length ? values.reduce((sum, item) => sum + item.predicted_crowd_ratio, 0) / values.length : null,
      predicted_upward_risk_mean: values.length ? values.reduce((sum, item) => sum + item.upward_trend_probability, 0) / values.length : null,
      poi_count: values.length, route_edge_ids: routeEdges,
      feasible_by_observed_open_state: closedEdges.length === 0, closed_edge_ids: closedEdges };
  });
  return { ...describe(), mode: compatibleRuntime ? 'synthetic_transfer_inference' : 'experimental_shadow',
    affects_planning: compatibleRuntime, training_simulator_version: model.simulator_version,
    input_simulator_version: observation.simulator_version,
    limitation: compatibleRuntime
      ? '训练数据和当前应用状态均为模拟数据；此为跨模拟器推理，未经真实客流校准，不能代表现场实时人数或真实准确率。'
      : describe().limitation,
    horizon_min: horizonMin, timestamp: observation.timestamp,
    poi_predictions: predictions, route_scores: routeScores,
    route_scores_are_comparative_only: true };
}

module.exports = { describe, predict, treePredict, verifyGraph, featureVector };

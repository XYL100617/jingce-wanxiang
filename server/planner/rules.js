'use strict';

const { mergeRules } = require('./config');
const { addMinutes, diffMinutes, toMillis } = require('./time');
const { queryQueue, interpolate } = require('./forecast');
const { findPath } = require('./astar');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function actionId(action) { return `${action.action_type}:${action.target_id || 'none'}`; }

function getCandidateActions(graph, state, options = {}) {
  const visitor = options.visitor || state.visitor;
  const excluded = new Set(options.excluded_target_ids || []);
  const required = new Set(options.required_target_ids || []);
  const actions = [];
  const nodeById = new Map((graph.nodes || []).map(node => [node.node_id, node]));
  const currentNode = nodeById.get(visitor.current_node_id) || {};
  const edgeTimePerCoordinate = (graph.edges || []).reduce((sum, edge) => {
    const from = nodeById.get(edge.from_node_id), to = nodeById.get(edge.to_node_id);
    if (!from || !to) return sum;
    const distance = Math.hypot(Number(from.algorithm_x || 0) - Number(to.algorithm_x || 0),
      Number(from.algorithm_y || 0) - Number(to.algorithm_y || 0));
    return distance > 0 ? sum + Number(edge.base_travel_time_min || 0) / distance : sum;
  }, 0) / Math.max(1, (graph.edges || []).length);
  const preferred = new Set(visitor.preferred_categories || []);
  const rules = mergeRules(options.rules || {});
  const poiCandidates = (graph.pois || [])
    .filter(poi => (!required.size || required.has(poi.poi_id) || required.has(poi.node_id)) && !excluded.has(poi.poi_id) && !(visitor.visited_poi_ids || []).includes(poi.poi_id))
    .map(poi => {
      const node = nodeById.get(poi.node_id) || {};
      const straightLineDistance = Math.hypot(Number(node.algorithm_x || 0) - Number(currentNode.algorithm_x || 0),
        Number(node.algorithm_y || 0) - Number(currentNode.algorithm_y || 0));
      // This is only a cheap pre-ranking ETA from Map1's schematic coordinate
      // frame. The legal-action pass below still uses the actual routed ETA.
      const estimatedTravelMin = straightLineDistance * edgeTimePerCoordinate * 1.25;
      const arrivalTime = addMinutes(state.timestamp, estimatedTravelMin);
      const queue = queryQueue(options.forecast, state, poi.poi_id, arrivalTime);
      const series = options.forecast?.poi_predictions?.[poi.poi_id] || [];
      const crowdRatio = Math.max(0, Math.min(1, interpolate(series, arrivalTime, 'crowd_ratio',
        Number(state.poi_states?.[poi.poi_id]?.crowd_level || 0) / 4)));
      const trendRisk = Math.max(0, Math.min(1, interpolate(series, arrivalTime, 'upward_trend_probability', 0)));
      const sensitivity = Math.max(0, Math.min(1, Number(visitor.preference_profile?.sensitivities?.crowd
        ?? Math.min(1, Number(visitor.preference_weights?.comfort || 0) * 2))));
      const score = rules.score;
      const crowdSeverity = crowdRatio ** 2 + Math.max(0, crowdRatio - .65) * 1.5;
      const priority = Number(poi.base_utility || 0) * .62
        + (preferred.has(poi.category) ? score.preference_reward * .5 : 0)
        - estimatedTravelMin * score.walk_cost_per_min
        - queue * score.queue_cost_per_min
        - crowdSeverity * score.crowd_cost_per_ratio * (.35 + sensitivity)
        - trendRisk * score.crowd_trend_cost * (.35 + sensitivity);
      return { poi, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.poi.poi_id.localeCompare(b.poi.poi_id));
  const candidateLimit = Number(options.candidate_limit || 0);
  for (const { poi } of candidateLimit > 0 ? poiCandidates.slice(0, candidateLimit) : poiCandidates) {
    actions.push({ action_type: 'VISIT_POI', target_id: poi.poi_id, target_node_id: poi.node_id });
  }
  for (const event of graph.events || []) {
    if ((!required.size || required.has(event.event_id) || required.has(event.node_id)) && !excluded.has(event.event_id) && !(visitor.attended_event_ids || []).includes(event.event_id)) {
      actions.push({ action_type: 'ATTEND_EVENT', target_id: event.event_id, target_node_id: event.node_id });
    }
  }
  for (const facility of graph.facilities || []) {
    const needsRest = Number(visitor.fatigue || 0) >= Number(facility.min_fatigue || 0.4) || visitor.force_rest === true;
    const requiredByPreference = visitor.require_rest === true && !(visitor.visited_facility_ids || []).length;
    if (!required.size && facility.facility_type === 'rest' && (needsRest || requiredByPreference) && !excluded.has(facility.facility_id)) {
      actions.push({ action_type: 'REST', target_id: facility.facility_id, target_node_id: facility.node_id });
    }
  }
  if (!required.size) {
    const now = toMillis(state.timestamp);
    const remaining = Number(visitor.remaining_time_min || 0);
    const upcomingOpenings = (graph.pois || [])
      .filter(poi => state.poi_states?.[poi.poi_id]?.is_open !== false && poi.open_time)
      .map(poi => (toMillis(poi.open_time) - now) / 60000)
      .filter(minutes => Number.isFinite(minutes) && minutes > 1)
      .sort((a, b) => a - b);
    const waitUntilOpenMin = Math.ceil(upcomingOpenings[0] || 0);
    // Wait once until Map1's next known opening only when the visitor will
    // still have a useful tour window afterwards. Never fill the plan with
    // repeated arbitrary 10-minute waits.
    if (waitUntilOpenMin > 0
        && waitUntilOpenMin + rules.return_buffer_min + 30 <= remaining) {
      actions.push({ action_type: 'WAIT', target_id: 'wait', target_node_id: visitor.current_node_id,
        duration_min: waitUntilOpenMin });
    }
    for (const exit of graph.exits || []) actions.push({ action_type: 'EXIT', target_id: exit.exit_id, target_node_id: exit.node_id });
  }
  return actions;
}

function findDefinition(graph, action) {
  if (action.action_type === 'VISIT_POI') return (graph.pois || []).find(x => x.poi_id === action.target_id);
  if (action.action_type === 'ATTEND_EVENT') return (graph.events || []).find(x => x.event_id === action.target_id);
  if (action.action_type === 'REST') return (graph.facilities || []).find(x => x.facility_id === action.target_id);
  if (action.action_type === 'EXIT') return (graph.exits || []).find(x => x.exit_id === action.target_id);
  if (action.action_type === 'WAIT') return { node_id: action.target_node_id };
  return null;
}

function reject(action, reason, route = null) {
  return { legal: false, action, reason, route };
}

function earliestExitRoute(graph, state, forecast, fromNodeId, departureTime, preferredExitNodeId = null) {
  let best = null;
  for (const exit of graph.exits || []) {
    if (preferredExitNodeId && exit.node_id !== preferredExitNodeId) continue;
    const route = findPath({ graph, state, forecast, startNodeId: fromNodeId, goalNodeId: exit.node_id, departureTime });
    if (route.reachable && (!best || route.travel_time_min < best.travel_time_min)) best = route;
  }
  return best;
}

function isActionLegal({ graph, state, forecast, action, visitor = state.visitor, rules: ruleOverrides = {} }) {
  const rules = mergeRules(ruleOverrides);
  const definition = findDefinition(graph, action);
  if (!definition) return reject(action, '目标ID不存在于统一景区图');
  if (action.action_type === 'VISIT_POI' && (visitor.visited_poi_ids || []).includes(action.target_id)) return reject(action, '景点已经访问，禁止重复安排');
  if (action.action_type === 'ATTEND_EVENT' && (visitor.attended_event_ids || []).includes(action.target_id)) return reject(action, '演出已经参加，禁止重复安排');
  if (action.action_type === 'REST' && (visitor.visited_facility_ids || []).includes(action.target_id)) return reject(action, '休息点已在本轮行程中使用');
  if (visitor.require_rest === true && !(visitor.visited_facility_ids || []).length && !['REST', 'EXIT'].includes(action.action_type)) return reject(action, '当前偏好要求先完成一次休息');

  const targetNodeId = definition.node_id || action.target_node_id || visitor.current_node_id;
  if (action.action_type === 'EXIT' && rules.preferred_exit_node_id && targetNodeId !== rules.preferred_exit_node_id) return reject(action, '与指定离园出口不一致');
  const route = findPath({ graph, state, forecast, startNodeId: visitor.current_node_id, goalNodeId: targetNodeId, departureTime: state.timestamp });
  if (!route.reachable) return reject(action, route.reason, route);

  const arrivalTime = addMinutes(state.timestamp, route.travel_time_min);
  let queueMin = 0;
  let crowdRatio = 0;
  let upwardTrendProbability = 0;
  let crowdPredictionSource = null;
  let serviceStartTime = arrivalTime;
  let durationMin = 0;
  let waitMin = 0;

  if (action.action_type === 'VISIT_POI') {
    const poiState = state.poi_states?.[action.target_id] || {};
    if (poiState.is_open === false) return reject(action, '景点当前关闭', route);
    if (definition.open_time && toMillis(arrivalTime) < toMillis(definition.open_time)) return reject(action, '预计到达时景点尚未开放', route);
    queueMin = queryQueue(forecast, state, action.target_id, arrivalTime);
    serviceStartTime = addMinutes(arrivalTime, queueMin);
    durationMin = Number(definition.visit_duration_min || 0);
  } else if (action.action_type === 'ATTEND_EVENT') {
    const eventState = state.event_states?.[action.target_id] || {};
    if (eventState.is_open === false || eventState.cancelled === true) return reject(action, '演出已关闭或取消', route);
    if (definition.latest_entry_time && toMillis(arrivalTime) > toMillis(definition.latest_entry_time)) return reject(action, '预计到达时间超过最晚入场时间', route);
    if (definition.start_time && toMillis(arrivalTime) < toMillis(definition.start_time)) {
      waitMin = Math.max(0, diffMinutes(definition.start_time, arrivalTime));
      if (waitMin > rules.max_event_wait_min) return reject(action,
        `演出尚需等待 ${Math.round(waitMin)} 分钟，先安排其他景点，之后再重新规划`, route);
      serviceStartTime = definition.start_time;
    }
    durationMin = Number(definition.duration_min || 0);
  } else if (action.action_type === 'REST') {
    durationMin = Number(definition.rest_duration_min || 15);
  } else if (action.action_type === 'WAIT') {
    durationMin = Number(action.duration_min || rules.wait_duration_min);
  }

  if (['VISIT_POI', 'ATTEND_EVENT'].includes(action.action_type)) {
    const crowdPoi = action.action_type === 'VISIT_POI'
      ? graph.pois?.find(item => item.poi_id === action.target_id)
      : graph.pois?.find(item => item.node_id === definition.node_id);
    const crowdSeries = forecast.poi_predictions?.[crowdPoi?.poi_id] || [];
    crowdRatio = Math.max(0, Math.min(1, interpolate(crowdSeries, arrivalTime, 'crowd_ratio', 0)));
    upwardTrendProbability = Math.max(0, Math.min(1, interpolate(crowdSeries, arrivalTime, 'upward_trend_probability', 0)));
    crowdPredictionSource = crowdSeries.some(point => point.prediction_source === 'trained_synthetic_transfer')
      ? 'trained_synthetic_transfer' : crowdSeries[0]?.prediction_source || 'rule_simulation';
  }

  const completionTime = addMinutes(serviceStartTime, durationMin);
  if (action.action_type === 'VISIT_POI' && definition.close_time && toMillis(completionTime) > toMillis(definition.close_time)) return reject(action, '无法在景点关闭前完成游览', route);
  if (action.action_type === 'ATTEND_EVENT' && definition.end_time && toMillis(completionTime) > toMillis(definition.end_time)) return reject(action, '演出结束时间窗不足', route);

  const totalActionMin = route.travel_time_min + queueMin + waitMin + durationMin;
  if (!['WAIT', 'EXIT'].includes(action.action_type) && route.travel_time_min > rules.max_walk_per_leg_min) return reject(action, `单段步行 ${route.travel_time_min} 分钟，超过偏好上限 ${rules.max_walk_per_leg_min} 分钟`, route);
  if (action.action_type === 'VISIT_POI' && queueMin > rules.max_queue_min) return reject(action, `预计排队 ${queueMin} 分钟，超过偏好上限 ${rules.max_queue_min} 分钟`, route);
  if (totalActionMin > Number(visitor.remaining_time_min || 0)) return reject(action, '动作耗时超过游客剩余时间', route);

  let returnRoute = null;
  if (action.action_type !== 'EXIT') {
    returnRoute = earliestExitRoute(graph, state, forecast, targetNodeId, completionTime, rules.preferred_exit_node_id);
    if (!returnRoute) return reject(action, '完成动作后无法到达出口', route);
    if (totalActionMin + returnRoute.travel_time_min + rules.return_buffer_min > Number(visitor.remaining_time_min || 0)) return reject(action, '动作后无法保留返回出口的必要时间', route);
  }

  return {
    legal: true,
    action: { ...action, target_node_id: targetNodeId },
    route,
    return_route: returnRoute,
    arrival_time: arrivalTime,
    service_start_time: serviceStartTime,
    completion_time: completionTime,
    predicted_queue_min: queueMin,
    predicted_crowd_ratio: crowdRatio,
    upward_trend_probability: upwardTrendProbability,
    crowd_prediction_source: crowdPredictionSource,
    wait_time_min: waitMin,
    duration_min: durationMin,
    total_action_time_min: Math.round(totalActionMin * 100) / 100
  };
}

function getLegalActions({ graph, state, forecast, visitor = state.visitor, rules = {}, excluded_target_ids = [], candidate_limit = 0, required_target_ids = [] }) {
  const legal = [];
  const rejected = [];
  for (const action of getCandidateActions(graph, state, { visitor, excluded_target_ids,
    candidate_limit, required_target_ids, forecast, rules })) {
    const evaluation = isActionLegal({ graph, state, forecast, action, visitor, rules });
    (evaluation.legal ? legal : rejected).push(evaluation);
  }
  const hasImmediateUsefulAction = legal.some(item => !['WAIT', 'EXIT'].includes(item.action.action_type));
  if (hasImmediateUsefulAction) {
    for (let i = legal.length - 1; i >= 0; i -= 1) {
      if (legal[i].action.action_type === 'WAIT') {
        rejected.push({ ...legal[i], legal: false, reason: '当前已有可立即执行的有效目标，无需等待' });
        legal.splice(i, 1);
      }
    }
  }
  return { legal, rejected };
}

function stepByRules({ graph, state, forecast, action, visitor = state.visitor, evaluation = null, rules: ruleOverrides = {}, compute_next_actions = true }) {
  const rules = mergeRules(ruleOverrides);
  const checked = evaluation || isActionLegal({ graph, state, forecast, action, visitor, rules });
  if (!checked.legal) throw new Error(`非法动作 ${actionId(action)}: ${checked.reason}`);
  const nextState = clone(state);
  const nextVisitor = clone(visitor);
  const walk = checked.route.travel_time_min;
  const queue = checked.predicted_queue_min;
  const elapsed = checked.total_action_time_min;
  nextState.timestamp = checked.completion_time;
  nextState.state_version = `${state.state_version || 'state'}_b${(visitor.action_count || 0) + 1}`;
  nextVisitor.current_node_id = checked.action.target_node_id;
  nextVisitor.remaining_time_min = Math.max(0, Math.round((Number(visitor.remaining_time_min || 0) - elapsed) * 100) / 100);
  nextVisitor.cumulative_walk_min = Math.round((Number(visitor.cumulative_walk_min || 0) + walk) * 100) / 100;
  nextVisitor.cumulative_queue_min = Math.round((Number(visitor.cumulative_queue_min || 0) + queue) * 100) / 100;
  nextVisitor.action_count = Number(visitor.action_count || 0) + 1;
  const fatigueDelta = walk * rules.fatigue_walk_per_min + queue * rules.fatigue_queue_per_min;
  const recovery = action.action_type === 'REST' ? checked.duration_min * rules.fatigue_rest_recovery_per_min : 0;
  nextVisitor.fatigue = Math.max(0, Math.min(1, Math.round((Number(visitor.fatigue || 0) + fatigueDelta - recovery) * 1000) / 1000));
  nextVisitor.visited_poi_ids = [...(visitor.visited_poi_ids || [])];
  nextVisitor.attended_event_ids = [...(visitor.attended_event_ids || [])];
  nextVisitor.visited_facility_ids = [...(visitor.visited_facility_ids || [])];
  if (action.action_type === 'VISIT_POI') nextVisitor.visited_poi_ids.push(action.target_id);
  if (action.action_type === 'ATTEND_EVENT') nextVisitor.attended_event_ids.push(action.target_id);
  if (action.action_type === 'REST') nextVisitor.visited_facility_ids.push(action.target_id);
  if (action.action_type === 'REST') nextVisitor.require_rest = false;
  nextState.visitor = nextVisitor;
  nextVisitor.missed_event_ids = (graph.events || [])
    .filter(event => event.latest_entry_time && toMillis(nextState.timestamp) > toMillis(event.latest_entry_time))
    .filter(event => !nextVisitor.attended_event_ids.includes(event.event_id))
    .map(event => event.event_id);
  const nextActions = action.action_type === 'EXIT' || !compute_next_actions
    ? { legal: [] }
    : getLegalActions({ graph, state: nextState, forecast, visitor: nextVisitor, rules });
  nextVisitor.next_legal_actions = nextActions.legal.map(item => item.action);
  nextVisitor.must_exit = action.action_type === 'EXIT'
    || nextVisitor.remaining_time_min <= rules.return_buffer_min
    || (compute_next_actions && !nextActions.legal.some(item => item.action.action_type !== 'EXIT'));
  return {
    state: nextState,
    visitor: nextVisitor,
    itinerary_item: {
      action_type: action.action_type,
      target_id: action.target_id,
      target_node_id: checked.action.target_node_id,
      visit_duration_min: checked.duration_min,
      arrival_time: checked.arrival_time,
      predicted_queue_min: checked.predicted_queue_min,
      predicted_crowd_ratio: checked.predicted_crowd_ratio,
      upward_trend_probability: checked.upward_trend_probability,
      crowd_prediction_source: checked.crowd_prediction_source,
      service_start_time: checked.service_start_time,
      completion_time: checked.completion_time,
      travel_time_min: checked.route.travel_time_min,
      wait_time_min: checked.wait_time_min,
      route: checked.route
    }
  };
}

module.exports = { getCandidateActions, isActionLegal, getLegalActions, stepByRules, earliestExitRoute };

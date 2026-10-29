'use strict';

const { mergeRules } = require('./config');
const { diffMinutes, toMillis } = require('./time');
const { getLegalActions, stepByRules } = require('./rules');

function definitionFor(graph, item) {
  if (item.action_type === 'VISIT_POI') return (graph.pois || []).find(x => x.poi_id === item.target_id);
  if (item.action_type === 'ATTEND_EVENT') return (graph.events || []).find(x => x.event_id === item.target_id);
  if (item.action_type === 'REST') return (graph.facilities || []).find(x => x.facility_id === item.target_id);
  if (item.action_type === 'EXIT') return (graph.exits || []).find(x => x.exit_id === item.target_id);
  return null;
}

function preferenceMatch(visitor, definition) {
  const preferences = new Set(visitor.preferred_categories || []);
  const categories = [definition?.category, ...(definition?.tags || [])].filter(Boolean);
  return categories.some(x => preferences.has(x)) ? 1 : 0;
}

function clamp01(value) { return Math.min(1, Math.max(0, Number(value || 0))); }

function preferenceFeatures(definition, evaluation, action) {
  const tags = new Set([definition?.category, ...(definition?.tags || [])].filter(Boolean));
  const totalMin = Number(evaluation.total_action_time_min || 0);
  return {
    time: clamp01(1 - totalMin / 75),
    interest: clamp01(Number(definition?.base_utility || 0) / 40),
    comfort: action.action_type === 'REST' ? 1 : clamp01(definition?.comfort_score ?? definition?.shade_score ?? .5),
    freedom: clamp01((tags.has('自由探索') ? 1 : 0) + (tags.has('互动') ? .5 : 0) + (tags.has('自然') ? .25 : 0)),
    culture: tags.has('历史文化') || tags.has('文化') || tags.has('宋文化') || tags.has('展陈') ? 1 : 0,
    nature: tags.has('自然') || tags.has('瀑布') || tags.has('视野') ? 1 : 0,
    performance: action.action_type === 'ATTEND_EVENT' || tags.has('演出') || tags.has('演艺') ? 1 : 0,
    food: tags.has('美食') || tags.has('市集') ? 1 : 0
  };
}

function preferenceFit(visitor, definition, evaluation, action) {
  const weights = visitor.preference_weights || {};
  const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0);
  if (!entries.length) return { value: preferenceMatch(visitor, definition), factors: {}, dominant: null };
  const factors = preferenceFeatures(definition, evaluation, action);
  const value = entries.reduce((sum, [key, weight]) => sum + Number(weight) * Number(factors[key] || 0), 0);
  const dominant = entries.map(([key, weight]) => ({ key, contribution: Number(weight) * Number(factors[key] || 0) })).sort((a, b) => b.contribution - a.contribution)[0]?.key || null;
  return { value: Math.round(value * 1000) / 1000, factors, dominant };
}

function scoreAction({ graph, visitor, evaluation, action, rules }) {
  const definition = definitionFor(graph, { ...action, action_type: action.action_type });
  const scoreRules = rules.score;
  const fit = preferenceFit(visitor, definition, evaluation, action);
  let score = Number(definition?.base_utility || 0) * .62;
  score += fit.value * scoreRules.preference_reward;
  const firstLegCost = Number(visitor.action_count || 0) === 0 ? Number(scoreRules.first_leg_walk_cost_per_min || 0) : 0;
  score -= evaluation.route.travel_time_min * (scoreRules.walk_cost_per_min + firstLegCost);
  score -= evaluation.predicted_queue_min * scoreRules.queue_cost_per_min;
  const crowdSensitivity = clamp01(visitor.preference_profile?.sensitivities?.crowd
    ?? Math.min(1, Number(visitor.preference_weights?.comfort || 0) * 2));
  const crowdRatio = clamp01(evaluation.predicted_crowd_ratio || 0);
  // Moderate crowd remains viable, while severe congestion gets a stronger
  // penalty; sensitivity comes from the visitor's explicit survey response.
  const crowdSeverity = crowdRatio ** 2 + Math.max(0, crowdRatio - .65) * 1.5;
  score -= crowdSeverity * scoreRules.crowd_cost_per_ratio * (0.35 + crowdSensitivity);
  score -= (evaluation.upward_trend_probability || 0) * scoreRules.crowd_trend_cost * (0.35 + crowdSensitivity);
  score -= evaluation.wait_time_min * scoreRules.wait_cost_per_min;
  score -= Number(visitor.fatigue || 0) * scoreRules.fatigue_cost;
  if (action.action_type === 'ATTEND_EVENT' && definition?.latest_entry_time) {
    const margin = diffMinutes(definition.latest_entry_time, evaluation.arrival_time);
    if (margin < 10) score -= (10 - margin) / 10 * scoreRules.late_risk_cost;
  }
  if (!Number(visitor.action_count || 0) && visitor.current_plan_next_target && visitor.current_plan_next_target !== action.target_id) score -= scoreRules.route_switch_cost;
  if (action.action_type === 'EXIT' && Number(visitor.remaining_time_min || 0) > Number(rules.return_buffer_min || 0) + 10) score -= scoreRules.early_exit_cost;
  if (action.action_type === 'WAIT') score -= 2;
  return Math.round(score * 100) / 100;
}

function usefulActionCount(itinerary) {
  return itinerary.filter(x => ['VISIT_POI', 'ATTEND_EVENT'].includes(x.action_type)).length;
}

// A route leg may physically pass through a later planned stop before the
// itinerary says to visit it. That makes the map look as if a numbered leg is
// missing or out of order. Prefer complete plans whose stops follow the
// actual traversal order of the shared Map1 graph.
function routeOrderConflictCount(itinerary = []) {
  const visits = itinerary.filter(item => ['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type));
  let conflicts = 0;
  for (let index = 0; index < visits.length - 1; index += 1) {
    const futureTargets = new Set(visits.slice(index + 1).map(item => item.target_node_id || item.target_id).filter(Boolean));
    const routeNodes = visits[index].route?.node_sequence || [];
    const crossed = new Set(routeNodes.slice(1, -1).filter(nodeId => futureTargets.has(nodeId)));
    conflicts += crossed.size;
  }
  return conflicts;
}

function actionSignature(action) { return `${action.action_type}:${action.target_id}`; }
function itinerarySignature(itinerary) { return itinerary.map(actionSignature).join('>'); }

function selectDiverseBeam(candidates, width) {
  const ordered = [...candidates].sort((a, b) => routeOrderConflictCount(a.itinerary) - routeOrderConflictCount(b.itinerary)
    || b.score - a.score || usefulActionCount(b.itinerary) - usefulActionCount(a.itinerary));
  const selected = [];
  const firstActions = new Set();
  for (const candidate of ordered) {
    const firstAction = candidate.itinerary[0] ? actionSignature(candidate.itinerary[0]) : '';
    if (!firstAction || firstActions.has(firstAction)) continue;
    firstActions.add(firstAction);
    selected.push(candidate);
    if (selected.length >= width) return selected;
  }
  const signatures = new Set(selected.map(candidate => itinerarySignature(candidate.itinerary)));
  for (const candidate of ordered) {
    const signature = itinerarySignature(candidate.itinerary);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    selected.push(candidate);
    if (selected.length >= width) break;
  }
  return selected;
}

function planReason(plan) {
  const first = plan.itinerary[0];
  if (!first) return '当前没有可执行动作';
  if (first.action_type === 'EXIT' && usefulActionCount(plan.itinerary) === 0) {
    const exitMinutes = Number(first.travel_time_min || first.route?.travel_time_min || 0);
    const duration = exitMinutes > 0 ? `（预计步行约 ${Math.round(exitMinutes)} 分钟）` : '';
    return `当前暂无可安排景点：剩余时间不足以安排游览并预留离园路程，已优先安排前往所选出口的离园路线${duration}。可延后离园时间，或选择离当前位置更近的出口后重新规划`;
  }
  if (first.action_type === 'EXIT') return '已安排当前可行景点，并预留安全离园路线';
  if (first.action_type === 'REST') return '当前疲劳或时间约束较强，先恢复体力并保留离园时间';
  if (first.action_type === 'WAIT' && usefulActionCount(plan.itinerary) > 0)
    return `当前尚未到景点开放时段，计划等待约 ${Math.round(first.visit_duration_min || 0)} 分钟后继续游览`;
  if (first.action_type === 'WAIT') return '暂时没有可立即游览的目标，等待后需按现场状态重新规划';
  const queueText = first.predicted_queue_min > 0 ? `，预计到达时排队 ${first.predicted_queue_min} 分钟` : '';
  const crowdText = Number.isFinite(first.predicted_crowd_ratio)
    ? `，模型模拟拥挤度约 ${Math.round(first.predicted_crowd_ratio * 100)}%，上升风险 ${Math.round((first.upward_trend_probability || 0) * 100)}%`
    : '';
  return `首选 ${first.target_id}${queueText}${crowdText}；方案已校验开放时间、道路状态、演出时间窗和返程余量`;
}

function candidateSummary(candidate) {
  const first = candidate.itinerary[0];
  return {
    score: Math.round(candidate.score * 100) / 100,
    plan_id: candidate.plan_id || null,
    next_action: first ? { action_type: first.action_type, target_id: first.target_id } : null,
    itinerary: candidate.itinerary,
    current_route: first?.route || { node_sequence: [], edge_sequence: [], total_distance_m: 0, travel_time_min: 0 },
    reason: planReason(candidate),
    score_breakdown: candidate.score_breakdown || { preference: 0, cost: 0 }
  };
}

function validateInputs(graph, state, forecast) {
  for (const [name, value] of [['ScenicGraph', graph], ['ScenicState', state], ['EnvironmentForecast', forecast]]) {
    if (!value || typeof value !== 'object') throw new Error(`${name} 不能为空`);
    if (!value.schema_version) throw new Error(`${name} 缺少 schema_version`);
    if (!value.scenario_id) throw new Error(`${name} 缺少 scenario_id`);
  }
  if (graph.scenario_id !== state.scenario_id || state.scenario_id !== forecast.scenario_id) throw new Error('graph/state/forecast 的 scenario_id 不一致');
  if (graph.schema_version !== state.schema_version || state.schema_version !== forecast.schema_version) throw new Error('graph/state/forecast 的 schema_version 不一致');
  if (!state.visitor?.current_node_id) throw new Error('ScenicState 缺少 visitor.current_node_id');
  const nodeIds = new Set((graph.nodes || []).map(node => node.node_id || node.id));
  const edgeIds = new Set((graph.edges || []).map(edge => edge.edge_id));
  if (nodeIds.size !== (graph.nodes || []).length) throw new Error('ScenicGraph 包含重复 node_id');
  if (edgeIds.size !== (graph.edges || []).length) throw new Error('ScenicGraph 包含重复或缺失 edge_id');
  if (!nodeIds.has(state.visitor.current_node_id)) throw new Error('visitor.current_node_id 不存在于 ScenicGraph');
  for (const edge of graph.edges || []) {
    if (!edge.edge_id || !nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) throw new Error(`道路 ${edge.edge_id || '(missing)'} 引用了不存在的节点`);
  }
  for (const item of [...(graph.pois || []), ...(graph.events || []), ...(graph.facilities || []), ...(graph.exits || [])]) {
    if (!nodeIds.has(item.node_id)) throw new Error(`业务对象 ${item.poi_id || item.event_id || item.facility_id || item.exit_id} 引用了不存在的节点`);
  }
  for (const edgeId of Object.keys(state.road_states || {})) {
    if (!edgeIds.has(edgeId)) throw new Error(`road_states 包含未知道路 ${edgeId}`);
  }
  for (const edgeId of Object.keys(forecast.road_predictions || {})) {
    if (!edgeIds.has(edgeId)) throw new Error(`road_predictions 包含未知道路 ${edgeId}`);
  }
}

const REPLAN_EVENTS = new Set(['SKIP_TARGET', 'REQUEST_REPLAN', 'POSITION_UPDATE', 'PROGRESS_UPDATE', 'POI_CLOSED', 'QUEUE_UPDATE', 'ROAD_CLOSED', 'ROAD_OPENED', 'EVENT_CANCELLED', 'EVENT_MISSED']);

function validateUserEvent(graph, state, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('UserEvent 必须是对象');
  if (!REPLAN_EVENTS.has(event.event_type)) throw new Error(`不支持的 UserEvent.event_type: ${event.event_type}`);
  const nodeIds = new Set((graph.nodes || []).map(node => node.node_id || node.id));
  const targetIds = new Set([...(graph.pois || []).map(x => x.poi_id), ...(graph.events || []).map(x => x.event_id), ...(graph.facilities || []).map(x => x.facility_id), ...(graph.exits || []).map(x => x.exit_id)]);
  const need = (field, value) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`UserEvent.${field} 为必填字符串`); };
  const finite = (field, value, min, max = Infinity) => { if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`UserEvent.${field} 必须在 ${min} 至 ${max} 之间`); };
  if (event.timestamp && !Number.isFinite(Date.parse(event.timestamp))) throw new Error('UserEvent.timestamp 不是有效时间');
  if (event.event_type === 'SKIP_TARGET') { need('target_id', event.target_id); if (!targetIds.has(event.target_id)) throw new Error(`UserEvent.target_id 不存在: ${event.target_id}`); }
  if (event.event_type === 'POI_CLOSED' || event.event_type === 'QUEUE_UPDATE') { need('target_id', event.target_id); if (!state.poi_states?.[event.target_id]) throw new Error(`UserEvent.target_id 不是已知景点: ${event.target_id}`); }
  if (event.event_type === 'QUEUE_UPDATE') finite('queue_min', event.queue_min, 0);
  if (['ROAD_CLOSED', 'ROAD_OPENED'].includes(event.event_type)) { need('edge_id', event.edge_id); if (!state.road_states?.[event.edge_id]) throw new Error(`UserEvent.edge_id 不是已知道路: ${event.edge_id}`); }
  if (['POSITION_UPDATE', 'PROGRESS_UPDATE'].includes(event.event_type)) { need('current_node_id', event.current_node_id); if (!nodeIds.has(event.current_node_id)) throw new Error(`UserEvent.current_node_id 不存在: ${event.current_node_id}`); }
  if (event.event_type === 'PROGRESS_UPDATE' && event.target_id !== undefined) {
    need('target_id', event.target_id);
    const target = (graph.pois || []).find(item => item.poi_id === event.target_id)
      || (graph.events || []).find(item => item.event_id === event.target_id)
      || (graph.facilities || []).find(item => item.facility_id === event.target_id);
    if (!target) throw new Error(`UserEvent.target_id 不是已知景点、活动或服务点: ${event.target_id}`);
    if (target.node_id !== event.current_node_id) throw new Error('PROGRESS_UPDATE 的 target_id 必须与 current_node_id 属于同一目的地');
  }
  if (event.event_type === 'PROGRESS_UPDATE') {
    if (event.remaining_time_min !== undefined) finite('remaining_time_min', event.remaining_time_min, 0);
    if (event.fatigue !== undefined) finite('fatigue', event.fatigue, 0, 1);
  }
  if (['EVENT_CANCELLED', 'EVENT_MISSED'].includes(event.event_type)) { need('target_id', event.target_id); if (!state.event_states?.[event.target_id]) throw new Error(`UserEvent.target_id 不是已知活动: ${event.target_id}`); }
}

function applyReplanEvent({ graph, state, forecast, event }) {
  validateUserEvent(graph, state, event);
  const nextState = JSON.parse(JSON.stringify(state));
  const nextForecast = JSON.parse(JSON.stringify(forecast));
  if (event.timestamp && toMillis(event.timestamp) > toMillis(nextState.timestamp)) {
    const elapsed = Math.max(0, diffMinutes(event.timestamp, nextState.timestamp));
    nextState.timestamp = event.timestamp;
    nextState.visitor.remaining_time_min = Math.max(0, Number(nextState.visitor.remaining_time_min || 0) - elapsed);
  }
  if (['POSITION_UPDATE', 'PROGRESS_UPDATE'].includes(event.event_type) && event.current_node_id) {
    const known = (graph.nodes || []).some(node => (node.node_id || node.id) === event.current_node_id);
    if (!known) throw new Error(`UserEvent.current_node_id 不存在: ${event.current_node_id}`);
    nextState.visitor.current_node_id = event.current_node_id;
  }
  if (event.event_type === 'PROGRESS_UPDATE') {
    if (event.remaining_time_min !== undefined) nextState.visitor.remaining_time_min = Math.max(0, Number(event.remaining_time_min));
    if (event.fatigue !== undefined) nextState.visitor.fatigue = Math.min(1, Math.max(0, Number(event.fatigue)));
    if (event.target_id) {
      if ((graph.pois || []).some(item => item.poi_id === event.target_id)) nextState.visitor.visited_poi_ids = [...new Set([...(nextState.visitor.visited_poi_ids || []), event.target_id])];
      else if ((graph.events || []).some(item => item.event_id === event.target_id)) nextState.visitor.attended_event_ids = [...new Set([...(nextState.visitor.attended_event_ids || []), event.target_id])];
      else nextState.visitor.visited_facility_ids = [...new Set([...(nextState.visitor.visited_facility_ids || []), event.target_id])];
    }
  }
  if (event.event_type === 'POI_CLOSED') {
    if (!nextState.poi_states?.[event.target_id]) throw new Error(`UserEvent.target_id 不是已知景点: ${event.target_id}`);
    nextState.poi_states[event.target_id].is_open = false;
  }
  if (event.event_type === 'QUEUE_UPDATE') {
    if (!nextState.poi_states?.[event.target_id]) throw new Error(`UserEvent.target_id 不是已知景点: ${event.target_id}`);
    const queueMin = Math.max(0, Number(event.queue_min));
    nextState.poi_states[event.target_id].current_queue_min = queueMin;
    const series = nextForecast.poi_predictions?.[event.target_id];
    if (Array.isArray(series)) for (const point of series) point.queue_min = Math.max(queueMin, Number(point.queue_min || 0));
  }
  if (['ROAD_CLOSED', 'ROAD_OPENED'].includes(event.event_type)) {
    if (!nextState.road_states?.[event.edge_id]) throw new Error(`UserEvent.edge_id 不是已知道路: ${event.edge_id}`);
    const available = event.event_type === 'ROAD_OPENED';
    nextState.road_states[event.edge_id].available = available;
    const series = nextForecast.road_predictions?.[event.edge_id];
    if (Array.isArray(series)) for (const point of series) point.available = available;
  }
  if (['EVENT_CANCELLED', 'EVENT_MISSED'].includes(event.event_type)) {
    if (!nextState.event_states?.[event.target_id]) throw new Error(`UserEvent.target_id 不是已知活动: ${event.target_id}`);
    nextState.event_states[event.target_id].cancelled = true;
    if (event.event_type === 'EVENT_MISSED') nextState.visitor.missed_event_ids = [...new Set([...(nextState.visitor.missed_event_ids || []), event.target_id])];
  }
  nextState.state_version = `${state.state_version || 'state'}_${event.event_type.toLowerCase()}`;
  nextForecast.forecast_version = `${forecast.forecast_version || 'forecast'}_${event.event_type.toLowerCase()}`;
  return { state: nextState, forecast: nextForecast };
}

function planItinerary({ graph, state, forecast, rules: ruleOverrides = {}, excluded_target_ids = [], ensure_alternatives = true, target_order = null }) {
  validateInputs(graph, state, forecast);
  const rules = mergeRules(ruleOverrides);
  if (target_order !== null && (!Array.isArray(target_order) || target_order.some(id => typeof id !== 'string' || (!graph.pois.some(poi => poi.poi_id === id) && !graph.nodes.some(node => node.node_id === id))) || new Set(target_order).size !== target_order.length))
    throw new Error('target_order 必须由不重复的已知 poi_id 或 node_id 组成');
  let beam = [{ state: JSON.parse(JSON.stringify(state)), itinerary: [], score: 0, score_breakdown: { preference: 0, cost: 0 }, ended: false }];
  const completed = [];
  const candidatePool = [];

  for (let depth = 0; depth < rules.max_actions; depth += 1) {
    const expanded = [];
    for (const candidate of beam) {
      if (candidate.ended) { completed.push(candidate); continue; }
      const requiredTarget = target_order?.[usefulActionCount(candidate.itinerary)];
      const requiredPoi = requiredTarget ? graph.pois.find(poi => poi.poi_id === requiredTarget) : null;
      const options = getLegalActions({ graph, state: candidate.state, forecast, visitor: candidate.state.visitor, rules, excluded_target_ids, candidate_limit: rules.planner_candidate_limit, required_target_ids: requiredTarget ? [requiredTarget] : [] });
      const legalActions = requiredTarget
        ? options.legal.filter(({ action }) => ['VISIT_POI', 'ATTEND_EVENT'].includes(action.action_type) && (action.target_id === requiredTarget || action.target_node_id === requiredTarget || action.target_node_id === requiredPoi?.node_id))
        : options.legal;
      for (const evaluation of legalActions) {
        const action = evaluation.action;
        // WAIT is a one-time recovery action inside a plan. Repeated WAIT
        // steps make a route look like several visits to the current node.
        if (action.action_type === 'WAIT' && candidate.itinerary.some(item => item.action_type === 'WAIT')) continue;
        if (action.action_type === 'EXIT' && candidate.state.visitor.require_rest === true && options.legal.some(x => x.action.action_type === 'REST')) continue;
        if (action.action_type === 'EXIT' && usefulActionCount(candidate.itinerary) < rules.min_actions && options.legal.some(x => !['EXIT', 'WAIT'].includes(x.action.action_type))) continue;
        const stepped = stepByRules({ graph, state: candidate.state, forecast, action, visitor: candidate.state.visitor, evaluation, rules, compute_next_actions: false });
        const actionScore = scoreAction({ graph, visitor: candidate.state.visitor, evaluation, action, rules });
        const definition = definitionFor(graph, action);
        const fit = preferenceFit(candidate.state.visitor, definition, evaluation, action);
        stepped.itinerary_item.preference_fit = fit.value;
        stepped.itinerary_item.preference_dominant_factor = fit.dominant;
        stepped.itinerary_item.action_score = actionScore;
        expanded.push({
          state: stepped.state,
          itinerary: [...candidate.itinerary, stepped.itinerary_item],
          score: candidate.score + actionScore,
          score_breakdown: {
            preference: Math.round((candidate.score_breakdown.preference + fit.value * rules.score.preference_reward) * 100) / 100,
            cost: Math.round((candidate.score_breakdown.cost + actionScore - fit.value * rules.score.preference_reward) * 100) / 100
          },
          ended: action.action_type === 'EXIT'
        });
      }
    }
    if (!expanded.length) break;
    candidatePool.push(...expanded);
    beam = selectDiverseBeam(expanded, rules.beam_width);
  }
  completed.push(...beam);
  candidatePool.push(...completed);
  const minimumUseful = Math.max(0, Math.min(Number(rules.min_actions) || 0, Number(rules.max_actions) || 0));
  const readyOrder = (a, b) => {
    const aReady = usefulActionCount(a.itinerary) >= minimumUseful ? 1 : 0;
    const bReady = usefulActionCount(b.itinerary) >= minimumUseful ? 1 : 0;
    return bReady - aReady || b.score - a.score || usefulActionCount(b.itinerary) - usefulActionCount(a.itinerary);
  };
  // Select an actual day plan, not the highest-scoring early prefix. Prefer
  // candidates that reach an exit, then maximize useful stops and finally use
  // the remaining visit window before comparing utility scores.
  const allExitPlans = candidatePool.filter(candidate => candidate.ended
    && candidate.itinerary.at(-1)?.action_type === 'EXIT');
  const terminalPool = allExitPlans.filter(candidate => rules.preferred_exit_node_id
    || usefulActionCount(candidate.itinerary) >= minimumUseful);
  // If the requested minimum cannot be met, return the best safe completed
  // route (possibly an exit recommendation) instead of an unfinished WAIT prefix.
  const selectablePool = terminalPool.length ? terminalPool
    : target_order ? (rules.preferred_exit_node_id ? [] : candidatePool)
      : allExitPlans.length ? allExitPlans : rules.preferred_exit_node_id ? [] : candidatePool;
  const fullDayOrder = (a, b) => {
    const usefulDifference = usefulActionCount(b.itinerary) - usefulActionCount(a.itinerary);
    if (usefulDifference) return usefulDifference;
    const orderDifference = routeOrderConflictCount(a.itinerary) - routeOrderConflictCount(b.itinerary);
    if (orderDifference) return orderDifference;
    // Compare the complete day, not only its first attractive stop. The old
    // first-action tie-break could select a route that repeatedly crossed the
    // park even when a geographically continuous route had higher total value.
    const wholePlanDifference = Number(b.score || 0) - Number(a.score || 0);
    if (Math.abs(wholePlanDifference) > .01) return wholePlanDifference;
    const qualityDifference = readyOrder(a, b);
    if (qualityDifference) return qualityDifference;
    return Number(a.state.visitor.remaining_time_min || 0) - Number(b.state.visitor.remaining_time_min || 0);
  };
  selectablePool.sort(fullDayOrder);
  const main = selectablePool.find(candidate => candidate.itinerary.length) || { itinerary: [], score: 0, score_breakdown: { preference: 0, cost: 0 }, state };
  const alternatePool = selectablePool.filter(candidate => candidate !== main && candidate.itinerary.length && usefulActionCount(candidate.itinerary) >= minimumUseful);
  alternatePool.sort((a, b) => {
    const aDifferentFirst = actionSignature(a.itinerary[0]) !== actionSignature(main.itinerary[0]) ? 1 : 0;
    const bDifferentFirst = actionSignature(b.itinerary[0]) !== actionSignature(main.itinerary[0]) ? 1 : 0;
    return routeOrderConflictCount(a.itinerary) - routeOrderConflictCount(b.itinerary)
      || bDifferentFirst - aDifferentFirst || b.score - a.score;
  });
  const alternatives = [];
  const signatures = new Set([itinerarySignature(main.itinerary)]);
  for (const candidate of alternatePool) {
    const signature = itinerarySignature(candidate.itinerary);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    alternatives.push(candidate);
    if (alternatives.length >= 3) break;
  }
  if (!alternatives.length && ensure_alternatives && main.itinerary[0]?.target_id) {
    const fallback = planItinerary({
      graph,
      state,
      forecast,
      rules: ruleOverrides,
      excluded_target_ids: [...new Set([...excluded_target_ids, main.itinerary[0].target_id])],
      ensure_alternatives: false,
      target_order
    });
    if (fallback.feasible && fallback.diagnostics.useful_action_count >= minimumUseful) {
      const alternative = {
        plan_id: fallback.plan_id.replace('_main_', '_alt1_'),
        score: fallback.score,
        next_action: fallback.next_action,
        itinerary: fallback.itinerary,
        current_route: fallback.current_route,
        reason: fallback.reason,
        score_breakdown: fallback.score_breakdown
      };
      if (itinerarySignature(alternative.itinerary) !== itinerarySignature(main.itinerary)) alternatives.push(alternative);
    }
  }
  const basePlanId = `plan_${state.state_version || 'state'}`;
  main.plan_id = `${basePlanId}_main_${main.itinerary.map(item => item.target_id).join('_') || 'none'}`;
  alternatives.forEach((candidate, index) => { candidate.plan_id = `${basePlanId}_alt${index + 1}_${candidate.itinerary.map(item => item.target_id).join('_')}`; });
  const summary = candidateSummary(main);
  const specifiedExitUnavailable = Boolean(rules.preferred_exit_node_id && !main.itinerary.length);
  return {
    schema_version: graph.schema_version,
    scenario_id: state.scenario_id,
    plan_id: summary.plan_id,
    based_on_state_version: state.state_version,
    based_on_forecast_version: forecast.forecast_version,
    generated_at: state.timestamp,
    next_action: summary.next_action,
    itinerary: summary.itinerary,
    current_route: summary.current_route,
    score: summary.score,
    score_breakdown: summary.score_breakdown,
    alternative_plans: alternatives.map(candidateSummary),
    alternative_status: alternatives.length ? 'available' : 'none_feasible',
    alternative_message: specifiedExitUnavailable ? '无法在当前离园时间前到达指定出口，请更换出口或调整离园时间' : alternatives.length ? null : '当前约束下没有其他满足最少游览步数且不同于主方案的可执行方案',
    reason: specifiedExitUnavailable ? '指定离园出口不可达' : summary.reason,
    feasible: main.itinerary.length > 0 && (!target_order || usefulActionCount(main.itinerary) === target_order.length),
    diagnostics: {
      used_arrival_time_forecast: true,
      planned_action_count: main.itinerary.length,
      useful_action_count: usefulActionCount(main.itinerary),
      minimum_useful_actions: minimumUseful,
      satisfies_minimum_actions: usefulActionCount(main.itinerary) >= minimumUseful,
      rules_version: 'b-rules-0.2',
      alternative_count: alternatives.length,
      preference_weights_applied: Boolean(Object.keys(state.visitor.preference_weights || {}).length),
      planned_end_time: main.state.timestamp,
      unallocated_time_min: Math.round(Number(main.state.visitor.remaining_time_min || 0) * 100) / 100,
      reaches_exit: main.ended === true
    }
  };
}

function promoteAlternative(planResult, selectedPlanId) {
  if (planResult.plan_id === selectedPlanId) return { ...planResult, selected_plan_id: selectedPlanId };
  const selected = (planResult.alternative_plans || []).find(plan => plan.plan_id === selectedPlanId);
  if (!selected) throw new Error(`当前规划结果中不存在备选方案 ${selectedPlanId}`);
  const previousMain = {
    plan_id: planResult.plan_id,
    score: planResult.score,
    next_action: planResult.next_action,
    itinerary: planResult.itinerary,
    current_route: planResult.current_route,
    reason: planResult.reason,
    score_breakdown: planResult.score_breakdown
  };
  const remaining = (planResult.alternative_plans || []).filter(plan => plan.plan_id !== selectedPlanId);
  return {
    ...planResult,
    ...selected,
    plan_id: selected.plan_id,
    selected_plan_id: selected.plan_id,
    alternative_plans: [previousMain, ...remaining],
    alternative_status: 'available',
    alternative_message: null,
    reason: `${selected.reason}；已按你的选择切换方案`
  };
}

function replan({ graph, state, forecast, event, rules = {} }) {
  if (!event?.event_type) throw new Error('UserEvent 缺少 event_type');
  if (event.scenario_id && event.scenario_id !== state.scenario_id) throw new Error('UserEvent 与 ScenicState 的 scenario_id 不一致');
  if (event.schema_version && event.schema_version !== state.schema_version) throw new Error('UserEvent 与 ScenicState 的 schema_version 不一致');
  const applied = applyReplanEvent({ graph, state, forecast, event });
  const excluded = event.event_type === 'SKIP_TARGET' && event.target_id ? [event.target_id] : [];
  const result = planItinerary({ graph, state: applied.state, forecast: applied.forecast, rules, excluded_target_ids: excluded });
  result.replan = { trigger: event.event_type, event_timestamp: event.timestamp || state.timestamp, from_node_id: applied.state.visitor.current_node_id };
  return result;
}

module.exports = { planItinerary, replan, validateInputs, validateUserEvent, scoreAction, preferenceFit, routeOrderConflictCount, applyReplanEvent, promoteAlternative, REPLAN_EVENTS };

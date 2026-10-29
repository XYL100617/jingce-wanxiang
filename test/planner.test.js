'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RULES } = require('../server/planner/config');
const {
  createMockScenario,
  findPath,
  getLegalActions,
  isActionLegal,
  planItinerary,
  replan,
  stepByRules
} = require('../server/planner');
const { routeOrderConflictCount, scoreAction } = require('../server/planner/planner');

test('正常场景生成多步、可解释且可供 C 直接展示的 PlanResult', () => {
  const scenario = createMockScenario('normal');
  const plan = planItinerary(scenario);
  assert.equal(plan.schema_version, '0.1');
  assert.equal(plan.feasible, true);
  assert.ok(plan.itinerary.length >= 2);
  assert.ok(plan.next_action?.target_id);
  assert.ok(plan.current_route.node_sequence.length >= 1);
  assert.ok(plan.current_route.edge_sequence.every(Boolean));
  assert.ok(plan.alternative_plans.length >= 1);
  assert.equal(plan.based_on_state_version, scenario.state.state_version);
  assert.equal(plan.based_on_forecast_version, scenario.forecast.forecast_version);
  assert.equal(plan.diagnostics.used_arrival_time_forecast, true);
});

test('首段步行距离对起点附近景点有额外权重，后续路段不重复加罚', () => {
  const scenario = createMockScenario('normal');
  const action = { action_type: 'VISIT_POI', target_id: 'poi_history', target_node_id: 'node_history' };
  const evaluation = isActionLegal({ ...scenario, action });
  assert.equal(evaluation.legal, true);
  const firstVisitor = { ...scenario.state.visitor, action_count: 0 };
  const laterVisitor = { ...scenario.state.visitor, action_count: 1 };
  const firstScore = scoreAction({ ...scenario, visitor: firstVisitor, evaluation, action, rules: DEFAULT_RULES });
  const laterScore = scoreAction({ ...scenario, visitor: laterVisitor, evaluation, action, rules: DEFAULT_RULES });
  const expectedPenalty = evaluation.route.travel_time_min * DEFAULT_RULES.score.first_leg_walk_cost_per_min;
  assert.ok(Math.abs((laterScore - firstScore) - expectedPenalty) < 0.02);
});

test('DNA 指定顺序必须逐个命中模板景点；目标不可用时不返回错误的完整路线', () => {
  const scenario = createMockScenario('normal');
  const targetOrder = ['poi_history', 'poi_garden'];
  const plan = planItinerary({ ...scenario, target_order: targetOrder, rules: { min_actions: 2, max_actions: 2 }, ensure_alternatives: false });
  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.itinerary.filter(item => ['VISIT_POI', 'ATTEND_EVENT'].includes(item.action_type)).map(item => item.target_id), targetOrder);

  const unavailable = createMockScenario('normal');
  unavailable.graph.pois.find(poi => poi.poi_id === 'poi_garden').close_time = '2026-10-20 10:00:00';
  const partial = planItinerary({ ...unavailable, target_order: targetOrder, rules: { min_actions: 2, max_actions: 2 }, ensure_alternatives: false });
  assert.equal(partial.feasible, false);
  assert.equal(partial.diagnostics.useful_action_count, 1);
});

test('选填离园出口约束返程校验和最终离园目标，未指定时保持原有规划', () => {
  const scenario = createMockScenario('normal');
  scenario.graph.nodes.push({ node_id: 'node_west_exit', node_type: 'exit', algorithm_x: 12, algorithm_y: 3 });
  scenario.graph.edges.push({ edge_id: 'edge_theater_west_exit', from_node_id: 'node_theater', to_node_id: 'node_west_exit', distance_m: 160, base_travel_time_min: 3, bidirectional: true });
  scenario.graph.exits.push({ exit_id: 'exit_west', node_id: 'node_west_exit' });
  const preferred = planItinerary({ ...scenario, rules: { preferred_exit_node_id: 'node_west_exit' } });
  assert.equal(preferred.feasible, true);
  assert.equal(preferred.itinerary.at(-1).action_type, 'EXIT');
  assert.equal(preferred.itinerary.at(-1).target_node_id, 'node_west_exit');
  assert.ok(preferred.alternative_plans.every(plan => plan.itinerary.at(-1)?.target_node_id === 'node_west_exit'));
  const wrongExit = isActionLegal({ ...scenario, action: { action_type: 'EXIT', target_id: 'exit_main', target_node_id: 'node_exit' }, rules: { preferred_exit_node_id: 'node_west_exit' } });
  assert.equal(wrongExit.legal, false);
  assert.match(wrongExit.reason, /指定离园出口/);
  const automatic = planItinerary(scenario);
  assert.equal(automatic.feasible, true);
  assert.ok(scenario.graph.exits.some(exitNode => exitNode.node_id === automatic.itinerary.at(-1).target_node_id));
});

test('规则推进使用预计到达时刻的排队，而不是当前排队', () => {
  const scenario = createMockScenario('normal');
  const action = { action_type: 'VISIT_POI', target_id: 'poi_history', target_node_id: 'node_history' };
  const evaluation = isActionLegal({ ...scenario, action });
  assert.equal(evaluation.legal, true);
  assert.ok(evaluation.predicted_queue_min > scenario.state.poi_states.poi_history.current_queue_min);
  const stepped = stepByRules({ ...scenario, action, evaluation });
  assert.equal(stepped.visitor.current_node_id, 'node_history');
  assert.ok(stepped.visitor.visited_poi_ids.includes('poi_history'));
  assert.equal(stepped.visitor.cumulative_queue_min, evaluation.predicted_queue_min);
  assert.ok(Array.isArray(stepped.visitor.next_legal_actions));
  assert.ok(Array.isArray(stepped.visitor.missed_event_ids));
});

test('排队突增会改变首个游览目标', () => {
  const normalScenario = createMockScenario('normal');
  const surgeScenario = createMockScenario('queue_surge');
  // Start after the simulated spike begins so it affects this visit's ETA.
  normalScenario.state.timestamp = '2026-10-20 10:12:00';
  surgeScenario.state.timestamp = '2026-10-20 10:12:00';
  const normal = planItinerary(normalScenario);
  const surge = planItinerary(surgeScenario);
  assert.equal(normal.next_action.target_id, 'poi_history');
  assert.notEqual(surge.next_action.target_id, normal.next_action.target_id);
});

test('同等景点在人流敏感权重较高时会更强烈地避开高拥挤与上升趋势', () => {
  const scenario = createMockScenario('normal');
  const action = { action_type: 'VISIT_POI', target_id: 'poi_history' };
  const evaluation = { route: { travel_time_min: 1 }, predicted_queue_min: 0,
    predicted_crowd_ratio: .95, upward_trend_probability: .8, wait_time_min: 0 };
  const lowSensitivity = { ...scenario.state.visitor, preference_weights: { comfort: .1 },
    preference_profile: { sensitivities: { crowd: 0 } } };
  const highSensitivity = { ...scenario.state.visitor, preference_weights: { comfort: .1 },
    preference_profile: { sensitivities: { crowd: 1 } } };
  const lowScore = scoreAction({ graph: scenario.graph, visitor: lowSensitivity, evaluation, action, rules: DEFAULT_RULES });
  const highScore = scoreAction({ graph: scenario.graph, visitor: highSensitivity, evaluation, action, rules: DEFAULT_RULES });
  assert.ok(highScore < lowScore - 5);
});

test('路线顺序评分识别“先穿过后续景点、再回头编号”的规划冲突', () => {
  const outOfOrder = [
    { action_type: 'VISIT_POI', target_id: 'shenboat', target_node_id: 'shenboat', route: { node_sequence: ['gate', 'shenboat'] } },
    { action_type: 'VISIT_POI', target_id: 'theater', target_node_id: 'theater', route: { node_sequence: ['shenboat', 'gate', 'market', 'water_street', 'theater'] } },
    { action_type: 'VISIT_POI', target_id: 'market', target_node_id: 'market', route: { node_sequence: ['theater', 'market'] } },
    { action_type: 'VISIT_POI', target_id: 'water_street', target_node_id: 'water_street', route: { node_sequence: ['market', 'water_street'] } }
  ];
  const traversalOrder = [
    outOfOrder[0],
    { ...outOfOrder[2], route: { node_sequence: ['shenboat', 'gate', 'market'] } },
    { ...outOfOrder[3], route: { node_sequence: ['market', 'water_street'] } },
    { ...outOfOrder[1], route: { node_sequence: ['water_street', 'theater'] } }
  ];
  assert.equal(routeOrderConflictCount(outOfOrder), 2);
  assert.equal(routeOrderConflictCount(traversalOrder), 0);
});

test('道路关闭后 A* 移除关闭边并绕行', () => {
  const scenario = createMockScenario('road_closure');
  const path = findPath({
    ...scenario,
    startNodeId: 'node_gate',
    goalNodeId: 'node_garden',
    departureTime: scenario.state.timestamp
  });
  assert.equal(path.reachable, true);
  assert.ok(!path.edge_sequence.includes('edge_gate_garden'));
  assert.equal(path.node_sequence[0], 'node_gate');
  assert.equal(path.node_sequence.at(-1), 'node_garden');
  assert.ok(path.node_sequence.length > 2);
});

test('超过最晚入场时间的演出会被明确拒绝', () => {
  const scenario = createMockScenario('normal');
  scenario.state.timestamp = '2026-10-20 11:03:00';
  const result = isActionLegal({
    ...scenario,
    action: { action_type: 'ATTEND_EVENT', target_id: 'event_show', target_node_id: 'node_theater' }
  });
  assert.equal(result.legal, false);
  assert.match(result.reason, /最晚入场/);
});

test('没有可行景点时仍返回等待、休息或离园，不返回空结果', () => {
  const scenario = createMockScenario('normal');
  scenario.state.poi_states.poi_history.is_open = false;
  scenario.state.poi_states.poi_garden.is_open = false;
  scenario.state.event_states.event_show.cancelled = true;
  scenario.state.visitor.visited_facility_ids = ['facility_rest'];
  scenario.state.visitor.remaining_time_min = 12;
  const plan = planItinerary({ ...scenario, rules: { min_actions: 0, max_actions: 1 } });
  assert.equal(plan.feasible, true);
  assert.ok(['WAIT', 'EXIT'].includes(plan.next_action.action_type));
});

test('剩余时间内没有开放目标时返回单条离园建议，不重复生成当前节点等待', () => {
  const scenario = createMockScenario('normal');
  for (const poi of scenario.graph.pois) scenario.state.poi_states[poi.poi_id].is_open = false;
  for (const event of scenario.graph.events) scenario.state.event_states[event.event_id].cancelled = true;
  scenario.state.visitor.current_node_id = 'node_gate';
  scenario.state.visitor.remaining_time_min = 47;
  const plan = planItinerary(scenario);
  assert.equal(plan.next_action.action_type, 'EXIT');
  assert.equal(plan.itinerary.filter(item => item.action_type === 'WAIT').length, 0);
  assert.equal(plan.itinerary.filter(item => item.action_type === 'EXIT').length, 1);
  assert.equal(plan.diagnostics.useful_action_count, 0);
  assert.match(plan.reason, /暂无可安排景点/);
});

test('SKIP_TARGET 从游客当前位置滚动重规划并排除被跳过目标', () => {
  const scenario = createMockScenario('normal');
  scenario.state.visitor.current_node_id = 'node_garden';
  scenario.state.timestamp = '2026-10-20 10:20:00';
  const plan = replan({
    ...scenario,
    event: { schema_version: '0.1', scenario_id: scenario.state.scenario_id, event_type: 'SKIP_TARGET', target_id: 'poi_history', timestamp: scenario.state.timestamp }
  });
  assert.notEqual(plan.next_action.target_id, 'poi_history');
  assert.equal(plan.current_route.node_sequence[0], 'node_garden');
});

test('合法性接口同时返回合法动作和拒绝原因', () => {
  const scenario = createMockScenario('normal');
  const result = getLegalActions(scenario);
  assert.ok(result.legal.length > 0);
  assert.ok(Array.isArray(result.rejected));
});

test('契约检查拒绝未知道路ID，避免 A/B 私有ID混用', () => {
  const scenario = createMockScenario('normal');
  scenario.state.road_states.edge_private = { available: true, travel_time_min: 1 };
  assert.throws(() => planItinerary(scenario), /未知道路/);
});

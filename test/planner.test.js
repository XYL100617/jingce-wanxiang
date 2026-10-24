'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMockScenario,
  findPath,
  getLegalActions,
  isActionLegal,
  planItinerary,
  replan,
  stepByRules
} = require('../server/planner');

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
  const normal = planItinerary(createMockScenario('normal'));
  const surge = planItinerary(createMockScenario('queue_surge'));
  assert.equal(normal.next_action.target_id, 'poi_history');
  assert.notEqual(surge.next_action.target_id, normal.next_action.target_id);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inferPreference } = require('../server/preference-engine');

test('前端八维权重在首次访问的 null 偏好状态下使用安全默认值', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /p && typeof p === 'object' \? p : \{ time:/);
  assert.match(source, /weights\[b\[0\]\]/);
  assert.doesNotMatch(source, /function renderVector\(p = app\.data\?\.user\.preference/);
});
test('所有地图1 POI都有简短解说，并区分公开参考与项目图演示', () => {
  const graph = require('../server/data/scenic_graph.json');
  const pack = require('../public/poi-briefings.json');
  const poiIds = graph.nodes.filter(node => node.poi_id).map(node => node.node_id);
  assert.deepEqual(Object.keys(pack.briefings).sort(), poiIds.sort());
  assert.ok(pack.source.url.startsWith('https://'));
  assert.equal(pack.source.type, 'secondary_reference');
  assert.equal(pack.project_map_source.type, 'project_demo_unverified');
  for (const [nodeId, entry] of Object.entries(pack.briefings)) {
    assert.ok(poiIds.includes(nodeId), `解说节点 ${nodeId} 必须是地图1中的 POI`);
    assert.ok(entry.text.length <= 110, `${nodeId} 解说应简短`);
    assert.ok(['public_reference', 'project_map_demo', 'creative_story'].includes(entry.mode), `${nodeId} 必须标明解说依据类别`);
    if (entry.mode === 'public_reference') assert.ok(entry.source_excerpt, `${nodeId} 公开参考解说需记录依据`);
    if (entry.mode === 'project_map_demo') assert.match(entry.text, /项目地图/);
    if (entry.mode === 'creative_story') assert.ok(entry.text.length >= 25, `${nodeId} 故事化解说应有完整内容`);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /poiBriefingHtml\(item\.target_node_id/);
  assert.match(source, /poi-briefings\.json/);
  assert.match(source, /creative_story/);
  assert.match(source, /文学化导览，不代表历史事实或当日活动安排/);
});
const { createMockScenario, planItinerary, replan } = require('../server/planner');

test('完整问卷生成归一化的八维连续权重和可解释约束', () => {
  const result = inferPreference({
    type: 'normal', group: 'family', mobility: 'light', interests: ['culture', 'performance'],
    queue_tolerance: 1, walking_tolerance: 2, schedule_preference: 4, depth_preference: 5,
    crowd_sensitivity: 5, novelty_preference: 2, rest_need: 4, photo_preference: 2
  });
  assert.equal(result.questionnaire_version, '0.2');
  assert.equal(Object.keys(result.weights).length, 8);
  assert.ok(Math.abs(Object.values(result.weights).reduce((a, b) => a + b, 0) - 1) < .001);
  assert.ok(result.weights.comfort > result.weights.food);
  assert.equal(result.constraints.max_walk_per_leg_min, 14);
  assert.equal(result.constraints.require_rest, true);
  assert.equal(result.profile.confidence, 100);
  assert.equal(result.profile.sensitivities.crowd, 1);
  assert.equal(result.planner_rules.score.crowd_cost_per_ratio, 18);
  assert.ok(result.explanation.length > 0);
});

test('不同问卷答案产生显著不同的权重画像', () => {
  const efficient = inferPreference({ type: 'fast', interests: ['performance'], queue_tolerance: 1, schedule_preference: 5 });
  const explorer = inferPreference({ type: 'free', interests: ['nature', 'photo'], walking_tolerance: 5, novelty_preference: 5 });
  assert.ok(efficient.weights.time > explorer.weights.time);
  assert.ok(explorer.weights.freedom > efficient.weights.freedom);
  assert.ok(explorer.weights.nature > efficient.weights.nature);
});

test('连续偏好权重直接改变规划器的目标选择', () => {
  const culture = createMockScenario('normal');
  culture.state.visitor.preference_weights = { culture: .9, time: .1 };
  const nature = createMockScenario('normal');
  nature.state.visitor.preference_weights = { nature: .9, time: .1 };
  const rules = { max_actions: 1, min_actions: 1, score: { preference_reward: 55 } };
  assert.equal(planItinerary({ ...culture, rules }).next_action.target_id, 'poi_history');
  assert.equal(planItinerary({ ...nature, rules }).next_action.target_id, 'poi_garden');
});

test('ROAD_CLOSED 事件写入状态与预测后再从当前位置重规划', () => {
  const scenario = createMockScenario('normal');
  const edgeId = 'edge_gate_garden';
  const plan = replan({
    ...scenario,
    event: { schema_version: '0.1', scenario_id: scenario.state.scenario_id, event_type: 'ROAD_CLOSED', edge_id: edgeId, timestamp: scenario.state.timestamp }
  });
  assert.equal(plan.replan.trigger, 'ROAD_CLOSED');
  assert.ok(!plan.current_route.edge_sequence.includes(edgeId));
  assert.match(plan.based_on_state_version, /road_closed/);
});

test('POI_CLOSED、QUEUE_UPDATE 和进度偏差事件均可统一触发重规划', () => {
  const closed = createMockScenario('normal');
  const closedPlan = replan({ ...closed, event: { event_type: 'POI_CLOSED', target_id: 'poi_history', scenario_id: closed.state.scenario_id } });
  assert.notEqual(closedPlan.next_action.target_id, 'poi_history');

  const queue = createMockScenario('normal');
  const queuePlan = replan({ ...queue, event: { event_type: 'QUEUE_UPDATE', target_id: 'poi_history', queue_min: 80, scenario_id: queue.state.scenario_id } });
  assert.notEqual(queuePlan.next_action.target_id, 'poi_history');

  const progress = createMockScenario('normal');
  const progressPlan = replan({ ...progress, event: { event_type: 'PROGRESS_UPDATE', current_node_id: 'node_garden', remaining_time_min: 80, fatigue: .7, scenario_id: progress.state.scenario_id } });
  assert.equal(progressPlan.replan.from_node_id, 'node_garden');
});

test('协作契约和请求样例均为有效 JSON，事件样例覆盖关键重规划类型', () => {
  const root = path.resolve(__dirname, '..');
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/b-planner.schema.json'), 'utf8'));
  const preference = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/examples/preference-request.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/examples/user-events.json'), 'utf8'));
  assert.equal(schema.$defs.UserEvent.allOf[1].properties.event_type.enum.includes('ROAD_CLOSED'), true);
  assert.equal(preference.answers.interests.length >= 2, true);
  assert.deepEqual(new Set(events.map(item => item.event_type)), new Set(['SKIP_TARGET', 'QUEUE_UPDATE', 'ROAD_CLOSED', 'PROGRESS_UPDATE']));
});

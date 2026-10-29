'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { predictEnvironment } = require('../server/state/forecastSimulator');
const { buildLivePlannerScenario, planItinerary } = require('../server/planner');
const { inferPreference } = require('../server/preference-engine');
const applicationCrowd = require('../server/world-model/application-crowd');
const { updateEnvironment } = require('../server/index');

test('A canonical graph, state and forecast feed B planner without remapping IDs', () => {
  const graph = provider.getScenicGraph();
  const state = provider.getState();
  const original = provider.getState();
  state.road_states.edge_002.available = false;
  state.poi_states.lake.open = false;
  const preferenceProfile = inferPreference({ type: 'normal', interests: ['culture', 'nature'], mobility: 'normal' });
  const scenario = buildLivePlannerScenario(
    graph,
    state,
    { preferenceProfile, currentPlanNextTarget: 'museum' },
    predictEnvironment(state, 240, 10)
  );

  assert.deepEqual(scenario.graph.edges.map(edge => edge.edge_id), graph.edges.map(edge => edge.edge_id));
  assert.equal(scenario.state.scenario_id, state.scenario_id);
  assert.equal(scenario.state.road_states.edge_002.available, false);
  assert.equal(scenario.state.poi_states.lake.is_open, false);
  assert.equal(scenario.forecast.base_timestamp, state.timestamp);
  assert.equal(scenario.state.visitor.current_plan_next_target, 'museum');
  assert.deepEqual(scenario.state.visitor.preference_weights, preferenceProfile.weights);

  const plan = planItinerary(scenario);
  assert.equal(plan.feasible, true);
  assert.equal(plan.based_on_state_version, state.state_version);
  assert.ok(!plan.itinerary.some(step => step.action_type === 'VISIT_POI' && step.target_id === 'lake'));
  assert.ok(!plan.current_route.edge_sequence.includes('edge_002'));
  assert.equal(provider.getState().road_states.edge_002.available, original.road_states.edge_002.available);
});

test('Map1 early-start recommendation waits once for opening, then plans connected POIs before upcoming shows', () => {
  const graph = provider.getScenicGraph();
  const state = provider.getState();
  state.timestamp = '2026-10-20 06:17:00';
  state.visitor.current_node_id = 'shizipo';
  state.visitor.remaining_time_min = 553;
  const preferenceProfile = inferPreference({ type: 'normal', interests: ['culture', 'nature'], crowd_sensitivity: 3 });
  const baseForecast = predictEnvironment(state, 600, 10);
  const learnedCrowd = applicationCrowd.predictApplicationCrowd(graph, state, predictEnvironment(state, 60, 5));
  const forecast = applicationCrowd.blendCrowdIntoForecast(baseForecast, learnedCrowd.distribution);
  const scenario = buildLivePlannerScenario(graph, state, { preferenceProfile }, forecast);
  const plan = planItinerary({ ...scenario, rules: { ...preferenceProfile.planner_rules, max_actions: 10 } });

  assert.equal(plan.itinerary[0].action_type, 'WAIT');
  assert.equal(plan.itinerary[0].visit_duration_min, 163);
  assert.ok(plan.diagnostics.useful_action_count >= 2);
  assert.equal(plan.itinerary.filter(item => item.action_type === 'WAIT').length, 1);
  assert.equal(plan.itinerary.at(-1).action_type, 'EXIT');
  for (const item of plan.itinerary) {
    assert.ok(item.route.node_sequence.every(id => graph.nodes.some(node => node.node_id === id)), item.target_id);
    assert.ok(item.route.edge_sequence.every(id => graph.edges.some(edge => edge.edge_id === id)), item.target_id);
    if (item.action_type === 'ATTEND_EVENT') assert.ok(item.wait_time_min <= 20, item.target_id);
  }
});

test('live simulation repairs runaway road times without reopening a closed road', () => {
  const original = provider.getState();
  const graph = provider.getScenicGraph();
  try {
    const damaged = provider.getState();
    for (const edge of graph.edges) damaged.road_states[edge.edge_id].travel_time_min = edge.base_travel_time_min * 10000;
    damaged.road_states.edge_001.available = false;
    provider.setState(damaged);
    updateEnvironment();
    const repaired = provider.getState();
    assert.equal(repaired.road_states.edge_001.available, false);
    for (const edge of graph.edges) assert.ok(repaired.road_states[edge.edge_id].travel_time_min < edge.base_travel_time_min * 1.1, edge.edge_id);
  } finally {
    provider.setState(original);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { predictEnvironment } = require('../server/state/forecastSimulator');
const { buildLivePlannerScenario, planItinerary } = require('../server/planner');
const { inferPreference } = require('../server/preference-engine');

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

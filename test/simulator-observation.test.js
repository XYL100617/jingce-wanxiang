'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { createSimulator } = require('../server/simulator/simulator');
const { generateObservation, createObservationBuffer, SCENARIOS } = require('../server/simulator/observation');
const { buildPlannerView, evaluateLegalActions } = require('../server/simulator/legal-action-adapter');
const { OBSERVATION_PARAMETERS, OBSERVATION_VERSION,
  resolveObservationParameters } = require('../server/simulator/parameter-registry');

const params = resolveObservationParameters();
const addMin = (value, minutes) => new Date(Date.parse(value.replace(' ', 'T') + 'Z') + minutes * 60000)
  .toISOString().slice(0, 19).replace('T', ' ');
const capture = (state, scenario = 'P1D_CLEAN', seed = 42, overrides = {}) =>
  generateObservation(state, new SeededRNG(seed), { ...params, ...overrides }, scenario);

test('D1 CLEAN observation matches allowed current latent fields', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const observed = capture(state);
  assert.equal(observed.pois.market.queue_count, state.pois.market.queue_count);
  assert.equal(observed.pois.market.queue_time_min,
    Math.round(state.pois.market.queue_count / state.pois.market.service_rate * 10) / 10);
  assert.equal(observed.roads.edge_001.is_open, state.roads.edge_001.is_open);
  assert.equal(observed.visitor.current_node_id, state.visitor.current_node_id);
  assert.deepEqual(observed.weather, state.environment.weather);
  assert.equal(observed.observed_at, state.simulation_time);
  assert.equal(observed.available_at, state.simulation_time);
});

test('D2 generating an observation does not mutate latent state', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const before = structuredClone(state);
  capture(state, 'P1D_MIXED');
  assert.deepEqual(state, before);
});

test('D3 same seed reproduces noisy observation exactly', () => {
  const state = createSimulator({ seed: 42 }).getState();
  assert.deepEqual(capture(state, 'P1D_NOISY', 99), capture(state, 'P1D_NOISY', 99));
});

test('D4 different seeds change numeric noisy observations', () => {
  const state = createSimulator({ seed: 42 }).getState();
  assert.notDeepEqual(capture(state, 'P1D_NOISY', 42).pois,
    capture(state, 'P1D_NOISY', 43).pois);
});

test('D5 noisy queue counts are clamped to nonnegative numbers', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const observed = capture(state, 'P1D_NOISY', 42, { queue_noise_std: 1000 });
  for (const poi of Object.values(observed.pois)) assert.ok(poi.queue_count >= 0);
});

test('D6 noisy road travel times are clamped to nonnegative numbers', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const observed = capture(state, 'P1D_NOISY', 42, { travel_time_noise_ratio: 10 });
  for (const road of Object.values(observed.roads)) assert.ok(road.travel_time_min >= 0);
});

test('D7 missing queue and travel time are null, never a fake zero', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const observed = capture(state, 'P1D_MISSING', 42,
    { queue_missing_rate: 1, travel_time_missing_rate: 1 });
  assert.equal(observed.pois.market.queue_count, null);
  assert.equal(observed.pois.market.queue_time_min, null);
  assert.equal(observed.roads.edge_001.travel_time_min, null);
});

test('D8 true in missing_mask matches every actually missing field', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const observed = capture(state, 'P1D_MISSING', 42);
  for (const [id, poi] of Object.entries(observed.pois)) {
    for (const field of ['queue_count', 'queue_time_min', 'crowd_ratio', 'is_open']) {
      assert.equal(observed.missing_mask.pois[id][field], poi[field] === null);
    }
  }
  for (const [id, road] of Object.entries(observed.roads)) {
    for (const field of ['travel_time_min', 'is_open']) {
      assert.equal(observed.missing_mask.roads[id][field], road[field] === null);
    }
  }
});

test('D9 delayed ordinary capture is unavailable before available_at', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const buffer = createObservationBuffer();
  buffer.capture(capture(state, 'P1D_DELAYED'));
  const view = buffer.latestAvailable(addMin(state.simulation_time, 4));
  assert.equal(view.pois.market.queue_count, null);
  assert.equal(view.roads.edge_001.travel_time_min, null);
  assert.equal(view.available_at, null);
  assert.equal(view.roads.edge_001.is_open, state.roads.edge_001.is_open);
});

test('D10 prior captured values become latest available only at their release time', () => {
  const state = createSimulator({ seed: 42 }).getState();
  const buffer = createObservationBuffer();
  const first = capture(state, 'P1D_DELAYED');
  buffer.capture(first);
  const later = structuredClone(state);
  later.simulation_time = addMin(state.simulation_time, 5);
  later.pois.market.queue_count += 9;
  buffer.capture(capture(later, 'P1D_DELAYED'));
  const atFive = buffer.latestAvailable(later.simulation_time);
  assert.equal(atFive.pois.market.queue_count, first.pois.market.queue_count);
  assert.equal(atFive.pois.market.observed_at, state.simulation_time);
  assert.equal(buffer.latestAvailable(addMin(state.simulation_time, 10)).pois.market.queue_count,
    later.pois.market.queue_count);
});

test('D11 future scripted road closure is absent from current observation', () => {
  const initial = provider.getState().timestamp;
  const simulator = createSimulator({ events: [{ event_id: 'future_closure',
    event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: addMin(initial, 10) }] });
  const observed = simulator.getObservation();
  assert.equal(JSON.stringify(observed).includes('future_closure'), false);
  assert.equal(observed.roads.edge_001.is_open, true);
});

test('D12 observation excludes future queues, next state and internal bookkeeping', () => {
  const observed = createSimulator().getObservation();
  for (const forbidden of ['future_queue', 'next_latent_state', 'population_ledger',
    'mobility_ledger', 'transit_groups', 'rng_state']) {
    assert.equal(JSON.stringify(observed).includes(forbidden), false);
  }
});

test('D13 authoritative closed-road bit cannot be changed by noise or delay', () => {
  const initial = provider.getState().timestamp;
  const simulator = createSimulator({ observationScenario: 'P1D_MIXED',
    events: [{ event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initial }] });
  simulator.step();
  const observed = simulator.getObservation();
  assert.equal(observed.roads.edge_001.is_open, false);
  assert.equal(observed.roads.edge_001.is_open_available_at, observed.safety_observed_at);
  assert.ok(simulator.getLegalActions().legal.every(item =>
    !(item.route?.edge_sequence || []).includes('edge_001')));
});

test('D14 C legal-action input is built from available observation and explicit fallbacks', () => {
  const simulator = createSimulator({ observationScenario: 'P1D_DELAYED', seed: 42 });
  const observation = simulator.getObservation();
  const graph = simulator.getGraph();
  const { view, fallbacks } = buildPlannerView(graph, observation, params);
  assert.equal(view.poi_states.market.queue_min, params.unknown_queue_fallback_min);
  assert.ok(fallbacks.unknown_poi_queue_ids.includes('market'));
  assert.equal(view.road_states.edge_001.travel_time_min,
    graph.edges.find(edge => edge.edge_id === 'edge_001').base_travel_time_min);
  assert.deepEqual(evaluateLegalActions(graph, observation).observation, observation);
  assert.deepEqual(simulator.getLegalActions().observation, observation);
  assert.ok(simulator.getLegalActions().planner_view_fallbacks.unknown_poi_queue_ids.includes('market'));
  assert.throws(() => evaluateLegalActions(graph, simulator.getState()), /available observation/);
});

test('D15 observations leave both population conservation equations unchanged', () => {
  const simulator = createSimulator({ seed: 42 });
  simulator.runSteps(10);
  const state = simulator.getState(), before = structuredClone(state);
  capture(state, 'P1D_MIXED');
  const env = state.environment, ledger = state.population_ledger;
  assert.deepEqual(state, before);
  assert.equal(env.initial_population + env.arrivals_total - env.departures_total, env.park_population);
  assert.equal(ledger.walking + ledger.queueing + ledger.inside_poi + ledger.resting
    + ledger.attending_event, env.park_population);
});

test('D16 fifty mixed-observation steps preserve the exact CLEAN latent trajectory', () => {
  const clean = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const mixed = createSimulator({ scenario: 'P0_HIGH', observationScenario: 'P1D_MIXED', seed: 42 });
  clean.runSteps(50);
  for (const step of mixed.runSteps(50)) assert.equal(step.invariant_summary.mobility, 'PASS');
  assert.deepEqual(mixed.getState(), clean.getState());
});

test('D17 one hundred steps reproduce latent state and available observation with same seed', () => {
  const run = () => {
    const simulator = createSimulator({ scenario: 'P0_HIGH', observationScenario: 'P1D_MIXED', seed: 42 });
    simulator.runSteps(100);
    return { latent: simulator.getState(), observation: simulator.getObservation() };
  };
  assert.deepEqual(run(), run());
});

test('observation registry and scenario metadata remain explicit T4 assumptions', () => {
  assert.equal(Object.keys(SCENARIOS).length, 5);
  for (const parameter of Object.values(OBSERVATION_PARAMETERS)) {
    assert.equal(parameter.source_tier, 'T4');
    assert.equal(parameter.parameter_basis, 'ASSUMPTION');
    assert.equal(parameter.version, OBSERVATION_VERSION);
  }
  const metadata = createSimulator({ observationScenario: 'P1D_NOISY' }).getMetadata();
  assert.equal(metadata.observation_parameter_version, 'obs-p1d.1');
});

test('D20 missing ordinary fields use registered fallback even when latent differs', () => {
  const simulator = createSimulator({ observationScenario: 'P1D_DELAYED', seed: 42 });
  const observation = simulator.getObservation();
  const latent = simulator.getState();
  assert.equal(observation.pois.market.queue_time_min, null);
  assert.notEqual(latent.pois.market.queue_count / latent.pois.market.service_rate,
    params.unknown_queue_fallback_min);
  const { view, fallbacks } = buildPlannerView(simulator.getGraph(), observation, params);
  assert.equal(view.poi_states.market.queue_min, params.unknown_queue_fallback_min);
  assert.ok(fallbacks.unknown_poi_queue_ids.includes('market'));
});

test('D21 internal state and step audit are distinct from agent-facing observation', () => {
  const simulator = createSimulator({ observationScenario: 'P1D_NOISY', seed: 42 });
  assert.ok(simulator.getState().population_ledger);
  assert.equal(simulator.getObservation().population_ledger, undefined);
  const audit = simulator.step();
  assert.ok(audit.population);
  assert.ok(audit.mobility_flow);
  assert.equal(audit.observation.population_ledger, undefined);
  assert.deepEqual(audit.observation, simulator.getObservation());
});

test('D22 and D23 decision observation excludes future events and next latent state', () => {
  const initial = provider.getState().timestamp;
  const simulator = createSimulator({ events: [{ event_id: 'future_secret',
    event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: addMin(initial, 10) }] });
  const exposed = JSON.stringify(simulator.getLegalActions().observation);
  assert.equal(exposed.includes('future_secret'), false);
  assert.equal(exposed.includes('next_latent_state'), false);
  assert.equal(exposed.includes('population_ledger'), false);
});

test('D24 authoritative safety fields carry zero-delay source times', () => {
  const simulator = createSimulator({ observationScenario: 'P1D_MIXED', seed: 42 });
  const observation = simulator.getObservation();
  assert.equal(observation.roads.edge_001.is_open_available_at, observation.safety_observed_at);
  assert.equal(observation.pois.market.is_open_available_at, observation.safety_observed_at);
  assert.equal(observation.missing_mask.roads.edge_001.is_open, false);
  assert.equal(observation.missing_mask.pois.market.is_open, false);
  assert.equal(observation.pois.market.queue_count, null);
});

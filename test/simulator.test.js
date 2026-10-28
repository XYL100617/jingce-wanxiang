'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { PARAMETERS, VERSION } = require('../server/simulator/parameter-registry');
const { createSimulator } = require('../server/simulator/simulator');

const initialTime = provider.getState().timestamp;
const addMinutes = (timestamp, minutes) => new Date(Date.parse(timestamp.replace(' ', 'T') + 'Z') + minutes * 60000)
  .toISOString().slice(0, 19).replace('T', ' ');
const openRoadsOnly = (legal, closedId) => legal.every(item =>
  !(item.route?.edge_sequence || []).includes(closedId) && !(item.return_route?.edge_sequence || []).includes(closedId));

test('seeded RNG has stable sequence and validates its operations', () => {
  const a = new SeededRNG(42), b = new SeededRNG(42), c = new SeededRNG(43);
  assert.deepEqual(Array.from({ length: 12 }, () => a.next()), Array.from({ length: 12 }, () => b.next()));
  const d = new SeededRNG(42);
  assert.notDeepEqual(Array.from({ length: 12 }, () => d.next()), Array.from({ length: 12 }, () => c.next()));
  const rng = new SeededRNG(42);
  assert.ok(rng.nextInt(2, 5) >= 2);
  assert.ok(rng.uniform(0, 1) >= 0);
  assert.ok(['a', 'b'].includes(rng.choice(['a', 'b'])));
});

test('registry and three scenarios keep all parameters tagged T4 assumptions', () => {
  assert.equal(VERSION, 'p1e.1');
  for (const parameter of Object.values(PARAMETERS)) {
    assert.equal(parameter.source_tier, 'T4');
    assert.equal(parameter.parameter_basis, 'ASSUMPTION');
    assert.equal(parameter.version, VERSION);
  }
  for (const scenario of ['P0_BASELINE', 'P0_LOW', 'P0_HIGH']) {
    const simulator = createSimulator({ scenario, seed: 42 });
    assert.equal(simulator.getMetadata().scenario_id, scenario);
    assert.equal(simulator.getMetadata().graph_version, '1.0');
  }
});

test('P0_HIGH generates more aggregate arrivals than P0_LOW with the same seed', () => {
  const low = createSimulator({ scenario: 'P0_LOW', seed: 42 }).runSteps(10);
  const high = createSimulator({ scenario: 'P0_HIGH', seed: 42 }).runSteps(10);
  const totalArrivals = steps => steps.reduce((sum, step) => sum + step.population.arrivals, 0);
  assert.ok(totalArrivals(high) > totalArrivals(low));
});

test('20 steps replay identically with seed 42 and diverge with seed 43', () => {
  const first = createSimulator({ scenario: 'P0_BASELINE', seed: 42 }).runSteps(20);
  const second = createSimulator({ scenario: 'P0_BASELINE', seed: 42 }).runSteps(20);
  const different = createSimulator({ scenario: 'P0_BASELINE', seed: 43 }).runSteps(20);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.map(step => [step.population, step.poi_queue_summary]),
    different.map(step => [step.population, step.poi_queue_summary]));
});

test('population and aggregate POI queues conserve flow and remain nonnegative', () => {
  const simulator = createSimulator({ seed: 42 });
  for (const step of simulator.runSteps(12)) {
    const p = step.population, q = step.poi_queue_summary;
    assert.equal(p.population_after, p.population_before + p.arrivals - p.departures);
    assert.ok(p.population_after >= 0);
    assert.equal(q.queue_after, q.queue_before + q.arrivals - q.served);
    assert.ok(q.queue_after >= 0);
    assert.equal(step.invariant_summary.population, 'PASS');
    assert.equal(step.invariant_summary.queue, 'PASS');
  }
  for (const poi of Object.values(simulator.getState().pois)) assert.ok(poi.queue >= 0);
});

test('departures are capped by people available to leave', () => {
  const { advancePopulation } = require('../server/simulator/dynamics');
  const environment = { park_population: 0, arrivals_total: 0, departures_total: 0 };
  const params = { arrival_rate: 0, arrival_multiplier: 1, departure_rate: 100, departure_multiplier: 1 };
  const ledger = advancePopulation(environment, 5, params, new SeededRNG(42));
  assert.deepEqual(ledger, { population_before: 0, arrivals: 0, departures: 0, population_after: 0 });
});

test('POI_CLOSE keeps existing queue and C rejects VISIT_POI', () => {
  const simulator = createSimulator({ seed: 42, events: [{ event_type: 'POI_CLOSE', target_id: 'market', timestamp: initialTime }] });
  const initialQueue = simulator.getState().pois.market.queue;
  const step = simulator.step();
  assert.equal(step.poi_status_changes[0].timestamp, initialTime);
  assert.equal(simulator.getState().pois.market.is_open, false);
  assert.equal(simulator.getState().pois.market.queue, initialQueue);
  const actions = simulator.getLegalActions();
  assert.ok(!actions.legal.some(item => item.action.action_type === 'VISIT_POI' && item.action.target_id === 'market'));
  assert.ok(actions.rejected.some(item => item.action.action_type === 'VISIT_POI' && item.action.target_id === 'market'));
});

test('ROAD_CLOSE at minute 3 and ROAD_REOPEN at minute 7 affect real C routes', () => {
  const simulator = createSimulator({ seed: 42, events: [
    { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: addMinutes(initialTime, 3) },
    { event_type: 'ROAD_REOPEN', target_id: 'edge_001', timestamp: addMinutes(initialTime, 7) }
  ] });
  const closed = simulator.step();
  assert.equal(closed.timestamp, addMinutes(initialTime, 5));
  assert.equal(closed.road_status_changes[0].timestamp, addMinutes(initialTime, 3));
  assert.equal(simulator.getState().roads.edge_001.is_open, false);
  assert.ok(openRoadsOnly(closed.legal_actions, 'edge_001'));
  assert.ok(closed.legal_actions.some(item => item.action.action_type === 'EXIT'));
  const reopened = simulator.step();
  assert.equal(reopened.timestamp, addMinutes(initialTime, 10));
  assert.equal(reopened.road_status_changes[0].timestamp, addMinutes(initialTime, 7));
  assert.equal(simulator.getState().roads.edge_001.is_open, true);
});

test('C rejects an action when its only route uses a closed edge', () => {
  const graph = provider.getScenicGraph();
  graph.edges = graph.edges.filter(edge => edge.edge_id === 'edge_001');
  const simulator = createSimulator({ initialGraph: graph, events: [
    { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: initialTime }
  ] });
  simulator.step();
  const actions = simulator.getLegalActions();
  assert.ok(!actions.legal.some(item => item.action.action_type === 'EXIT' && item.action.target_id === 'exit_southgate'));
  assert.ok(actions.rejected.some(item => item.action.action_type === 'EXIT' && item.action.target_id === 'exit_southgate'
    && item.route?.reachable === false));
});

test('POI_OPEN restores C eligibility after a closure', () => {
  const simulator = createSimulator({ events: [
    { event_type: 'POI_CLOSE', target_id: 'market', timestamp: initialTime },
    { event_type: 'POI_OPEN', target_id: 'market', timestamp: addMinutes(initialTime, 7) }
  ] });
  simulator.step();
  assert.equal(simulator.getState().pois.market.is_open, false);
  simulator.step();
  assert.equal(simulator.getState().pois.market.is_open, true);
  assert.ok(!simulator.getLegalActions().rejected.some(item => item.action.action_type === 'VISIT_POI'
    && item.action.target_id === 'market' && item.reason === '景点当前关闭'));
});

test('same timestamp event ordering keeps a road closed', () => {
  const at = addMinutes(initialTime, 3);
  const simulator = createSimulator({ events: [
    { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: at, event_id: 'close' },
    { event_type: 'ROAD_REOPEN', target_id: 'edge_001', timestamp: at, event_id: 'reopen' }
  ] });
  const result = simulator.step();
  assert.deepEqual(result.road_status_changes.map(item => item.event_type), ['ROAD_REOPEN', 'ROAD_CLOSE']);
  assert.equal(simulator.getState().roads.edge_001.is_open, false);
});

test('late show entry is rejected by C rather than a simulator-specific rule', () => {
  const source = provider.getState();
  source.timestamp = addMinutes(source.event_states['show-1'].latest_entry_time, 1);
  const simulator = createSimulator({ initialState: source });
  const actions = simulator.getLegalActions();
  assert.ok(!actions.legal.some(item => item.action.action_type === 'ATTEND_EVENT' && item.action.target_id === 'show-1'));
  assert.ok(actions.rejected.some(item => item.action.action_type === 'ATTEND_EVENT' && item.action.target_id === 'show-1'));
});

test('four DEMO exits are passed to C without changing gate logic', () => {
  const actions = createSimulator().getLegalActions();
  assert.deepEqual(new Set(actions.planner_graph.exits.map(item => item.node_id)), new Set(['gate', 'southgate', 'westgate', 'eastgate']));
});

test('simulator keeps provider, source graph and source state unchanged', () => {
  const providerState = provider.getState(), providerGraph = provider.getScenicGraph();
  const sourceState = provider.getState(), sourceGraph = provider.getScenicGraph();
  const stateBefore = structuredClone(sourceState), graphBefore = structuredClone(sourceGraph);
  const simulator = createSimulator({ initialState: sourceState, initialGraph: sourceGraph, events: [
    { event_type: 'ROAD_CLOSE', target_id: 'edge_001', timestamp: addMinutes(initialTime, 3) }
  ] });
  simulator.runSteps(3);
  const external = simulator.getState();
  external.roads.edge_001.is_open = true;
  assert.equal(simulator.getState().roads.edge_001.is_open, false);
  assert.deepEqual(sourceState, stateBefore);
  assert.deepEqual(sourceGraph, graphBefore);
  assert.deepEqual(provider.getState(), providerState);
  assert.deepEqual(provider.getScenicGraph(), providerGraph);
});

test('graph version remains 1.0 through steps and reset; invalid event targets fail', () => {
  const simulator = createSimulator({ seed: 42 });
  for (const result of simulator.runSteps(4)) {
    assert.equal(result.invariant_summary.graph_version, 'PASS');
    assert.equal(simulator.getMetadata().graph_version, '1.0');
  }
  assert.equal(simulator.getState().graph_version, '1.0');
  assert.equal(simulator.reset().getState().graph_version, '1.0');
  assert.throws(() => createSimulator({ events: [{ event_type: 'ROAD_CLOSE', target_id: 'unknown', timestamp: initialTime }] }), /unknown/);
});

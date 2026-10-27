'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { createSimulator } = require('../server/simulator/simulator');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { advancePopulation, advancePoiService } = require('../server/simulator/dynamics');
const { dispatchToPoi, advanceTransit, edgeTravelMin } = require('../server/simulator/mobility');

const travel = { simulation_step_min: 5, minimum_edge_travel_min: 5, travel_time_multiplier: 1 };
const addMin = (value, minutes) => new Date(Date.parse(value.replace(' ', 'T') + 'Z') + minutes * 60000)
  .toISOString().slice(0, 19).replace('T', ' ');
const sumNodes = state => Object.values(state.mobility_ledger.node_walkers).reduce((sum, count) => sum + count, 0);
const sumTransit = state => state.mobility_ledger.transit_groups.reduce((sum, group) => sum + group.count, 0);
const sumPark = state => ['walking', 'queueing', 'inside_poi', 'resting', 'attending_event']
  .reduce((sum, key) => sum + state.population_ledger[key], 0);

function subset(nodeIds, edgeIds) {
  const graph = provider.getScenicGraph();
  graph.nodes = graph.nodes.filter(node => nodeIds.includes(node.node_id));
  graph.edges = graph.edges.filter(edge => edgeIds.includes(edge.edge_id));
  return graph;
}

function context(nodeIds = ['gate', 'market'], edgeIds = ['edge_002']) {
  const simulator = createSimulator({ initialGraph: subset(nodeIds, edgeIds), seed: 42 });
  return { graph: simulator.getGraph(), state: simulator.getState() };
}

function progress(graph, state, minutes = 5) {
  const result = advanceTransit(graph, state, minutes, travel);
  state.simulation_time = addMin(state.simulation_time, minutes);
  return result;
}

function service(state, minutes = 5) {
  const flow = advancePoiService(state.pois, state.population_ledger,
    state.mobility_ledger, minutes, state.simulation_time);
  state.simulation_time = addMin(state.simulation_time, minutes);
  return flow;
}

test('1 initial walking population has a valid graph node', () => {
  const simulator = createSimulator({ seed: 42 });
  const state = simulator.getState();
  assert.equal(state.mobility_ledger.entry_node_id, 'gate');
  assert.equal(sumNodes(state), state.population_ledger.walking);
  assert.equal(sumTransit(state), 0);
  assert.ok(simulator.getGraph().nodes.some(node => node.node_id === state.mobility_ledger.entry_node_id));
});

test('2 new arrivals enter the existing entrance node bucket', () => {
  const { state } = context();
  const before = state.mobility_ledger.node_walkers.gate;
  const params = { arrival_rate: 2, arrival_multiplier: 1, departure_rate: 0, departure_multiplier: 1 };
  const result = advancePopulation(state.environment, 5, params, new SeededRNG(42),
    state.population_ledger, state.mobility_ledger);
  assert.equal(result.arrivals, 10);
  assert.equal(state.mobility_ledger.node_walkers.gate, before + 10);
});

test('3 dispatch from node creates transit but does not increase POI queue', () => {
  const { graph, state } = context();
  const before = state.pois.market.queue_count, walking = state.population_ledger.walking;
  const result = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 4 });
  assert.equal(result.dispatched, 4);
  assert.equal(state.pois.market.queue_count, before);
  assert.equal(state.population_ledger.walking, walking);
  assert.equal(state.mobility_ledger.transit_groups[0].count, 4);
});

test('4 single edge takes a later step before its cohort reaches the queue', () => {
  const { graph, state } = context();
  const before = state.pois.market.queue_count;
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 4 });
  assert.equal(edgeTravelMin(state, 'edge_002', travel), 5);
  assert.equal(state.pois.market.queue_count, before);
  const result = progress(graph, state);
  assert.equal(result.arrived_total, 4);
  assert.equal(state.pois.market.queue_count, before + 4);
});

test('5 three-edge path advances across multiple 5-minute steps', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'lake'], ['edge_001', 'edge_003', 'edge_004']);
  const result = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'lake', count: 3 });
  assert.deepEqual(result.group.path.edge_sequence, ['edge_001', 'edge_003', 'edge_004']);
  const queueBefore = state.pois.lake.queue_count;
  progress(graph, state);
  assert.equal(state.mobility_ledger.transit_groups[0].current_edge_id, 'edge_001');
  assert.equal(state.pois.lake.queue_count, queueBefore);
  progress(graph, state);
  assert.equal(state.mobility_ledger.transit_groups[0].current_node_id, 'southgate');
  for (let i = 0; i < 5; i += 1) progress(graph, state);
  assert.equal(state.pois.lake.queue_count, queueBefore + 3);
  assert.equal(sumTransit(state), 0);
});

test('6 node to transit changes only spatial walking components', () => {
  const { graph, state } = context();
  const walking = state.population_ledger.walking, park = state.environment.park_population;
  const nodes = sumNodes(state);
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 7 });
  assert.equal(sumNodes(state), nodes - 7);
  assert.equal(sumTransit(state), 7);
  assert.equal(state.population_ledger.walking, walking);
  assert.equal(state.environment.park_population, park);
});

test('7 transit arrival transfers equal people from walking to queueing', () => {
  const { graph, state } = context();
  const walking = state.population_ledger.walking, queueing = state.population_ledger.queueing;
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 6 });
  progress(graph, state);
  assert.equal(state.population_ledger.walking, walking - 6);
  assert.equal(state.population_ledger.queueing, queueing + 6);
  assert.equal(sumPark(state), state.environment.park_population);
});

test('8 completed POI visits return to that POI graph node', () => {
  const { state } = context();
  const before = state.mobility_ledger.node_walkers.market;
  const flow = service(state, 30).market;
  assert.ok(flow.completed > 0);
  assert.equal(state.mobility_ledger.node_walkers.market, before + flow.completed);
});

test('9 capacity, admission and service remain distinct constraints', () => {
  const { state } = context();
  const poi = state.pois.market;
  poi.capacity = poi.inside_count + 1;
  const flow = service(state).market;
  assert.ok(flow.admitted <= 1);
  assert.ok(poi.inside_count <= poi.capacity);
  assert.equal(flow.inside_after, flow.inside_before + flow.admitted - flow.completed);
});

test('10 route chosen before departure excludes a closed edge', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_020']);
  state.roads.edge_002.is_open = false;
  state.roads.edge_002.closed_at = state.simulation_time;
  const result = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 3 });
  assert.equal(result.dispatched, 3);
  assert.ok(!result.group.path.edge_sequence.includes('edge_002'));
});

test('11 open alternative route is used when the direct edge closes', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_020']);
  state.roads.edge_002.is_open = false;
  const result = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 3 });
  assert.deepEqual(result.group.path.edge_sequence, ['edge_001', 'edge_003', 'edge_020']);
});

test('12 no path leaves the group at its origin without teleporting', () => {
  const { graph, state } = context();
  state.roads.edge_002.is_open = false;
  const before = state.mobility_ledger.node_walkers.gate;
  const result = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 4 });
  assert.equal(result.dispatched, 0);
  assert.equal(result.reason, 'NO_PATH');
  assert.equal(state.mobility_ledger.node_walkers.gate, before);
  assert.equal(sumTransit(state), 0);
});

test('13 an entered edge can finish after closure; the next closed edge is not entered', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'lake'], ['edge_001', 'edge_003', 'edge_004']);
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'lake', count: 3 });
  progress(graph, state); // Halfway along edge_001.
  state.roads.edge_001.is_open = false;
  state.roads.edge_001.closed_at = state.simulation_time;
  state.roads.edge_003.is_open = false;
  state.roads.edge_003.closed_at = state.simulation_time;
  progress(graph, state); // Complete already-entered edge_001.
  assert.equal(state.mobility_ledger.transit_groups[0].current_node_id, 'southgate');
  const result = progress(graph, state);
  assert.equal(result.blocked[0].node_id, 'southgate');
  assert.ok(!result.edge_entries.some(entry => entry.edge_id === 'edge_003'));
  assert.equal(sumTransit(state), 0);
  assert.equal(state.mobility_ledger.node_walkers.southgate, 3);
});

test('14 a next-edge closure reroutes at the current node when an alternative opens', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_020']);
  state.roads.edge_002.is_open = false;
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'temple', count: 3 });
  progress(graph, state, 10);
  assert.equal(state.mobility_ledger.transit_groups[0].current_node_id, 'southgate');
  state.roads.edge_002.is_open = true;
  state.roads.edge_003.is_open = false;
  state.roads.edge_003.closed_at = state.simulation_time;
  const result = progress(graph, state);
  assert.equal(result.reroutes.length, 1);
  assert.ok(!result.reroutes[0].edge_sequence.includes('edge_003'));
  assert.ok(!result.edge_entries.some(entry => entry.edge_id === 'edge_003'));
});

test('15 a POI closed during travel returns arrivals to its node bucket', () => {
  const { graph, state } = context();
  const queueBefore = state.pois.market.queue_count, walking = state.population_ledger.walking;
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 4 });
  state.pois.market.is_open = false;
  const result = progress(graph, state);
  assert.equal(result.closed_poi_returns, 4);
  assert.equal(state.pois.market.queue_count, queueBefore);
  assert.equal(state.mobility_ledger.node_walkers.market, 4);
  assert.equal(state.population_ledger.walking, walking);
});

test('15b a cohort returned from a closed POI waits at that node until a later interval', () => {
  const graph = subset(['gate', 'market', 'rest'], ['edge_002', 'edge_008']);
  const initialTime = provider.getState().timestamp;
  const simulator = createSimulator({ initialGraph: graph, seed: 42, events: [
    { event_type: 'POI_CLOSE', target_id: 'rest', timestamp: initialTime },
    { event_type: 'POI_OPEN', target_id: 'rest', timestamp: addMin(initialTime, 6) },
    { event_type: 'POI_CLOSE', target_id: 'market', timestamp: addMin(initialTime, 6) }
  ] });
  simulator.step(); // Dispatch from gate at minute 5.
  const result = simulator.step(); // Close at minute 6 before edge_002 completes.
  assert.ok(result.mobility_flow.closed_poi_returns > 0);
  assert.equal(result.mobility_flow.dispatched.filter(group => group.origin_node_id === 'market'
    && group.departed_at === result.timestamp).length, 0);
  assert.ok(simulator.getState().mobility_ledger.node_walkers.market > 0);
});

test('15c event-clock road closure allows a cohort already on the edge to finish', () => {
  const graph = subset(['gate', 'market'], ['edge_002']);
  const initialTime = provider.getState().timestamp;
  const simulator = createSimulator({ initialGraph: graph, seed: 42, events: [
    { event_type: 'ROAD_CLOSE', target_id: 'edge_002', timestamp: addMin(initialTime, 6) }
  ] });
  simulator.step(); // Dispatch at minute 5.
  const result = simulator.step(); // Enter edge at minute 5; close at minute 6.
  assert.equal(result.road_status_changes[0].timestamp, addMin(initialTime, 6));
  assert.ok(result.mobility_flow.edge_entries.some(entry => entry.edge_id === 'edge_002'
    && entry.timestamp < result.road_status_changes[0].timestamp));
  assert.ok(result.mobility_flow.arrived_total > 0);
  assert.ok(result.mobility_flow.edge_entries.every(entry => entry.timestamp < result.road_status_changes[0].timestamp));
});

test('16 aggregate departures cannot remove people in transit', () => {
  const { graph, state } = context();
  const fromGate = state.mobility_ledger.node_walkers.gate;
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: fromGate });
  const params = { arrival_rate: 0, arrival_multiplier: 1, departure_rate: 100, departure_multiplier: 1 };
  const result = advancePopulation(state.environment, 5, params, new SeededRNG(42),
    state.population_ledger, state.mobility_ledger);
  assert.equal(result.departures, 0);
  assert.equal(sumTransit(state), fromGate);
});

test('17 node and transit counts remain nonnegative and use graph IDs', () => {
  const simulator = createSimulator({ seed: 42 });
  const graph = simulator.getGraph();
  const ids = new Set(graph.nodes.map(node => node.node_id));
  simulator.runSteps(12);
  const state = simulator.getState();
  for (const [id, count] of Object.entries(state.mobility_ledger.node_walkers)) {
    assert.ok(ids.has(id)); assert.ok(count >= 0);
  }
  for (const group of state.mobility_ledger.transit_groups) {
    assert.ok(group.count > 0);
    assert.ok(group.path.node_sequence.every(id => ids.has(id)));
  }
  assert.equal(sumNodes(state) + sumTransit(state), state.population_ledger.walking);
});

function assertConservation(state) {
  const env = state.environment, ledger = state.population_ledger;
  assert.equal(env.initial_population + env.arrivals_total - env.departures_total, env.park_population);
  assert.equal(sumNodes(state) + sumTransit(state), ledger.walking);
  assert.equal(sumPark(state), env.park_population);
  assert.equal(Object.values(state.pois).reduce((sum, poi) => sum + poi.queue_count, 0), ledger.queueing);
  assert.equal(Object.values(state.pois).reduce((sum, poi) => sum + poi.inside_count, 0), ledger.inside_poi);
}

test('18 fifty steps maintain all population and spatial invariants', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of simulator.runSteps(50)) assert.equal(step.invariant_summary.mobility, 'PASS');
  assertConservation(simulator.getState());
});

test('19 one hundred steps have no cumulative population drift', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of simulator.runSteps(100)) assert.equal(step.invariant_summary.mobility, 'PASS');
  assertConservation(simulator.getState());
});

test('20 same seed reproduces node walkers, cohorts, queues and population', () => {
  const run = seed => {
    const simulator = createSimulator({ seed, scenario: 'P0_BASELINE' });
    const trace = simulator.runSteps(20).map(step => ({ population: step.population,
      mobility_flow: step.mobility_flow, poi_queue_summary: step.poi_queue_summary }));
    return { trace, state: simulator.getState() };
  };
  assert.deepEqual(run(42), run(42));
});

test('21 different seeds change spatial cohort trajectories', () => {
  const run = seed => createSimulator({ seed, scenario: 'P0_BASELINE' }).runSteps(20)
    .map(step => step.mobility_flow);
  assert.notDeepEqual(run(42), run(43));
});

function clearInitialInside(state, poiId = 'market') {
  const poi = state.pois[poiId];
  const released = poi.inside_count;
  poi.inside_count = 0;
  poi.inside_groups = [];
  state.population_ledger.inside_poi -= released;
  state.population_ledger.walking += released;
  state.mobility_ledger.node_walkers[state.mobility_ledger.poi_node_map[poiId]] += released;
}

function admittedCohort() {
  const { state } = context();
  clearInitialInside(state);
  state.pois.market.capacity = 2;
  const flow = service(state).market;
  assert.equal(flow.admitted, 2);
  return { state, cohort: structuredClone(state.pois.market.inside_groups[0]) };
}

test('B1 admission creates an inside cohort and does not return it to walking', () => {
  const { state, cohort } = admittedCohort();
  assert.equal(cohort.count, 2);
  assert.equal(state.pois.market.inside_count, 2);
  assert.equal(state.population_ledger.inside_poi, 2);
  assert.equal(state.mobility_ledger.node_walkers.market > 0, true);
  assertConservation(state);
});

test('B2 admitted cohort remains inside before its visit duration ends', () => {
  const { state, cohort } = admittedCohort();
  state.pois.market.is_open = false;
  while (addMin(state.simulation_time, 5) < cohort.leave_at) service(state);
  assert.equal(state.pois.market.inside_count, 2);
  assert.deepEqual(state.pois.market.inside_groups[0], cohort);
});

test('B3 matured cohort leaves inside and returns to its POI node', () => {
  const { state, cohort } = admittedCohort();
  state.pois.market.is_open = false;
  state.pois.market.service_rate = 100;
  while (state.simulation_time < cohort.leave_at) service(state);
  assert.equal(state.pois.market.inside_count, 0);
  assert.equal(state.mobility_ledger.node_walkers.market >= cohort.count, true);
  assertConservation(state);
});

test('B4 inside occupancy never exceeds simultaneous capacity', () => {
  const { state } = context();
  state.pois.market.capacity = state.pois.market.inside_count;
  const flow = service(state).market;
  assert.equal(flow.admitted, 0);
  assert.ok(state.pois.market.inside_count <= state.pois.market.capacity);
});

test('B5 full POI retains its queue without admitting anyone', () => {
  const { state } = context();
  state.pois.market.capacity = state.pois.market.inside_count;
  const queue = state.pois.market.queue_count;
  service(state);
  assert.equal(state.pois.market.queue_count, queue);
});

test('B6 closed POI receives no new queue arrival and pauses admission', () => {
  const { graph, state } = context();
  state.pois.market.is_open = false;
  const queue = state.pois.market.queue_count;
  assert.equal(dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 2 }).reason, 'POI_CLOSED');
  assert.equal(service(state).market.admitted, 0);
  assert.equal(state.pois.market.queue_count, queue);
});

test('B7 closed POI still lets a previously admitted cohort finish', () => {
  const { state, cohort } = admittedCohort();
  state.pois.market.is_open = false;
  state.pois.market.service_rate = 100;
  while (state.simulation_time < cohort.leave_at) service(state);
  assert.equal(state.pois.market.inside_count, 0);
  assert.equal(state.population_ledger.inside_poi, 0);
  assertConservation(state);
});

test('B8 queue ledger equals sum of all POI queues after movement', () => {
  const simulator = createSimulator({ seed: 42 });
  simulator.runSteps(15);
  const state = simulator.getState();
  assert.equal(state.population_ledger.queueing,
    Object.values(state.pois).reduce((sum, poi) => sum + poi.queue_count, 0));
});

test('B9 inside ledger equals POI occupancy and cohort totals', () => {
  const simulator = createSimulator({ seed: 42 });
  simulator.runSteps(15);
  const state = simulator.getState();
  assert.equal(state.population_ledger.inside_poi,
    Object.values(state.pois).reduce((sum, poi) => sum + poi.inside_count, 0));
  for (const poi of Object.values(state.pois)) assert.equal(poi.inside_count,
    poi.inside_groups.reduce((sum, group) => sum + group.count, 0));
});

for (const [label, steps] of [['B10', 50], ['B11', 100]]) {
  test(`${label} ${steps} steps conserve population including nonzero POI occupancy`, () => {
    const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
    simulator.runSteps(steps);
    const state = simulator.getState();
    assert.ok(state.population_ledger.inside_poi > 0);
    assertConservation(state);
  });
}

test('B12 same seed reproduces inside cohorts and leave times', () => {
  const run = () => {
    const simulator = createSimulator({ seed: 42 });
    simulator.runSteps(20);
    return Object.fromEntries(Object.entries(simulator.getState().pois)
      .map(([id, poi]) => [id, poi.inside_groups]));
  };
  assert.deepEqual(run(), run());
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { createSimulator } = require('../server/simulator/simulator');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { resolveScenario, resolveParameters, resolveObservationParameters, PARAMETERS } = require('../server/simulator/parameter-registry');
const { dispatchToPoi, advanceTransit } = require('../server/simulator/mobility');
const { estimateRoad, syncRoadOccupancy, enterEdge, validateRoadDynamics,
  weatherCategory, summarizeRoads } = require('../server/simulator/road-dynamics');
const { generateObservation, createObservationBuffer } = require('../server/simulator/observation');
const { buildPlannerView } = require('../server/simulator/legal-action-adapter');
const { buildAdjacency } = require('../server/planner/astar');
const { plannerSnapshot } = require('../server/simulator/mobility');

const parameters = resolveParameters(resolveScenario('P0_HIGH'), new SeededRNG(42));
const edgeId = 'edge_002';
const makeState = () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const state = simulator.getState();
  state.environment.weather = { category: 'CLEAR' };
  syncRoadOccupancy(state, parameters);
  return { graph: simulator.getGraph(), state };
};
const travelers = (count = 4) => {
  const { graph, state } = makeState();
  assert.equal(dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count }).dispatched, count);
  const group = state.mobility_ledger.transit_groups[0];
  return { graph, state, group };
};
const onEdge = (count = 4) => {
  const context = travelers(count);
  advanceTransit(context.graph, context.state, 0.1, parameters);
  assert.equal(context.group.current_edge_id, edgeId);
  return context;
};
const onEdgePeople = state => state.mobility_ledger.transit_groups
  .filter(group => group.current_edge_id).reduce((total, group) => total + group.count, 0);
const parkPeople = state => ['walking', 'queueing', 'inside_poi', 'attending_event', 'resting']
  .reduce((total, bucket) => total + state.population_ledger[bucket], 0);
let surgeTrace;
function getSurgeTrace() {
  if (surgeTrace) return surgeTrace;
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const steps = sim.runSteps(24);
  surgeTrace = { before: steps[19], after: steps[21] };
  return surgeTrace;
}

test('G1 entering an edge increases occupancy by the transit cohort count', () => {
  const { state, group } = onEdge();
  assert.equal(state.roads[edgeId].occupancy, group.count);
});
test('G2 leaving an edge removes the same cohort from occupancy', () => {
  const { graph, state, group } = onEdge();
  advanceTransit(graph, state, 30, parameters);
  assert.equal(group.current_edge_id, null);
  assert.equal(state.roads[edgeId].occupancy, 0);
});
test('G3 occupied-edge total equals people in transit groups currently on edges', () => {
  const { state } = onEdge();
  assert.equal(summarizeRoads(state).total_transit_people_on_edges, onEdgePeople(state));
  assert.equal(validateRoadDynamics(state, parameters), 'PASS');
});
test('G4 free flow preserves schematic base time with the configured weather factor', () => {
  const { state } = makeState();
  const road = state.roads[edgeId];
  const time = estimateRoad(state, edgeId, parameters, 2);
  assert.equal(time.congestion_multiplier, 1);
  assert.equal(time.effective_travel_time_min,
    road.base_travel_time_min / road.speed_factor * parameters.travel_time_multiplier);
});
test('G5 above threshold, greater occupancy raises estimated travel time', () => {
  const { state } = makeState();
  assert.ok(estimateRoad(state, edgeId, parameters, 6).effective_travel_time_min
    > estimateRoad(state, edgeId, parameters, 3).effective_travel_time_min);
});
test('G6 occupancy cannot make travel time decrease', () => {
  const { state } = makeState();
  const times = Array.from({ length: 25 }, (_, occupancy) =>
    estimateRoad(state, edgeId, parameters, occupancy).effective_travel_time_min);
  assert.ok(times.every((time, index) => index === 0 || time >= times[index - 1]));
});
test('G7 congestion multiplier is bounded at the registered maximum', () => {
  const { state } = makeState();
  assert.equal(estimateRoad(state, edgeId, parameters, 1000).congestion_multiplier,
    parameters.max_congestion_multiplier);
});
test('G8 rain slows the same edge at the same occupancy', () => {
  const { state } = makeState();
  const clear = estimateRoad(state, edgeId, parameters, 6);
  state.environment.weather = { category: 'RAIN' };
  const rain = estimateRoad(state, edgeId, parameters, 6);
  assert.ok(rain.effective_travel_time_min > clear.effective_travel_time_min);
  assert.equal(rain.weather_multiplier, parameters.weather_rain_multiplier);
});
test('G9 hot weather uses the configured travel-time factor', () => {
  const { state } = makeState();
  state.environment.weather = { category: 'HOT' };
  const hot = estimateRoad(state, edgeId, parameters, 6);
  assert.equal(hot.weather_multiplier, parameters.weather_hot_multiplier);
  assert.equal(weatherCategory({ label: '高温' }), 'HOT');
  assert.equal(weatherCategory({ label: '雨' }), 'RAIN');
});
test('G10 a cohort on an edge retains its locked entry time while progressing', () => {
  const { graph, state, group } = onEdge(10);
  const lock = group.locked_segment_travel_time_min;
  advanceTransit(graph, state, 1, parameters);
  assert.equal(group.locked_segment_travel_time_min, lock);
  assert.ok(group.remaining_edge_min < lock);
});
test('G11 subsequent occupancy and weather changes do not rewrite an existing lock', () => {
  const graph = provider.getScenicGraph();
  graph.nodes = graph.nodes.filter(node => ['gate', 'market'].includes(node.node_id));
  graph.edges = graph.edges.filter(edge => edge.edge_id === edgeId);
  const simulator = createSimulator({ initialGraph: graph, scenario: 'P0_HIGH', seed: 42 });
  const state = simulator.getState();
  state.environment.weather = { category: 'CLEAR' };
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 10 });
  advanceTransit(graph, state, 0.1, parameters);
  const group = state.mobility_ledger.transit_groups[0];
  const lock = group.locked_segment_travel_time_min;
  state.environment.weather = { category: 'RAIN' };
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 2 });
  const flow = advanceTransit(graph, state, 0.1, parameters);
  assert.ok(flow.edge_entries.some(entry => entry.edge_id === edgeId && entry.count === 2));
  assert.equal(group.locked_segment_travel_time_min, lock);
  assert.equal(state.roads[edgeId].occupancy, 12);
});
test('G12 each next edge is locked using its newly observed occupancy and weather', () => {
  const { graph, state } = makeState();
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'rest', count: 4 });
  const group = state.mobility_ledger.transit_groups[0];
  advanceTransit(graph, state, 0.1, parameters);
  const firstLock = group.locked_segment_travel_time_min;
  state.environment.weather = { category: 'RAIN' };
  const flow = advanceTransit(graph, state, 4, parameters);
  const next = flow.edge_entries.find(entry => entry.edge_id === 'edge_008');
  assert.ok(next);
  assert.equal(next.weather_multiplier, parameters.weather_rain_multiplier);
  assert.equal(group.locked_segment_travel_time_min, next.locked_segment_travel_time_min);
  assert.notEqual(group.locked_segment_travel_time_min, firstLock);
});
test('G13 a closed edge rejects a new entrant', () => {
  const { state, group } = travelers();
  state.roads[edgeId].is_open = false;
  assert.throws(() => enterEdge(state, group, edgeId, parameters), /closed edge/);
  assert.equal(state.roads[edgeId].occupancy, 0);
});
test('G14 an entrant may finish the current edge after it closes', () => {
  const { graph, state, group } = onEdge(4);
  state.roads[edgeId].is_open = false;
  advanceTransit(graph, state, 30, parameters);
  assert.equal(group.current_edge_id, null);
  assert.equal(state.roads[edgeId].occupancy, 0);
});
test('G15 EVENT_TRAVEL transit groups contribute to occupied edges', () => {
  const { state } = onEdge();
  state.mobility_ledger.transit_groups[0].purpose = 'EVENT_TRAVEL';
  syncRoadOccupancy(state, parameters);
  assert.equal(state.roads[edgeId].occupancy, 4);
});
test('G16 EXIT_TRAVEL transit groups contribute to occupied edges', () => {
  const { state } = onEdge();
  state.mobility_ledger.transit_groups[0].purpose = 'EXIT_TRAVEL';
  syncRoadOccupancy(state, parameters);
  assert.equal(state.roads[edgeId].occupancy, 4);
});
test('G17 POI_TRAVEL transit groups contribute to occupied edges', () => {
  const { state } = onEdge();
  assert.equal(state.mobility_ledger.transit_groups[0].purpose, 'POI_TRAVEL');
  assert.equal(state.roads[edgeId].occupancy, 4);
});
test('G18 event release sends a natural surge into the theater-adjacent edge', () => {
  const { before, after } = getSurgeTrace();
  const early = before.mobility_flow.edge_entries.find(entry => entry.edge_id === 'edge_033');
  const late = after.mobility_flow.edge_entries.filter(entry => entry.edge_id === 'edge_033')
    .sort((a, b) => b.projected_occupancy - a.projected_occupancy)[0];
  assert.ok(early && late);
  assert.ok(late.projected_occupancy > early.projected_occupancy);
  assert.ok(after.event_flows['show-1'].released > 0);
});
test('G19 the same event surge increases effective edge travel time', () => {
  const { before, after } = getSurgeTrace();
  const early = before.mobility_flow.edge_entries.find(entry => entry.edge_id === 'edge_033');
  const late = after.mobility_flow.edge_entries.filter(entry => entry.edge_id === 'edge_033')
    .sort((a, b) => b.projected_occupancy - a.projected_occupancy)[0];
  assert.ok(late.effective_travel_time_min > early.effective_travel_time_min);
  assert.ok(late.congestion_multiplier > early.congestion_multiplier);
});
test('G20 dynamic road time crosses clean, missing, noisy, and delayed observation boundaries', () => {
  const { state } = onEdge(10);
  const obsParams = resolveObservationParameters();
  const clean = generateObservation(state, new SeededRNG(7), obsParams, 'P1D_CLEAN');
  assert.equal(clean.roads[edgeId].travel_time_min,
    Math.round(state.roads[edgeId].effective_travel_time_min * 100) / 100);
  const missing = generateObservation(state, { next: () => 0 }, obsParams, 'P1D_MISSING');
  assert.equal(missing.roads[edgeId].travel_time_min, null);
  assert.equal(missing.roads[edgeId].is_open, state.roads[edgeId].is_open);
  const noisy = generateObservation(state, new SeededRNG(7), obsParams, 'P1D_NOISY');
  assert.notEqual(noisy.roads[edgeId].travel_time_min, clean.roads[edgeId].travel_time_min);
  const delayed = generateObservation(state, new SeededRNG(7), obsParams, 'P1D_DELAYED');
  const buffer = createObservationBuffer();
  buffer.capture(delayed);
  assert.equal(buffer.latestAvailable(state.simulation_time).roads[edgeId].travel_time_min, null);
});
test('G21 planner-facing road cost comes from available observation, not raw occupancy', () => {
  const { graph, state } = onEdge(10);
  const observation = generateObservation(state, new SeededRNG(7), resolveObservationParameters(), 'P1D_CLEAN');
  observation.roads[edgeId].travel_time_min = 99;
  const { view } = buildPlannerView(graph, observation);
  assert.equal(view.road_states[edgeId].travel_time_min, 99);
  assert.notEqual(view.road_states[edgeId].travel_time_min, state.roads[edgeId].effective_travel_time_min);
  assert.equal(Object.hasOwn(observation.roads[edgeId], 'occupancy'), false);
});
test('G21b internal C path choice responds to the current dynamic road cost', () => {
  const baseline = travelers(2);
  assert.equal(baseline.group.path.edge_sequence[0], edgeId);
  const { graph, state } = onEdge(10);
  const next = dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 2 });
  assert.equal(next.dispatched, 2);
  assert.notEqual(next.group.path.edge_sequence[0], edgeId);
});
test('G22 identical seed and weather reproduce every road metric and edge entry', () => {
  const trace = () => createSimulator({ scenario: 'P0_HIGH', seed: 42 }).runSteps(12)
    .map(step => [step.road_metrics_summary, step.mobility_flow.edge_entries]);
  assert.deepEqual(trace(), trace());
});
test('G23 rain changes road time without changing the initial population ledger', () => {
  const initial = provider.getState();
  const clear = createSimulator({ scenario: 'P0_HIGH', seed: 42,
    initialState: { ...initial, weather: { category: 'CLEAR' } } });
  const rain = createSimulator({ scenario: 'P0_HIGH', seed: 42,
    initialState: { ...initial, weather: { category: 'RAIN' } } });
  assert.equal(parkPeople(clear.getState()), parkPeople(rain.getState()));
  for (let i = 0; i < 12; i += 1) {
    assert.equal(clear.step().invariant_summary.population, 'PASS');
    const wet = rain.step();
    assert.equal(wet.invariant_summary.population, 'PASS');
    assert.equal(wet.invariant_summary.road_occupancy, 'PASS');
  }
});
test('G24 fifty P0_HIGH steps preserve road and population invariants', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const steps = sim.runSteps(50);
  assert.ok(steps.every(step => step.invariant_summary.population === 'PASS'
    && step.invariant_summary.road_occupancy === 'PASS'));
  assert.equal(summarizeRoads(sim.getState()).total_transit_people_on_edges, onEdgePeople(sim.getState()));
});
test('G25 one hundred P0_HIGH steps preserve road and population invariants', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const steps = sim.runSteps(100);
  assert.ok(steps.every(step => step.invariant_summary.population === 'PASS'
    && step.invariant_summary.road_occupancy === 'PASS'));
  assert.equal(summarizeRoads(sim.getState()).total_transit_people_on_edges, onEdgePeople(sim.getState()));
  assert.equal(PARAMETERS.road_reference_capacity.source_tier, 'T4');
  assert.equal(PARAMETERS.road_reference_capacity.parameter_basis, 'ASSUMPTION');
});
test('G26 every DEMO bidirectional edge shares one ID across both route directions', () => {
  const { graph, state } = makeState();
  assert.equal(graph.edges.length, 68);
  assert.ok(graph.edges.every(edge => edge.direction === 'BIDIRECTIONAL'));
  const adapted = plannerSnapshot(graph, state).graph;
  const adjacency = buildAdjacency(adapted);
  for (const edge of adapted.edges) {
    const forward = adjacency.get(edge.from_node_id)
      .find(item => item.next === edge.to_node_id && item.edge.edge_id === edge.edge_id);
    const reverse = adjacency.get(edge.to_node_id)
      .find(item => item.next === edge.from_node_id && item.edge.edge_id === edge.edge_id);
    assert.ok(forward && reverse, edge.edge_id);
    assert.strictEqual(forward.edge, reverse.edge, edge.edge_id);
    assert.ok(Object.hasOwn(state.roads, edge.edge_id));
  }
});

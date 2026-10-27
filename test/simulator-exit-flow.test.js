'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { createSimulator, validateInvariants } = require('../server/simulator/simulator');
const { advanceExitIntents, advanceTransit, chooseReachableExit, dispatchNodeWalkers,
  plannerSnapshot, summarizeExitLedger } = require('../server/simulator/mobility');

const travel = { simulation_step_min: 5, minimum_edge_travel_min: 5, travel_time_multiplier: 1 };
const intent = { simulation_step_min: 5, exit_intent_rate: 1 };
const addMin = (value, minutes) => new Date(Date.parse(value.replace(' ', 'T') + 'Z') + minutes * 60000)
  .toISOString().slice(0, 19).replace('T', ' ');

function subset(nodeIds, edgeIds) {
  const graph = provider.getScenicGraph();
  graph.nodes = graph.nodes.filter(node => nodeIds.includes(node.node_id));
  graph.edges = graph.edges.filter(edge => edgeIds.includes(edge.edge_id));
  return graph;
}

function context(nodeIds = ['gate', 'market'], edgeIds = ['edge_002'], originNodeId = 'market') {
  const simulator = createSimulator({ initialGraph: subset(nodeIds, edgeIds), seed: 42 });
  const graph = simulator.getGraph(), state = simulator.getState();
  const movers = state.mobility_ledger.node_walkers.gate;
  state.mobility_ledger.node_walkers.gate = 0;
  state.mobility_ledger.node_walkers[originNodeId] += movers;
  return { graph, state, movers };
}

function depart(graph, state, options = {}) {
  return advanceExitIntents(graph, state, 5, options.parameters || intent, new SeededRNG(42),
    state.simulation_time, new Set(['gate']));
}

function progress(graph, state, minutes = 5) {
  const result = advanceTransit(graph, state, minutes, travel);
  state.simulation_time = addMin(state.simulation_time, minutes);
  return result;
}

function conserved(state) {
  const env = state.environment, ledger = state.population_ledger, mobility = state.mobility_ledger;
  const nodes = Object.values(mobility.node_walkers).reduce((sum, count) => sum + count, 0);
  const transit = mobility.transit_groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(env.initial_population + env.arrivals_total - env.departures_total, env.park_population);
  assert.equal(nodes + transit, ledger.walking);
  assert.equal(nodes + transit + ledger.queueing + ledger.inside_poi + ledger.resting
    + ledger.attending_event, env.park_population);
  assert.equal(ledger.exited_total, env.departures_total);
}

function exitClosed(state) {
  const ledger = summarizeExitLedger(state);
  assert.equal(ledger.exit_intent_created,
    ledger.exit_completed + ledger.exit_in_transit + ledger.exit_pending_at_node);
  assert.ok(ledger.exit_blocked <= ledger.exit_pending_at_node);
  return ledger;
}

test('C1 non-exit node walkers create reserved exit intent', () => {
  const { graph, state, movers } = context();
  const result = depart(graph, state);
  assert.equal(result.exit_intent_created, movers);
  assert.equal(state.mobility_ledger.exit_intent_created_total, movers);
  assert.equal(state.environment.departures_total, 0);
});

test('C2 exit choice uses a reachable C path and its travel cost', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_020'], 'temple');
  const chosen = chooseReachableExit(plannerSnapshot(graph, state), state.mobility_ledger,
    'temple', state.simulation_time);
  assert.equal(chosen.exit_node_id, 'gate');
  assert.deepEqual(chosen.route.edge_sequence, ['edge_020', 'edge_002']);
  assert.ok(chosen.route.travel_time_min > 0);
});

test('C3 exit intent cannot instantly remove non-gate walkers', () => {
  const { graph, state } = context();
  const park = state.environment.park_population;
  depart(graph, state);
  assert.equal(state.environment.park_population, park);
  assert.equal(state.environment.departures_total, 0);
  conserved(state);
});

test('C4 return cohort enters transit with EXIT_TRAVEL purpose', () => {
  const { graph, state, movers } = context();
  const result = depart(graph, state);
  assert.equal(result.exit_dispatches[0].count, movers);
  assert.equal(state.mobility_ledger.transit_groups[0].purpose, 'EXIT_TRAVEL');
  assert.equal(state.mobility_ledger.transit_groups[0].target_exit_id, 'gate');
});

test('gate walkers with exit intent depart directly through the same ledger', () => {
  const simulator = createSimulator({ initialGraph: subset(['gate', 'market'], ['edge_002']), seed: 42 });
  const graph = simulator.getGraph(), state = simulator.getState();
  const walkers = state.mobility_ledger.node_walkers.gate;
  const park = state.environment.park_population;
  const result = advanceExitIntents(graph, state, 5, intent, new SeededRNG(42), state.simulation_time);
  assert.equal(result.exit_departures_at_gate, walkers);
  assert.equal(state.mobility_ledger.node_walkers.gate, 0);
  assert.equal(state.environment.park_population, park - walkers);
  assert.equal(state.mobility_ledger.transit_groups.length, 0);
  conserved(state);
});

test('C5 a multi-edge return takes several steps to reach an exit', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'lake'],
    ['edge_001', 'edge_003', 'edge_004'], 'lake');
  depart(graph, state);
  const park = state.environment.park_population;
  progress(graph, state);
  assert.equal(state.environment.park_population, park);
  assert.ok(state.mobility_ledger.transit_groups.length);
  let completed = 0;
  for (let i = 0; i < 8; i += 1) completed += progress(graph, state).exit_arrivals_completed;
  assert.ok(completed > 0);
});

test('C6 park population decreases only after the group reaches an exit', () => {
  const { graph, state, movers } = context();
  const park = state.environment.park_population;
  depart(graph, state);
  assert.equal(state.environment.park_population, park);
  const result = progress(graph, state);
  assert.equal(result.exit_arrivals_completed, movers);
  assert.equal(state.environment.park_population, park - movers);
});

test('C7 exited_total and cumulative departures increase at arrival', () => {
  const { graph, state, movers } = context();
  depart(graph, state);
  progress(graph, state);
  assert.equal(state.population_ledger.exited_total, movers);
  assert.equal(state.environment.departures_total, movers);
  assert.equal(state.mobility_ledger.exit_arrivals_completed_total, movers);
});

test('C8 active return conserves population at node, transit and departure', () => {
  const { graph, state } = context();
  conserved(state);
  depart(graph, state);
  conserved(state);
  progress(graph, state);
  conserved(state);
  assert.equal(validateInvariants(state, null, null, null, graph).mobility, 'PASS');
});

test('C9 an unreachable original exit is replaced by another reachable exit', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_020'], 'temple');
  depart(graph, state);
  const group = state.mobility_ledger.transit_groups[0];
  assert.equal(group.target_exit_id, 'gate');
  state.roads.edge_001.is_open = false;
  state.roads.edge_002.is_open = false;
  progress(graph, state); // Finish temple -> market.
  const reroute = progress(graph, state);
  assert.equal(reroute.reroutes.length, 1);
  assert.equal(state.mobility_ledger.transit_groups[0].target_exit_id, 'southgate');
  conserved(state);
});

test('C10 with no reachable exit the cohort waits and retries after reopening', () => {
  const { graph, state, movers } = context();
  state.roads.edge_002.is_open = false;
  const blocked = depart(graph, state);
  assert.equal(blocked.exit_blocked, movers);
  assert.equal(state.mobility_ledger.pending_exit_intent.market, movers);
  assert.equal(state.mobility_ledger.node_walkers.market, movers);
  assert.equal(state.mobility_ledger.transit_groups.length, 0);
  conserved(state);
  state.roads.edge_002.is_open = true;
  const retry = depart(graph, state, { parameters: { ...intent, exit_intent_rate: 0 } });
  assert.equal(retry.exit_dispatches[0].count, movers);
});

test('blocked exit intent remains reserved from ordinary POI dispatch', () => {
  const { graph, state, movers } = context(['gate', 'market', 'rest'], ['edge_002', 'edge_008']);
  state.roads.edge_002.is_open = false;
  depart(graph, state);
  const ordinary = dispatchNodeWalkers(graph, state, 5,
    { poi_arrival_fraction: 1, queue_multiplier: 1, simulation_step_min: 5,
      max_dispatch_groups_per_node: 3 }, new SeededRNG(42), state.simulation_time);
  assert.equal(ordinary.length, 0);
  assert.equal(state.mobility_ledger.pending_exit_intent.market, movers);
  conserved(state);
});

test('C11 a road closed in transit triggers replanning at the next node', () => {
  const { graph, state } = context(['gate', 'southgate', 'temple', 'market', 'lake'],
    ['edge_001', 'edge_002', 'edge_003', 'edge_004', 'edge_020'], 'lake');
  depart(graph, state);
  const first = progress(graph, state);
  assert.ok(first.edge_entries.some(entry => entry.edge_id === 'edge_004'));
  state.roads.edge_020.is_open = false;
  state.roads.edge_020.closed_at = state.simulation_time;
  progress(graph, state); // Complete already-entered edge_004.
  const reroute = progress(graph, state);
  assert.ok(reroute.reroutes.length);
  assert.ok(!reroute.edge_entries.some(entry => entry.edge_id === 'edge_020'));
  conserved(state);
});

test('C12 queued and inside visitors cannot disappear through exit intent', () => {
  const { graph, state } = context();
  const queue = state.population_ledger.queueing, inside = state.population_ledger.inside_poi;
  depart(graph, state);
  assert.equal(state.population_ledger.queueing, queue);
  assert.equal(state.population_ledger.inside_poi, inside);
  assert.equal(state.environment.departures_total, 0);
});

test('C13 same seed replays return choices and trajectories exactly', () => {
  const run = () => {
    const simulator = createSimulator({ scenario: 'P0_BASELINE', seed: 42 });
    const trace = simulator.runSteps(20).map(step => ({ population: step.population,
      exit_dispatches: step.mobility_flow.exit_dispatches,
      exit_completions: step.mobility_flow.exit_completions }));
    return { trace, mobility: simulator.getState().mobility_ledger };
  };
  assert.deepEqual(run(), run());
});

test('C14 different seeds can produce different exit intent counts', () => {
  const count = seed => {
    const simulator = createSimulator({ scenario: 'P0_BASELINE', seed });
    simulator.runSteps(30);
    return simulator.getState().mobility_ledger.exit_intent_created_total;
  };
  assert.notEqual(count(42), count(43));
});

test('C15 one hundred steps preserve all spatial population invariants', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of simulator.runSteps(100)) assert.equal(step.invariant_summary.mobility, 'PASS');
  conserved(simulator.getState());
});

test('non-gate exit dispatch is matched by a later arrival and departure', () => {
  const simulator = createSimulator({ scenario: 'P0_BASELINE', seed: 42 });
  const steps = simulator.runSteps(50);
  const outgoing = steps.flatMap(step => step.mobility_flow.exit_dispatches)
    .find(group => !['gate', 'southgate', 'westgate', 'eastgate'].includes(group.origin_node_id));
  assert.ok(outgoing);
  const completed = steps.flatMap(step => step.mobility_flow.exit_completions)
    .find(group => group.group_id === outgoing.group_id && group.from_transit);
  assert.ok(completed);
  assert.equal(completed.count, outgoing.count);
  assert.ok(simulator.getState().environment.departures_total >= completed.count);
});

test('C16 created intent equals completed, in-transit and pending people', () => {
  const { graph, state, movers } = context();
  depart(graph, state);
  assert.deepEqual(exitClosed(state), { exit_intent_created: movers, exit_completed: 0,
    exit_in_transit: movers, exit_pending_at_node: 0, exit_blocked: 0 });
  progress(graph, state);
  assert.deepEqual(exitClosed(state), { exit_intent_created: movers, exit_completed: movers,
    exit_in_transit: 0, exit_pending_at_node: 0, exit_blocked: 0 });
});

test('C17 currently blocked intent is a subset of pending node intent', () => {
  const { graph, state, movers } = context();
  state.roads.edge_002.is_open = false;
  depart(graph, state);
  const ledger = exitClosed(state);
  assert.equal(ledger.exit_blocked, movers);
  assert.equal(ledger.exit_pending_at_node, movers);
});

test('C18 persistent pending intent is never generated a second time', () => {
  const { graph, state, movers } = context();
  state.roads.edge_002.is_open = false;
  depart(graph, state);
  const second = depart(graph, state);
  assert.equal(second.exit_intent_created, 0);
  assert.equal(state.mobility_ledger.exit_intent_created_total, movers);
  exitClosed(state);
});

test('C19 exit_in_transit is exactly the EXIT_TRAVEL cohort population', () => {
  const { graph, state } = context();
  depart(graph, state);
  assert.equal(exitClosed(state).exit_in_transit,
    state.mobility_ledger.transit_groups.filter(group => group.purpose === 'EXIT_TRAVEL')
      .reduce((sum, group) => sum + group.count, 0));
});

test('C20 pending exit intent remains inside identifiable node walkers', () => {
  const { graph, state, movers } = context();
  state.roads.edge_002.is_open = false;
  depart(graph, state);
  assert.equal(exitClosed(state).exit_pending_at_node, movers);
  for (const [id, count] of Object.entries(state.mobility_ledger.pending_exit_intent)) {
    assert.ok(count <= state.mobility_ledger.node_walkers[id]);
  }
});

test('C21 completed visitors remain in neither pending nor transit', () => {
  const { graph, state, movers } = context();
  depart(graph, state);
  progress(graph, state);
  const ledger = exitClosed(state);
  assert.equal(ledger.exit_completed, movers);
  assert.equal(ledger.exit_pending_at_node, 0);
  assert.equal(ledger.exit_in_transit, 0);
});

test('C22 fixed-seed hundred-step exit ledger closes at every step', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const result of simulator.runSteps(100)) {
    const ledger = result.mobility_flow.exit_ledger;
    assert.equal(ledger.exit_intent_created,
      ledger.exit_completed + ledger.exit_in_transit + ledger.exit_pending_at_node);
    assert.ok(ledger.exit_blocked <= ledger.exit_pending_at_node);
  }
  exitClosed(simulator.getState());
  conserved(simulator.getState());
});

test('corrupt exit intent counts fail the simulator invariant', () => {
  const simulator = createSimulator({ seed: 42 });
  const state = simulator.getState();
  state.mobility_ledger.exit_intent_created_total = 1;
  assert.throws(() => validateInvariants(state, null, null, null, simulator.getGraph()),
    /exit intent conservation/);
});

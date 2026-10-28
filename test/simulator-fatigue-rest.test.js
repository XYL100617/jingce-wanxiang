'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSimulator, validateInvariants } = require('../server/simulator/simulator');
const { resolveScenario, resolveParameters, PARAMETERS } = require('../server/simulator/parameter-registry');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { dispatchToPoi, dispatchNodeWalkers } = require('../server/simulator/mobility');
const { dispatchEventIntents } = require('../server/simulator/event-flow');
const { ageFatigue, completeRest, dispatchRestIntents, validateFatigueParameters,
  summarizeFatigue, mergeLevel, addNodeFatigue } = require('../server/simulator/fatigue-rest');

function fixture() {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  return { graph: sim.getGraph(), state: sim.getState(), parameters:
    resolveParameters(resolveScenario('P0_HIGH'), new SeededRNG(42)) };
}
function startRest(state, parameters, options = {}) {
  state.mobility_ledger.node_fatigue.gate = .8;
  return dispatchRestIntents(state, 5, { ...parameters, ...options }, new SeededRNG(42),
    state.simulation_time);
}
const stock = state => state.environment.park_population;
const sumPark = state => ['walking', 'queueing', 'inside_poi', 'attending_event', 'resting']
  .reduce((sum, key) => sum + state.population_ledger[key], 0);

test('F1 node walkers and transit groups gain walking fatigue', () => {
  const { graph, state, parameters } = fixture();
  dispatchToPoi({ graph, state, originNodeId: 'gate', poiId: 'market', count: 5 });
  const nodeBefore = state.mobility_ledger.node_fatigue.gate;
  const groupBefore = state.mobility_ledger.transit_groups[0].fatigue_level;
  ageFatigue(state, 5, parameters);
  assert.equal(state.mobility_ledger.node_fatigue.gate - nodeBefore,
    parameters.fatigue_walk_rate * 5);
  assert.equal(state.mobility_ledger.transit_groups[0].fatigue_level - groupBefore,
    parameters.fatigue_walk_rate * 5);
});
test('F2 queue, inside POI and event attendance use distinct fatigue rates', () => {
  const { state, parameters } = fixture();
  const poi = Object.values(state.pois).find(item => item.queue_count && item.inside_groups.length);
  const event = state.events['show-1'];
  event.attending_count = 2;
  state.population_ledger.attending_event += 2;
  state.mobility_ledger.node_walkers.gate -= 2;
  state.population_ledger.walking -= 2;
  const before = [poi.queue_fatigue, poi.inside_groups[0].fatigue_level, event.attending_fatigue];
  ageFatigue(state, 5, parameters);
  assert.ok(Math.abs(poi.queue_fatigue - before[0] - parameters.fatigue_queue_rate * 5) < 1e-12);
  assert.ok(Math.abs(poi.inside_groups[0].fatigue_level - before[1]
    - parameters.fatigue_visit_rate * 5) < 1e-12);
  assert.ok(Math.abs(event.attending_fatigue - before[2]
    - parameters.fatigue_event_rate * 5) < 1e-12);
});
test('F3 high-fatigue node walkers can enter rest', () => {
  const { state, parameters } = fixture();
  const result = startRest(state, parameters);
  assert.ok(result.rest_started > 0);
  assert.equal(state.rest_groups[0].node_id, 'gate');
});
test('F4 low-fatigue node walkers do not rest unconditionally', () => {
  const { state, parameters } = fixture();
  assert.equal(dispatchRestIntents(state, 5, parameters, new SeededRNG(42),
    state.simulation_time).rest_started, 0);
});
test('F5 resting fatigue recovers over time', () => {
  const { state, parameters } = fixture();
  startRest(state, parameters);
  const before = state.rest_groups[0].fatigue_level;
  ageFatigue(state, 5, parameters);
  assert.ok(state.rest_groups[0].fatigue_level < before);
});
test('F6 minimum rest duration blocks early release even below threshold', () => {
  const { state, parameters } = fixture();
  startRest(state, parameters);
  state.rest_groups[0].fatigue_level = 0;
  assert.equal(completeRest(state, '2026-10-20 10:28:00', parameters).rest_completed, 0);
});
test('F7 sufficiently recovered group returns to its original node', () => {
  const { state, parameters } = fixture();
  const result = startRest(state, parameters);
  ageFatigue(state, 15, parameters);
  const released = completeRest(state, '2026-10-20 10:33:00', parameters);
  assert.equal(released.rest_completed, result.rest_started);
  assert.equal(state.population_ledger.resting, 0);
  assert.equal(released.groups[0].node_id, 'gate');
});
test('F8 resting is included in the in-park population sum', () => {
  const { graph, state, parameters } = fixture();
  startRest(state, parameters);
  assert.equal(sumPark(state), stock(state));
  assert.equal(validateInvariants(state, null, null, null, graph).rest, 'PASS');
});
test('F9 walking to resting does not change park population', () => {
  const { state, parameters } = fixture();
  const before = stock(state), walking = state.population_ledger.walking;
  const { rest_started } = startRest(state, parameters);
  assert.equal(stock(state), before);
  assert.equal(state.population_ledger.walking, walking - rest_started);
});
test('F10 resting to walking does not change park population', () => {
  const { state, parameters } = fixture();
  startRest(state, parameters);
  const before = stock(state), walking = state.population_ledger.walking;
  ageFatigue(state, 15, parameters);
  const { rest_completed } = completeRest(state, '2026-10-20 10:33:00', parameters);
  assert.equal(stock(state), before);
  assert.equal(state.population_ledger.walking, walking + rest_completed);
});
test('F11 a reserved exit-intent group cannot enter rest', () => {
  const { state, parameters } = fixture();
  state.mobility_ledger.node_fatigue.gate = .8;
  state.mobility_ledger.pending_exit_intent.gate = state.mobility_ledger.node_walkers.gate;
  const flow = dispatchRestIntents(state, 5, parameters, new SeededRNG(42),
    state.simulation_time);
  assert.equal(flow.rest_started, 0);
});
test('F12 transit, event queue and attendance remain unavailable for immediate rest', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  sim.runSteps(10);
  const state = sim.getState(), parameters = fixture().parameters;
  const before = { transit: state.mobility_ledger.transit_groups.reduce((a, g) => a + g.count, 0),
    queue: state.events['show-1'].event_queue_count,
    attending: state.events['show-1'].attending_count };
  for (const id of Object.keys(state.mobility_ledger.node_fatigue)) state.mobility_ledger.node_fatigue[id] = .9;
  dispatchRestIntents(state, 5, parameters, new SeededRNG(42), state.simulation_time);
  assert.equal(state.mobility_ledger.transit_groups.reduce((a, g) => a + g.count, 0), before.transit);
  assert.equal(state.events['show-1'].event_queue_count, before.queue);
  assert.equal(state.events['show-1'].attending_count, before.attending);
});
test('F13 resting visitors cannot dispatch to a POI or event', () => {
  const { graph, state, parameters } = fixture();
  startRest(state, parameters, { rest_accept_rate: 1 });
  assert.equal(state.mobility_ledger.node_walkers.gate, 0);
  const event = dispatchEventIntents(graph, state, 5, parameters, new SeededRNG(42),
    state.simulation_time);
  const poi = dispatchNodeWalkers(graph, state, 5, parameters, new SeededRNG(42),
    state.simulation_time);
  assert.equal(event.event_intent_created, 0);
  assert.equal(poi.length, 0);
});
test('F14 trigger and release thresholds are separated by hysteresis', () => {
  const parameters = fixture().parameters;
  assert.ok(parameters.rest_trigger_threshold > parameters.rest_release_threshold);
  assert.throws(() => validateFatigueParameters({ ...parameters,
    rest_trigger_threshold: parameters.rest_release_threshold }), /thresholds/);
});
test('F15 same seed reproduces rest intent and fatigue trajectory', () => {
  const trace = () => createSimulator({ scenario: 'P0_HIGH', seed: 42 }).runSteps(50)
    .map(step => step.fatigue_summary);
  assert.deepEqual(trace(), trace());
});
test('F16 different seeds can change stochastic rest acceptance', () => {
  const trace = seed => createSimulator({ scenario: 'P0_HIGH', seed }).runSteps(35)
    .map(step => step.fatigue_summary.rest_started);
  assert.notDeepEqual(trace(42), trace(43));
});
test('F17 resting becomes nonzero during the first 50 steps', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const steps = sim.runSteps(50);
  assert.ok(steps.some(step => step.fatigue_summary.resting_current > 0));
  assert.ok(steps.at(-1).fatigue_summary.rest_completed_total > 0);
});
test('F18 one hundred steps preserve all population and fatigue invariants', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of sim.runSteps(100)) {
    assert.equal(step.invariant_summary.population, 'PASS');
    assert.equal(step.invariant_summary.rest, 'PASS');
    assert.equal(step.invariant_summary.fatigue, 'PASS');
  }
  assert.equal(sumPark(sim.getState()), stock(sim.getState()));
});
test('F19 show lifecycle still reaches RUNNING and FINISHED with attendance', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const steps = sim.runSteps(30);
  assert.ok(steps.some(step => step.event_status_changes.some(change => change.phase === 'RUNNING')));
  assert.ok(steps.some(step => step.event_flow_summary.event_admitted_count > 0));
  assert.equal(sim.getState().events['show-1'].phase, 'FINISHED');
  assert.equal(sim.getState().events['show-1'].attending_count, 0);
});
test('F20 visible visitor fatigue does not disclose latent rest groups or crowd fatigue', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', observationScenario: 'P1D_MIXED', seed: 42 });
  sim.runSteps(25);
  const observation = sim.getObservation();
  const latent = sim.getState();
  assert.equal(observation.visitor.fatigue, latent.visitor.fatigue);
  assert.equal(Object.hasOwn(observation, 'rest_groups'), false);
  assert.equal(Object.hasOwn(observation, 'mobility_ledger'), false);
  assert.equal(Object.hasOwn(observation, 'fatigue_summary'), false);
  assert.equal(PARAMETERS.fatigue_recovery_rate.source_tier, 'T4');
});

test('the first rest cohort is traceable from start to completion', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  let started = null, completed = null;
  for (const step of sim.runSteps(30)) {
    if (!started) started = step.fatigue_summary.rest_groups_started[0] || null;
    if (started) completed = step.fatigue_summary.rest_groups_completed
      .find(group => group.rest_id === started.rest_id) || completed;
  }
  assert.ok(started && completed);
  assert.equal(started.node_id, completed.node_id);
  assert.ok(completed.fatigue_level < started.fatigue_level);
  assert.ok(completed.completed_at >= started.minimum_rest_until);
});

test('F21 repeat rest is counted as person-events, not distinct visitors', () => {
  const { state, parameters } = fixture();
  const count = state.mobility_ledger.node_walkers.gate;
  const first = startRest(state, parameters, { rest_accept_rate: 1 });
  ageFatigue(state, 15, parameters);
  completeRest(state, '2026-10-20 10:33:00', parameters);
  state.simulation_time = '2026-10-20 10:33:00';
  state.mobility_ledger.node_fatigue.gate = .8;
  const second = dispatchRestIntents(state, 5, { ...parameters, rest_accept_rate: 1 },
    new SeededRNG(42), state.simulation_time);
  assert.equal(first.rest_started, count);
  assert.equal(second.rest_started, count);
  assert.equal(state.rest_started_total, count * 2);
  assert.equal(state.environment.park_population, stock(state));
});
test('F22 current resting always equals cumulative starts minus completions', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of sim.runSteps(100)) {
    const f = step.fatigue_summary;
    assert.equal(f.resting_current, f.rest_started_total - f.rest_completed_total);
  }
});
test('F23 merging fatigue uses person-weighted mean', () => {
  assert.ok(Math.abs(mergeLevel(9, .2, 1, 1) - .28) < 1e-12);
  const { state } = fixture();
  state.mobility_ledger.node_walkers.summit = 9;
  state.mobility_ledger.node_fatigue.summit = .2;
  addNodeFatigue(state.mobility_ledger, 'summit', 1, 1);
  assert.ok(Math.abs(state.mobility_ledger.node_fatigue.summit - .28) < 1e-12);
});
test('F24 splitting into rest and merging back preserves the person count', () => {
  const { graph, state, parameters } = fixture();
  const before = stock(state);
  const flow = startRest(state, parameters);
  assert.ok(flow.rest_started > 0 && flow.rest_started < before);
  assert.equal(sumPark(state), before);
  ageFatigue(state, 15, parameters);
  completeRest(state, '2026-10-20 10:33:00', parameters);
  assert.equal(sumPark(state), before);
  assert.equal(validateInvariants(state, null, null, null, graph).rest, 'PASS');
});
test('F25 fatigue remains inside [0,1] after growth, recovery and merge', () => {
  const { graph, state, parameters } = fixture();
  startRest(state, parameters);
  ageFatigue(state, 1000, parameters);
  addNodeFatigue(state.mobility_ledger, 'gate', 1, 10);
  const values = [state.visitor.fatigue, ...Object.values(state.mobility_ledger.node_fatigue),
    ...state.rest_groups.map(group => group.fatigue_level)];
  assert.ok(values.every(value => value >= 0 && value <= 1));
  assert.equal(validateInvariants(state, null, null, null, graph).fatigue, 'PASS');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSimulator, validateInvariants } = require('../server/simulator/simulator');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { resolveScenario, resolveParameters, resolveObservationParameters } = require('../server/simulator/parameter-registry');
const { generateObservation } = require('../server/simulator/observation');
const { PARAMETERS } = require('../server/simulator/parameter-registry');
const { dispatchEventIntents, advanceEventService, applyShowMilestone } = require('../server/simulator/event-flow');
const { advanceTransit } = require('../server/simulator/mobility');

const id = 'show-1';
const sum = values => values.reduce((total, value) => total + value, 0);
const show = state => state.events[id];
const params = () => resolveParameters(resolveScenario('P0_HIGH'), new SeededRNG(42));
const fixture = () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  return { graph: simulator.getGraph(), state: simulator.getState(), parameters: params() };
};
function moveWalkers(state, nodeId) {
  const total = state.population_ledger.walking;
  for (const key of Object.keys(state.mobility_ledger.node_walkers)) state.mobility_ledger.node_walkers[key] = 0;
  state.mobility_ledger.node_walkers[nodeId] = total;
}
function seedQueue(state, count) {
  const node = state.mobility_ledger.node_walkers.gate;
  assert.ok(node >= count);
  state.mobility_ledger.node_walkers.gate -= count;
  state.population_ledger.walking -= count;
  state.population_ledger.queueing += count;
  show(state).event_queue_count += count;
  show(state).intent_created_total += count;
  show(state).queue_arrivals_total += count;
}
function seedAttending(state, count) {
  seedQueue(state, count);
  state.population_ledger.queueing -= count;
  state.population_ledger.attending_event += count;
  show(state).event_queue_count -= count;
  show(state).attending_count += count;
  show(state).admitted_total += count;
}
function dispatchFromMuseum(seed = 42) {
  const { graph, state, parameters } = fixture();
  moveWalkers(state, 'museum');
  const result = dispatchEventIntents(graph, state, 5, parameters, new SeededRNG(seed),
    state.simulation_time);
  return { graph, state, parameters, result };
}
function milestone(state, type, time) {
  state.simulation_time = time;
  return applyShowMilestone(state, { target_id: id, event_type: type });
}

test('E1 walkers can create an event intent', () => {
  const { result } = dispatchFromMuseum();
  assert.ok(result.event_intent_created > 0);
});
test('E2 a distant event intent becomes an EVENT_TRAVEL cohort with a C route', () => {
  const { state } = dispatchFromMuseum();
  const group = state.mobility_ledger.transit_groups.find(item => item.purpose === 'EVENT_TRAVEL');
  assert.equal(group.target_event_id, id);
  assert.equal(group.path.node_sequence.at(-1), 'theater');
  assert.ok(group.path.edge_sequence.length > 0);
});
test('E3 dispatch does not teleport visitors to the event node', () => {
  const { state, result } = dispatchFromMuseum();
  assert.equal(state.mobility_ledger.node_walkers.theater, 0);
  assert.equal(show(state).event_queue_count, 0);
  assert.equal(sum(state.mobility_ledger.transit_groups.filter(g => g.purpose === 'EVENT_TRAVEL').map(g => g.count)),
    result.event_intent_created);
});
test('E4 event travelers join the event queue after traversing their path', () => {
  const { graph, state, parameters } = dispatchFromMuseum();
  let arrivals = 0;
  for (let i = 0; i < 20 && arrivals === 0; i += 1) {
    const flow = advanceTransit(graph, state, 5, parameters);
    arrivals += flow.event_arrived_total;
    state.simulation_time = new Date(Date.parse(state.simulation_time.replace(' ', 'T') + 'Z') + 300000)
      .toISOString().slice(0, 19).replace('T', ' ');
  }
  assert.ok(arrivals > 0);
  assert.equal(show(state).event_queue_count, arrivals);
});
test('E5 simultaneous attendance respects event capacity', () => {
  const { state, parameters } = fixture();
  seedQueue(state, 40);
  show(state).phase = 'BOARDING';
  show(state).capacity = 6;
  advanceEventService(state, 5, parameters);
  assert.equal(show(state).attending_count, 6);
  assert.equal(show(state).event_queue_count, 34);
});
test('E6 BOARDING transfers queue to attending using the admission rate', () => {
  const { state, parameters } = fixture();
  seedQueue(state, 30);
  show(state).phase = 'BOARDING';
  const flow = advanceEventService(state, 5, parameters)[id];
  assert.equal(flow.admitted, 20);
  assert.equal(show(state).attending_count, 20);
  assert.equal(show(state).event_queue_count, 10);
});
test('E7 RUNNING attendees remain until the show ends', () => {
  const { state, parameters } = fixture();
  seedAttending(state, 12);
  show(state).phase = 'RUNNING';
  state.simulation_time = '2026-10-20 11:25:00';
  const flow = advanceEventService(state, 5, parameters)[id];
  assert.equal(flow.released, 0);
  assert.equal(show(state).attending_count, 12);
});
test('E8 latest entry returns the unadmitted queue to walking', () => {
  const { state } = fixture();
  seedQueue(state, 11);
  const before = state.population_ledger.walking;
  const flow = milestone(state, 'SHOW_LATEST_ENTRY', show(state).latest_entry_time);
  assert.equal(flow.missed, 11);
  assert.equal(show(state).event_queue_count, 0);
  assert.equal(state.population_ledger.walking, before + 11);
  assert.equal(state.mobility_ledger.node_walkers.theater, 11);
});
test('E9 no new event intent is created at latest entry', () => {
  const { graph, state, parameters } = fixture();
  moveWalkers(state, 'museum');
  const flow = dispatchEventIntents(graph, state, 5, parameters, new SeededRNG(42),
    show(state).latest_entry_time);
  assert.equal(flow.event_intent_created, 0);
});
test('E10 no release occurs before the end timestamp', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  let last;
  while (sim.getState().simulation_time < '2026-10-20 11:48:00') last = sim.step();
  assert.equal(last.event_flow_summary.event_released_count, 0);
  assert.ok(sim.getState().events[id].attending_count > 0);
});
test('E11 show end enters RELEASING when attendees remain', () => {
  const { state } = fixture();
  seedAttending(state, 12);
  const result = milestone(state, 'SHOW_END', show(state).end_time);
  assert.equal(result.phase, 'RELEASING');
});
test('E12 release is rate limited across intervals', () => {
  const { state, parameters } = fixture();
  seedAttending(state, 27);
  show(state).phase = 'RELEASING';
  assert.equal(advanceEventService(state, 5, parameters)[id].released, 20);
  assert.equal(show(state).attending_count, 7);
  assert.equal(advanceEventService(state, 5, parameters)[id].released, 7);
});
test('E13 released visitors return to walkers at the event node', () => {
  const { state, parameters } = fixture();
  seedAttending(state, 8);
  show(state).phase = 'RELEASING';
  const before = state.mobility_ledger.node_walkers.theater;
  advanceEventService(state, 5, parameters);
  assert.equal(state.mobility_ledger.node_walkers.theater, before + 8);
  assert.equal(state.population_ledger.walking,
    sum(Object.values(state.mobility_ledger.node_walkers)));
});
test('E14 release finishes with zero attendance and zero event queue', () => {
  const { state, parameters } = fixture();
  seedAttending(state, 21);
  show(state).phase = 'RELEASING';
  advanceEventService(state, 5, parameters);
  advanceEventService(state, 5, parameters);
  assert.equal(show(state).phase, 'FINISHED');
  assert.equal(show(state).attending_count, 0);
  assert.equal(show(state).event_queue_count, 0);
});
test('E15 park population includes event queue and attendance', () => {
  const { graph, state } = fixture();
  seedQueue(state, 7);
  seedAttending(state, 9);
  assert.equal(state.environment.park_population,
    sum(['walking', 'queueing', 'inside_poi', 'attending_event', 'resting'].map(k => state.population_ledger[k])));
  assert.equal(validateInvariants(state, null, null, null, graph).event, 'PASS');
});
test('E16 combined queue ledger equals POI queues plus event queues', () => {
  const { graph, state } = fixture();
  seedQueue(state, 7);
  const queues = sum(Object.values(state.pois).map(poi => poi.queue_count))
    + sum(Object.values(state.events).filter(event => event.is_show_event).map(event => event.event_queue_count));
  assert.equal(state.population_ledger.queueing, queues);
  assert.equal(validateInvariants(state, null, null, null, graph).queue, 'PASS');
});
test('E17 a mid-trip closure prevents entry to the next edge and triggers a C reroute', () => {
  const { graph, state, parameters } = fixture();
  dispatchEventIntents(graph, state, 5, parameters, new SeededRNG(42), state.simulation_time);
  const group = state.mobility_ledger.transit_groups.find(item => item.purpose === 'EVENT_TRAVEL');
  assert.ok(group.path.edge_sequence.length >= 2);
  const nextEdge = group.path.edge_sequence[1];
  advanceTransit(graph, state, 5, parameters);
  assert.equal(group.current_edge_id, group.path.edge_sequence[0]);
  state.simulation_time = '2026-10-20 10:23:00';
  state.roads[nextEdge].is_open = false;
  state.roads[nextEdge].closed_at = state.simulation_time;
  const flows = [];
  for (let i = 0; i < 20; i += 1) {
    const flow = advanceTransit(graph, state, 5, parameters);
    flows.push(flow);
    if (flow.reroutes.length || flow.event_missed_total > 0) break;
    state.simulation_time = new Date(Date.parse(state.simulation_time.replace(' ', 'T') + 'Z') + 300000)
      .toISOString().slice(0, 19).replace('T', ' ');
  }
  assert.ok(flows.every(flow => flow.edge_entries.every(item => item.edge_id !== nextEdge)));
  assert.ok(flows.some(flow => flow.reroutes.length || flow.event_missed_total > 0));
});
test('E18 event trajectories are reproducible with the same seed', () => {
  const trace = () => createSimulator({ scenario: 'P0_HIGH', seed: 42 }).runSteps(25)
    .map(step => [step.event_flow_summary, step.event_flows, step.event_status_changes]);
  assert.deepEqual(trace(), trace());
});
test('E19 a different seed can change event interest counts', () => {
  const trace = seed => createSimulator({ scenario: 'P0_HIGH', seed }).runSteps(12)
    .map(step => step.event_flow_summary.event_intent_created);
  assert.notDeepEqual(trace(42), trace(43));
});
test('E20 one hundred steps preserve all event and population invariants', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of sim.runSteps(100)) {
    assert.equal(step.invariant_summary.population, 'PASS');
    assert.equal(step.invariant_summary.event, 'PASS');
    assert.equal(step.invariant_summary.mobility, 'PASS');
    for (const [eventId, row] of Object.entries(step.event_flows)) {
      assert.equal(row.queue_after, row.queue_before + row.arrivals - row.admitted - row.queue_missed, eventId);
      assert.equal(row.attending_after, row.attending_before + row.admitted - row.released, eventId);
    }
  }
});
test('E21 ordinary event counts may be missing while current status stays authoritative', () => {
  const { state } = fixture();
  seedQueue(state, 20);
  const observation = generateObservation(state, { next: () => 0 },
    resolveObservationParameters(), 'P1D_MISSING');
  assert.equal(observation.events[id].event_queue_count, null);
  assert.equal(observation.events[id].attending_count, null);
  assert.equal(observation.events[id].phase, show(state).phase);
  assert.equal(observation.missing_mask.events[id].event_queue_count, true);
  assert.equal(Object.hasOwn(observation.events[id], 'released_count'), false);
  assert.equal(Object.hasOwn(observation.events[id], 'intent_created_total'), false);
});
test('E22 delayed event counts do not reveal the current latent queue', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', observationScenario: 'P1D_DELAYED', seed: 42 });
  let latent, visible;
  for (let i = 0; i < 25; i += 1) {
    sim.step();
    latent = sim.getState();
    visible = sim.getObservation();
    if (latent.events[id].event_queue_count > 0
      && visible.events[id].event_queue_count !== latent.events[id].event_queue_count) break;
  }
  assert.ok(latent.events[id].event_queue_count > 0);
  assert.notEqual(visible.events[id].event_queue_count, latent.events[id].event_queue_count);
  assert.equal(visible.events[id].phase, latent.events[id].phase);
  assert.ok(visible.events[id].status_available_at > visible.events[id].observed_at);
});
test('E23 boarding start is derived from a registered T4 assumption', () => {
  const event = show(createSimulator().getState());
  assert.equal(PARAMETERS.event_boarding_lead_min.value, 30);
  assert.equal(PARAMETERS.event_boarding_lead_min.source_tier, 'T4');
  assert.equal(PARAMETERS.event_boarding_lead_min.parameter_basis, 'ASSUMPTION');
  assert.equal(event.boarding_open_time, '2026-10-20 10:50:00');
  assert.deepEqual(event.time_sources.boarding_start,
    { type: 'DERIVED_T4', parameter: 'event_boarding_lead_min' });
});
test('E24 BOARDING begins at its exact milestone, never before', () => {
  const sim = createSimulator();
  sim.runSteps(6);
  assert.equal(show(sim.getState()).phase, 'BEFORE_ENTRY');
  const step = sim.step();
  assert.equal(show(sim.getState()).phase, 'BOARDING');
  assert.equal(step.event_status_changes.find(change => change.event_type === 'SHOW_BOARDING').timestamp,
    '2026-10-20 10:50:00');
});
test('E25 RUNNING begins at start_time, never before', () => {
  const sim = createSimulator();
  sim.runSteps(12);
  assert.equal(show(sim.getState()).phase, 'BOARDING');
  const step = sim.step();
  assert.equal(show(sim.getState()).phase, 'RUNNING');
  assert.equal(step.event_status_changes.find(change => change.event_type === 'SHOW_START').timestamp,
    show(sim.getState()).start_time);
});
test('E26 RELEASING begins at end_time, never before', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  sim.runSteps(18);
  assert.equal(show(sim.getState()).phase, 'RUNNING');
  const step = sim.step();
  assert.equal(show(sim.getState()).phase, 'RELEASING');
  assert.equal(step.event_status_changes.find(change => change.event_type === 'SHOW_END').timestamp,
    show(sim.getState()).end_time);
});
test('E27 missing source end time uses a registered T4 duration', () => {
  const event = show(createSimulator().getState());
  assert.equal(event.end_time, '2026-10-20 11:50:00');
  assert.equal(event.end_time_basis, 'DERIVED_T4');
  assert.deepEqual(event.time_sources.end_time,
    { type: 'DERIVED_T4', parameter: 'default_event_duration_min' });
  assert.equal(PARAMETERS.default_event_duration_min.source_tier, 'T4');
});
test('E28 aggregate intent rejects a route projected after latest entry', () => {
  const { graph, state, parameters } = fixture();
  moveWalkers(state, 'museum');
  show(state).latest_entry_time = '2026-10-20 10:20:00';
  const flow = dispatchEventIntents(graph, state, 5, parameters, new SeededRNG(42),
    state.simulation_time);
  assert.equal(flow.event_intent_created, 0);
  assert.equal(state.mobility_ledger.transit_groups.length, 0);
});
test('E29 delayed EVENT_TRAVEL returns to walking and records a miss', () => {
  const { graph, state, parameters } = dispatchFromMuseum();
  const count = state.mobility_ledger.transit_groups[0].count;
  advanceTransit(graph, state, 5, parameters);
  const nodeWalkersBefore = sum(Object.values(state.mobility_ledger.node_walkers));
  state.simulation_time = '2026-10-20 11:22:00';
  let missed = 0;
  for (let i = 0; i < 20 && missed === 0; i += 1) {
    const flow = advanceTransit(graph, state, 5, parameters);
    missed += flow.event_missed_total;
    state.simulation_time = new Date(Date.parse(state.simulation_time.replace(' ', 'T') + 'Z') + 300000)
      .toISOString().slice(0, 19).replace('T', ' ');
  }
  assert.equal(missed, count);
  assert.equal(show(state).event_queue_count, 0);
  assert.equal(sum(Object.values(state.mobility_ledger.node_walkers)), nodeWalkersBefore + count);
});
test('E30 each show time carries a traceable source type', () => {
  const sim = createSimulator();
  const event = show(sim.getState());
  assert.deepEqual(Object.fromEntries(Object.entries(event.time_sources)
    .map(([key, value]) => [key, value.type])), {
    boarding_start: 'DERIVED_T4', latest_entry_time: 'BUSINESS_DEMO',
    start_time: 'BUSINESS_DEMO', end_time: 'DERIVED_T4'
  });
  assert.deepEqual(sim.getObservation().events[id].time_sources, event.time_sources);
});

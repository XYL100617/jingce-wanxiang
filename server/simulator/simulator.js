'use strict';

const provider = require('../state/stateProvider');
const { SeededRNG } = require('./seeded-rng');
const { resolveScenario, resolveParameters, VERSION } = require('./parameter-registry');
const { EventClock } = require('./event-clock');
const { createSimulationState, clone, GRAPH_VERSION } = require('./simulation-state');
const { advancePopulation, advanceQueues } = require('./dynamics');
const { evaluateLegalActions } = require('./legal-action-adapter');

function validateEvents(events, graph) {
  const edgeIds = new Set(graph.edges.map(edge => edge.edge_id));
  const poiIds = new Set(graph.nodes.map(node => node.poi_id).filter(Boolean));
  for (const event of events) {
    const known = event.event_type.startsWith('ROAD_') ? edgeIds.has(event.target_id) : poiIds.has(event.target_id);
    if (!known) throw new RangeError(`unknown ${event.event_type} target_id: ${event.target_id}`);
  }
}

function applyEvent(state, event) {
  const close = event.event_type.endsWith('CLOSE');
  if (event.event_type.startsWith('ROAD_')) state.roads[event.target_id].is_open = !close;
  else state.pois[event.target_id].is_open = !close;
  return { timestamp: state.simulation_time, event_id: event.event_id, event_type: event.event_type, target_id: event.target_id, is_open: !close };
}

function validateInvariants(state, previousTime = null, populationLedger = null, legal = null) {
  if (state.graph_version !== GRAPH_VERSION) throw new Error('graph_version invariant failed');
  if (!Number.isSafeInteger(state.environment.park_population) || state.environment.park_population < 0) throw new Error('park population invariant failed');
  if (previousTime !== null && Date.parse(state.simulation_time.replace(' ', 'T') + 'Z') <= Date.parse(previousTime.replace(' ', 'T') + 'Z')) {
    throw new Error('simulation time did not advance');
  }
  if (populationLedger && populationLedger.population_after !== populationLedger.population_before + populationLedger.arrivals - populationLedger.departures) {
    throw new Error('population conservation failed');
  }
  for (const [id, poi] of Object.entries(state.pois)) {
    if (!Number.isSafeInteger(poi.queue) || poi.queue < 0 || !Number.isFinite(poi.capacity) || poi.capacity < 0 || !Number.isFinite(poi.service_rate) || poi.service_rate < 0) {
      throw new Error(`POI invariant failed: ${id}`);
    }
  }
  for (const [id, road] of Object.entries(state.roads)) {
    if (!Number.isFinite(road.base_travel_time_min) || road.base_travel_time_min < 0 || !Number.isFinite(road.speed_factor) || road.speed_factor <= 0) {
      throw new Error(`road invariant failed: ${id}`);
    }
  }
  if (legal) for (const item of legal.legal) {
    for (const edgeId of [...(item.route?.edge_sequence || []), ...(item.return_route?.edge_sequence || [])]) {
      if (!state.roads[edgeId]?.is_open) throw new Error(`closed road in legal route: ${edgeId}`);
    }
  }
  return { population: 'PASS', queue: 'PASS', closed_road: 'PASS', graph_version: 'PASS', time: 'PASS' };
}

function createSimulator({ initialGraph = provider.getScenicGraph(), initialState = provider.getState(), scenario = 'P0_BASELINE', seed = 42, events = [], rules = {} } = {}) {
  const sourceGraph = clone(initialGraph);
  const sourceState = clone(initialState);
  const sourceEvents = clone(events);
  const rng = new SeededRNG(seed);
  const selectedScenario = resolveScenario(scenario);
  const parameters = resolveParameters(selectedScenario, rng);
  const { graph, state } = createSimulationState(sourceGraph, sourceState, selectedScenario, parameters);
  const clock = new EventClock(state.simulation_time, parameters.simulation_step_min, sourceEvents);
  validateEvents(sourceEvents, graph);
  validateInvariants(state);

  function getLegalActionsSnapshot() {
    const result = evaluateLegalActions(graph, state, rules);
    validateInvariants(state, null, null, result);
    return clone(result);
  }

  function step() {
    const beforeTime = state.simulation_time;
    const populationBefore = state.environment.park_population;
    const queueBefore = Object.values(state.pois).reduce((sum, poi) => sum + poi.queue, 0);
    const schedule = clock.nextStep();
    let cursor = schedule.startMs;
    let arrivals = 0, departures = 0, queueArrivals = 0, queueServed = 0;
    const applied = [];

    for (const checkpoint of schedule.checkpoints) {
      const durationMin = (checkpoint.timeMs - cursor) / 60000;
      if (durationMin > 0) {
        const population = advancePopulation(state.environment, durationMin, parameters, rng);
        const queueLedger = advanceQueues(state.pois, durationMin, parameters, rng);
        arrivals += population.arrivals;
        departures += population.departures;
        queueArrivals += Object.values(queueLedger).reduce((sum, row) => sum + row.arrivals, 0);
        queueServed += Object.values(queueLedger).reduce((sum, row) => sum + row.served, 0);
        state.visitor.remaining_time_min = Math.max(0, Math.round((state.visitor.remaining_time_min - durationMin) * 1000) / 1000);
        cursor = checkpoint.timeMs;
      }
      state.simulation_time = checkpoint.timestamp;
      for (const event of checkpoint.events) applied.push(applyEvent(state, event));
    }
    state.step_count += 1;
    const population = { population_before: populationBefore, arrivals, departures, population_after: state.environment.park_population };
    const queueAfter = Object.values(state.pois).reduce((sum, poi) => sum + poi.queue, 0);
    if (queueAfter !== queueBefore + queueArrivals - queueServed) throw new Error('POI queue conservation failed');
    const legal = evaluateLegalActions(graph, state, rules);
    const invariant_summary = validateInvariants(state, beforeTime, population, legal);
    return clone({
      timestamp: state.simulation_time,
      population,
      poi_queue_summary: { queue_before: queueBefore, arrivals: queueArrivals, served: queueServed, queue_after: queueAfter },
      road_status_changes: applied.filter(event => event.event_type.startsWith('ROAD_')),
      poi_status_changes: applied.filter(event => event.event_type.startsWith('POI_')),
      legal_actions: legal.legal,
      rejected_actions: legal.rejected,
      invariant_summary
    });
  }

  function runSteps(count) {
    if (!Number.isInteger(count) || count < 0 || count > 10000) throw new RangeError('count must be an integer from 0 to 10000');
    return Array.from({ length: count }, () => step());
  }

  return {
    step, runSteps,
    getState: () => clone(state),
    getGraph: () => clone(graph),
    getLegalActions: getLegalActionsSnapshot,
    getMetadata: () => ({ graph_version: GRAPH_VERSION, scenario_id: scenario, seed, parameter_version: VERSION, synthetic: true, source_tier: 'T4' }),
    reset: (nextSeed = seed) => createSimulator({ initialGraph: sourceGraph, initialState: sourceState, scenario, seed: nextSeed, events: sourceEvents, rules })
  };
}

module.exports = { createSimulator, validateInvariants };

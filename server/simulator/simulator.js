'use strict';

const provider = require('../state/stateProvider');
const { SeededRNG } = require('./seeded-rng');
const { resolveScenario, resolveParameters, VERSION } = require('./parameter-registry');
const { EventClock } = require('./event-clock');
const { createSimulationState, clone, GRAPH_VERSION } = require('./simulation-state');
const { advancePopulation, advancePoiService } = require('./dynamics');
const { evaluateLegalActions } = require('./legal-action-adapter');
const { dispatchNodeWalkers, advanceTransit, advanceExitIntents, summarizeExitLedger } = require('./mobility');
const { toMillis } = require('../planner/time');

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
  if (event.event_type.startsWith('ROAD_')) {
    state.roads[event.target_id].is_open = !close;
    state.roads[event.target_id].closed_at = close ? state.simulation_time : null;
  }
  else state.pois[event.target_id].is_open = !close;
  return { timestamp: state.simulation_time, event_id: event.event_id, event_type: event.event_type, target_id: event.target_id, is_open: !close };
}

function validateInvariants(state, previousTime = null, populationLedger = null, legal = null, graph = null) {
  if (state.graph_version !== GRAPH_VERSION) throw new Error('graph_version invariant failed');
  if (!Number.isSafeInteger(state.environment.park_population) || state.environment.park_population < 0) throw new Error('park population invariant failed');
  const ledger = state.population_ledger;
  const inPark = ['walking', 'queueing', 'inside_poi', 'resting', 'attending_event'];
  for (const key of [...inPark, 'outside', 'exited_total']) {
    if (!Number.isSafeInteger(ledger[key]) || ledger[key] < 0) throw new Error(`population ledger invalid: ${key}`);
  }
  if (inPark.reduce((sum, key) => sum + ledger[key], 0) !== state.environment.park_population) {
    throw new Error('park population differs from in-park ledger');
  }
  if (state.environment.initial_population + state.environment.arrivals_total - state.environment.departures_total !== state.environment.park_population) {
    throw new Error('cumulative park population conservation failed');
  }
  if (ledger.exited_total !== state.environment.departures_total) throw new Error('exited total differs from cumulative departures');
  const mobility = state.mobility_ledger;
  const nodeIds = graph ? new Set(graph.nodes.map(node => node.node_id)) : new Set(Object.keys(mobility.node_walkers));
  const edgeById = graph ? new Map(graph.edges.map(edge => [edge.edge_id, edge])) : null;
  if (!nodeIds.has(mobility.entry_node_id) || !mobility.exit_node_ids.length
    || mobility.exit_node_ids.some(id => !nodeIds.has(id))) throw new Error('invalid mobility entrance or exit');
  let nodeTotal = 0, transitTotal = 0;
  for (const [id, count] of Object.entries(mobility.node_walkers)) {
    if (!nodeIds.has(id) || !Number.isSafeInteger(count) || count < 0) throw new Error(`invalid node walkers: ${id}`);
    if (!Number.isSafeInteger(mobility.pending_exit_intent[id]) || mobility.pending_exit_intent[id] < 0
      || mobility.pending_exit_intent[id] > count
      || !Number.isSafeInteger(mobility.blocked_exit_intent[id]) || mobility.blocked_exit_intent[id] < 0
      || mobility.blocked_exit_intent[id] > mobility.pending_exit_intent[id]) {
      throw new Error(`invalid pending or blocked exit intent: ${id}`);
    }
    nodeTotal += count;
  }
  if (Object.keys(mobility.pending_exit_intent).length !== Object.keys(mobility.node_walkers).length
    || Object.keys(mobility.blocked_exit_intent).length !== Object.keys(mobility.node_walkers).length
    || !['exit_intent_created_total', 'exit_completed_total', 'exit_arrivals_completed_total',
      'exit_blocked_attempts_total']
      .every(key => Number.isSafeInteger(mobility[key]) && mobility[key] >= 0)
    || mobility.exit_arrivals_completed_total > mobility.exit_completed_total
    || mobility.exit_completed_total !== ledger.exited_total) throw new Error('exit intent ledger invalid');
  for (const [poiId, nodeId] of Object.entries(mobility.poi_node_map)) {
    if (!state.pois[poiId] || !nodeIds.has(nodeId)) throw new Error(`invalid POI node mapping: ${poiId}`);
  }
  for (const group of mobility.transit_groups) {
    const { node_sequence: nodes, edge_sequence: edges } = group.path;
    const validDestination = group.purpose === 'EXIT_TRAVEL'
      ? mobility.exit_node_ids.includes(group.target_exit_id) && group.target_exit_id === group.destination_node_id
      : group.purpose === 'POI_TRAVEL' && !!state.pois[group.destination_poi_id];
    if (!Number.isSafeInteger(group.count) || group.count <= 0 || !nodeIds.has(group.current_node_id)
      || !nodeIds.has(group.destination_node_id) || !validDestination
      || !Array.isArray(nodes) || !Array.isArray(edges) || nodes.length !== edges.length + 1
      || nodes.at(-1) !== group.destination_node_id || !Number.isInteger(group.path_index)
      || group.path_index < 0 || group.path_index >= edges.length
      || nodes[group.path_index] !== group.current_node_id) throw new Error(`invalid transit group: ${group.group_id}`);
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edgeById?.get(edges[i]);
      if (!state.roads[edges[i]] || !nodeIds.has(nodes[i]) || !nodeIds.has(nodes[i + 1])
        || (edge && !((edge.from_node_id === nodes[i] && edge.to_node_id === nodes[i + 1])
          || (edge.direction === 'BIDIRECTIONAL' && edge.to_node_id === nodes[i] && edge.from_node_id === nodes[i + 1])))) {
        throw new Error(`invalid transit path: ${group.group_id}`);
      }
    }
    if (group.current_edge_id) {
      const road = state.roads[group.current_edge_id];
      if (group.current_edge_id !== edges[group.path_index] || !(group.remaining_edge_min > 0)
        || !group.edge_entered_at || (!road.is_open && (!road.closed_at
          || Date.parse(group.edge_entered_at.replace(' ', 'T') + 'Z') >= Date.parse(road.closed_at.replace(' ', 'T') + 'Z')))) {
        throw new Error(`closed or invalid edge entry: ${group.group_id}`);
      }
    } else if (group.remaining_edge_min !== 0) throw new Error(`invalid transit edge clock: ${group.group_id}`);
    transitTotal += group.count;
  }
  if (nodeTotal + transitTotal !== ledger.walking) throw new Error('spatial walking ledger differs from population ledger');
  const exitLedger = summarizeExitLedger(state);
  if (exitLedger.exit_intent_created !== exitLedger.exit_completed + exitLedger.exit_in_transit
      + exitLedger.exit_pending_at_node
    || exitLedger.exit_blocked > exitLedger.exit_pending_at_node) throw new Error('exit intent conservation failed');
  if (previousTime !== null && Date.parse(state.simulation_time.replace(' ', 'T') + 'Z') <= Date.parse(previousTime.replace(' ', 'T') + 'Z')) {
    throw new Error('simulation time did not advance');
  }
  if (populationLedger && populationLedger.population_after !== populationLedger.population_before + populationLedger.arrivals - populationLedger.departures) {
    throw new Error('population conservation failed');
  }
  let queueSum = 0, insideSum = 0;
  for (const [id, poi] of Object.entries(state.pois)) {
    if (!Number.isSafeInteger(poi.queue_count) || poi.queue_count < 0 || poi.queue !== poi.queue_count
      || !Number.isSafeInteger(poi.inside_count) || poi.inside_count < 0
      || !Number.isFinite(poi.capacity) || poi.capacity < 0 || poi.inside_count > poi.capacity
      || !Number.isFinite(poi.service_rate) || poi.service_rate < 0
      || !Number.isFinite(poi.admission_rate) || poi.admission_rate < 0
      || !Number.isFinite(poi.visit_duration_min) || poi.visit_duration_min <= 0
      || !Array.isArray(poi.inside_groups)
      || poi.inside_groups.reduce((sum, group) => sum + group.count, 0) !== poi.inside_count
      || poi.inside_groups.some(group => !Number.isSafeInteger(group.count) || group.count <= 0
        || group.poi_id !== id || !Number.isFinite(toMillis(group.entered_at))
        || !Number.isFinite(toMillis(group.leave_at))
        || toMillis(group.leave_at) <= toMillis(group.entered_at))) {
      throw new Error(`POI invariant failed: ${id}`);
    }
    queueSum += poi.queue_count;
    insideSum += poi.inside_count;
  }
  if (queueSum !== ledger.queueing || insideSum !== ledger.inside_poi) throw new Error('POI totals differ from population ledger');
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
  return { population: 'PASS', queue: 'PASS', ledger: 'PASS', mobility: 'PASS', inside_capacity: 'PASS',
    cumulative_population: 'PASS', closed_road: 'PASS', graph_version: 'PASS', time: 'PASS' };
}

function createSimulator({ initialGraph = provider.getScenicGraph(), initialState = provider.getState(), scenario = 'P0_BASELINE', seed = 42, events = [], rules = {} } = {}) {
  const sourceGraph = clone(initialGraph);
  const sourceState = clone(initialState);
  const sourceEvents = clone(events);
  const rng = new SeededRNG(seed);
  const selectedScenario = resolveScenario(scenario);
  const parameters = resolveParameters(selectedScenario, rng);
  const arrivalOnlyParameters = Object.freeze({ ...parameters, departure_rate: 0 });
  const { graph, state } = createSimulationState(sourceGraph, sourceState, selectedScenario, parameters);
  const clock = new EventClock(state.simulation_time, parameters.simulation_step_min, sourceEvents);
  validateEvents(sourceEvents, graph);
  validateInvariants(state, null, null, null, graph);

  function getLegalActionsSnapshot() {
    const result = evaluateLegalActions(graph, state, rules);
    validateInvariants(state, null, null, result, graph);
    return clone(result);
  }

  function step() {
    const beforeTime = state.simulation_time;
    const populationBefore = state.environment.park_population;
    const walkingBefore = state.population_ledger.walking;
    const queueBefore = state.population_ledger.queueing;
    const insideBefore = state.population_ledger.inside_poi;
    const nodeBefore = Object.values(state.mobility_ledger.node_walkers).reduce((sum, count) => sum + count, 0);
    const transitBefore = state.mobility_ledger.transit_groups.reduce((sum, group) => sum + group.count, 0);
    const poiFlows = Object.fromEntries(Object.entries(state.pois).map(([id, poi]) => [id, {
      queue_before: poi.queue_count, inside_before: poi.inside_count, arrivals: 0,
      admitted: 0, completed: 0, served: 0
    }]));
    const schedule = clock.nextStep();
    let cursor = schedule.startMs;
    let arrivals = 0, departures = 0, queueArrivals = 0, admitted = 0, completed = 0;
    const applied = [];
    const mobilityEvents = { dispatched: [], edge_entries: [], reroutes: [], blocked: [],
      arrived_total: 0, closed_poi_returns: 0, closed_poi_nodes: [],
      exit_intent_created: 0, exit_arrivals_completed: 0, exit_departures_at_gate: 0,
      exit_blocked: 0, exit_dispatches: [], exit_completions: [] };
    const blockedExitNodes = new Set();

    for (const checkpoint of schedule.checkpoints) {
      const durationMin = (checkpoint.timeMs - cursor) / 60000;
      if (durationMin > 0) {
        const population = advancePopulation(state.environment, durationMin, arrivalOnlyParameters, rng,
          state.population_ledger, state.mobility_ledger);
        const queueLedger = advancePoiService(state.pois, state.population_ledger,
          state.mobility_ledger, durationMin, state.simulation_time);
        const transit = advanceTransit(graph, state, durationMin, parameters);
        arrivals += population.arrivals;
        departures += population.departures + transit.exit_arrivals_completed;
        for (const [id, row] of Object.entries(queueLedger)) {
          admitted += row.admitted;
          completed += row.completed;
          poiFlows[id].arrivals += row.arrivals;
          poiFlows[id].admitted += row.admitted;
          poiFlows[id].completed += row.completed;
          poiFlows[id].served += row.admitted;
        }
        for (const [id, count] of Object.entries(transit.arrivals)) {
          queueArrivals += count;
          poiFlows[id].arrivals += count;
        }
        mobilityEvents.arrived_total += transit.arrived_total;
        mobilityEvents.closed_poi_returns += transit.closed_poi_returns;
        mobilityEvents.closed_poi_nodes.push(...transit.closed_poi_nodes);
        mobilityEvents.edge_entries.push(...transit.edge_entries);
        mobilityEvents.reroutes.push(...transit.reroutes);
        mobilityEvents.blocked.push(...transit.blocked);
        mobilityEvents.exit_arrivals_completed += transit.exit_arrivals_completed;
        mobilityEvents.exit_blocked += transit.exit_blocked;
        mobilityEvents.exit_completions.push(...transit.exit_completions);
        for (const id of transit.exit_blocked_nodes) blockedExitNodes.add(id);
        state.visitor.remaining_time_min = Math.max(0, Math.round((state.visitor.remaining_time_min - durationMin) * 1000) / 1000);
        cursor = checkpoint.timeMs;
      }
      state.simulation_time = checkpoint.timestamp;
      for (const event of checkpoint.events) applied.push(applyEvent(state, event));
      if (durationMin > 0) {
        const exitFlow = advanceExitIntents(graph, state, durationMin, parameters,
          rng, checkpoint.timestamp, blockedExitNodes);
        departures += exitFlow.exit_departures_at_gate;
        mobilityEvents.exit_intent_created += exitFlow.exit_intent_created;
        mobilityEvents.exit_departures_at_gate += exitFlow.exit_departures_at_gate;
        mobilityEvents.exit_blocked += exitFlow.exit_blocked;
        mobilityEvents.exit_dispatches.push(...exitFlow.exit_dispatches);
        mobilityEvents.exit_completions.push(...exitFlow.exit_completions);
        for (const id of exitFlow.exit_blocked_nodes) blockedExitNodes.add(id);
        const blockedNodes = new Set([...mobilityEvents.blocked.map(item => item.node_id),
          ...mobilityEvents.closed_poi_nodes]);
        mobilityEvents.dispatched.push(...dispatchNodeWalkers(graph, state, durationMin, parameters,
          rng, checkpoint.timestamp, blockedNodes));
      }
    }
    state.step_count += 1;
    const population = { population_before: populationBefore, arrivals, departures, population_after: state.environment.park_population };
    const queueAfter = state.population_ledger.queueing;
    const insideAfter = state.population_ledger.inside_poi;
    const walkingAfter = state.population_ledger.walking;
    if (queueAfter !== queueBefore + queueArrivals - admitted) throw new Error('POI queue conservation failed');
    if (insideAfter !== insideBefore + admitted - completed) throw new Error('POI inside conservation failed');
    if (walkingAfter !== walkingBefore + arrivals - departures - queueArrivals + completed) throw new Error('walking pool conservation failed');
    for (const [id, row] of Object.entries(poiFlows)) {
      row.queue_after = state.pois[id].queue_count;
      row.inside_after = state.pois[id].inside_count;
      if (row.queue_after !== row.queue_before + row.arrivals - row.admitted
        || row.inside_after !== row.inside_before + row.admitted - row.completed) {
        throw new Error(`POI flow conservation failed: ${id}`);
      }
    }
    const legal = evaluateLegalActions(graph, state, rules);
    const invariant_summary = validateInvariants(state, beforeTime, population, legal, graph);
    const nodeAfter = Object.values(state.mobility_ledger.node_walkers).reduce((sum, count) => sum + count, 0);
    const transitAfter = state.mobility_ledger.transit_groups.reduce((sum, group) => sum + group.count, 0);
    return clone({
      timestamp: state.simulation_time,
      population,
      poi_queue_summary: { queue_before: queueBefore, arrivals: queueArrivals, served: admitted,
        admitted, completed, queue_after: queueAfter, inside_before: insideBefore, inside_after: insideAfter },
      population_flow: { walking_before: walkingBefore, walking_after: walkingAfter,
        walking_to_queue: queueArrivals, queue_to_inside: admitted, inside_to_walking: completed },
      mobility_flow: { node_before: nodeBefore, transit_before: transitBefore,
        node_after: nodeAfter, transit_after: transitAfter, ...mobilityEvents,
        exit_ledger: summarizeExitLedger(state) },
      poi_flows: poiFlows,
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
    getExitLedger: () => clone(summarizeExitLedger(state)),
    getGraph: () => clone(graph),
    getLegalActions: getLegalActionsSnapshot,
    getMetadata: () => ({ graph_version: GRAPH_VERSION, scenario_id: scenario, seed, parameter_version: VERSION, synthetic: true, source_tier: 'T4' }),
    reset: (nextSeed = seed) => createSimulator({ initialGraph: sourceGraph, initialState: sourceState, scenario, seed: nextSeed, events: sourceEvents, rules })
  };
}

module.exports = { createSimulator, validateInvariants };

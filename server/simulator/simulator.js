'use strict';

const provider = require('../state/stateProvider');
const { SeededRNG } = require('./seeded-rng');
const { resolveScenario, resolveParameters, resolveObservationParameters,
  VERSION, OBSERVATION_VERSION } = require('./parameter-registry');
const { EventClock } = require('./event-clock');
const { createSimulationState, clone, GRAPH_VERSION } = require('./simulation-state');
const { advancePopulation, advancePoiService } = require('./dynamics');
const { evaluateLegalActions } = require('./legal-action-adapter');
const { generateObservation, createObservationBuffer } = require('./observation');
const { dispatchNodeWalkers, advanceTransit, advanceExitIntents, summarizeExitLedger } = require('./mobility');
const { showMilestones, advanceEventService, applyShowMilestone, dispatchEventIntents } = require('./event-flow');
const { validateFatigueParameters, ageFatigue, completeRest, dispatchRestIntents,
  summarizeFatigue, validateFatigue } = require('./fatigue-rest');
const { syncRoadOccupancy, summarizeRoads, validateRoadDynamics } = require('./road-dynamics');
const { createTransition, advanceTransition } = require('./transition-audit');
const { computeReward } = require('./reward-engine');
const { REWARD_VERSION } = require('./config/reward-parameters');
const { toMillis, addMinutes } = require('../planner/time');
const { validateScenarioInstance, sampleScenario } = require('./scenario-sampler');
const { createVisitorProfile, validateVisitorProfile } = require('./visitor-profile');

const SIMULATOR_VERSION = 'sim-dr-p1.1';

function validateEvents(events, graph) {
  const edgeIds = new Set(graph.edges.map(edge => edge.edge_id));
  const poiIds = new Set(graph.nodes.map(node => node.poi_id).filter(Boolean));
  for (const event of events) {
    const known = event.event_type.startsWith('ROAD_') ? edgeIds.has(event.target_id)
      : event.event_type.startsWith('POI_') && poiIds.has(event.target_id);
    if (!known) throw new RangeError(`unknown ${event.event_type} target_id: ${event.target_id}`);
  }
}

function applyEvent(state, event) {
  if (event.event_type.startsWith('SHOW_')) return applyShowMilestone(state, event);
  const close = event.event_type.endsWith('CLOSE');
  if (event.event_type.startsWith('ROAD_')) {
    state.roads[event.target_id].is_open = !close;
    state.roads[event.target_id].closed_at = close ? state.simulation_time : null;
  }
  else state.pois[event.target_id].is_open = !close;
  return { timestamp: state.simulation_time, event_id: event.event_id, event_type: event.event_type, target_id: event.target_id, is_open: !close };
}

function validateInvariants(state, previousTime = null, populationLedger = null, legal = null,
  graph = null, parameters = null) {
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
      : group.purpose === 'EVENT_TRAVEL'
        ? state.events[group.target_event_id]?.is_show_event === true
          && state.events[group.target_event_id].node_id === group.destination_node_id
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
  let queueSum = 0, insideSum = 0, attendingSum = 0;
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
  for (const [id, event] of Object.entries(state.events)) {
    if (!event.is_show_event) continue;
    const eventInTransit = mobility.transit_groups.filter(group => group.purpose === 'EVENT_TRAVEL'
      && group.target_event_id === id).reduce((sum, group) => sum + group.count, 0);
    if (!nodeIds.has(event.node_id) || !['BEFORE_ENTRY', 'BOARDING', 'RUNNING', 'RELEASING', 'FINISHED'].includes(event.phase)
      || !Number.isSafeInteger(event.event_queue_count) || event.event_queue_count < 0
      || !Number.isSafeInteger(event.attending_count) || event.attending_count < 0
      || !Number.isSafeInteger(event.capacity) || event.capacity < 0
      || event.attending_count > event.capacity
      || !['intent_created_total', 'queue_arrivals_total', 'admitted_total', 'missed_count', 'released_count']
        .every(key => Number.isSafeInteger(event[key]) && event[key] >= 0)
      || event.admitted_total !== event.attending_count + event.released_count
      || event.intent_created_total !== event.event_queue_count + event.attending_count
        + event.released_count + event.missed_count + eventInTransit
      || (event.phase === 'FINISHED' && (event.attending_count || event.event_queue_count))) {
      throw new Error(`show event invariant failed: ${id}`);
    }
    queueSum += event.event_queue_count;
    attendingSum += event.attending_count;
  }
  if (queueSum !== ledger.queueing || insideSum !== ledger.inside_poi
    || attendingSum !== ledger.attending_event) throw new Error('POI or event totals differ from population ledger');
  validateFatigue(state, nodeIds);
  for (const [id, road] of Object.entries(state.roads)) {
    if (!Number.isFinite(road.base_travel_time_min) || road.base_travel_time_min <= 0 || !Number.isFinite(road.speed_factor) || road.speed_factor <= 0) {
      throw new Error(`road invariant failed: ${id}`);
    }
  }
  validateRoadDynamics(state, parameters);
  if (legal) for (const item of legal.legal) {
    for (const edgeId of [...(item.route?.edge_sequence || []), ...(item.return_route?.edge_sequence || [])]) {
      if (!state.roads[edgeId]?.is_open) throw new Error(`closed road in legal route: ${edgeId}`);
    }
  }
  return { population: 'PASS', queue: 'PASS', ledger: 'PASS', mobility: 'PASS', inside_capacity: 'PASS', event: 'PASS',
    fatigue: 'PASS', rest: 'PASS', road_occupancy: 'PASS',
    cumulative_population: 'PASS', closed_road: 'PASS', graph_version: 'PASS', time: 'PASS' };
}

function createSimulator({ initialGraph = provider.getScenicGraph(), initialState = provider.getState(),
  scenario = 'P0_BASELINE', observationScenario = 'P1D_CLEAN', seed = 42,
  events = [], rules = {}, scenarioInstance = null, visitorProfile = null } = {}) {
  const sourceGraph = clone(initialGraph);
  const sourceState = clone(initialState);
  const sourceEvents = clone(events);
  const instance = scenarioInstance ? clone(validateScenarioInstance(scenarioInstance)) : null;
  if (instance && instance.seed !== seed) throw new RangeError('scenario seed differs from simulator seed');
  if (instance && scenario !== 'P0_BASELINE') {
    throw new RangeError('scenarioInstance requires P0_BASELINE to avoid multiplying P0 flow variants');
  }
  const effectiveState = clone(sourceState);
  const effectiveEvents = clone(sourceEvents);
  if (instance) {
    // A scenario weather label must not retain contradictory DEMO temperature/rain text.
    effectiveState.weather = { category: instance.dimensions.weather };
    if (instance.dimensions.event_condition === 'EVENT_DELAY') {
      const show = effectiveState.event_states?.['show-1'];
      if (!show?.start_time || !show.latest_entry_time) throw new Error('show-1 unavailable for EVENT_DELAY');
      for (const key of ['start_time', 'latest_entry_time', 'end_time']) {
        if (show[key]) show[key] = addMinutes(show[key], instance.sampled_parameters.event_delay_min);
      }
    }
    if (instance.dimensions.road_condition === 'LOCAL_CLOSURE') {
      const candidates = sourceGraph.edges.map(edge => edge.edge_id)
        .filter(id => effectiveState.road_states?.[id]?.available !== false).sort();
      if (!candidates.length) throw new Error('LOCAL_CLOSURE requires an open graph edge');
      const closureRng = new SeededRNG((seed ^ 0x4cf5ad43) >>> 0);
      const edgeId = closureRng.choice(candidates);
      instance.closure_edge_id = edgeId;
      instance.provenance.closure_edge_id = edgeId;
      instance.provenance.closure_selection = { parameter_name: 'closure_edge_id',
        distribution_type: 'DISCRETE_CHOICE', choices: candidates,
        source_tier: 'T4', basis: 'ASSUMPTION', version: instance.scenario_parameter_version };
      const start = addMinutes(effectiveState.timestamp, instance.sampled_parameters.road_closure_start_min);
      const end = addMinutes(start, instance.sampled_parameters.road_closure_duration_min);
      effectiveEvents.push({ event_id: `${instance.scenario_instance_id}_ROAD_CLOSE`,
        event_type: 'ROAD_CLOSE', target_id: edgeId, timestamp: start },
      { event_id: `${instance.scenario_instance_id}_ROAD_REOPEN`,
        event_type: 'ROAD_REOPEN', target_id: edgeId, timestamp: end });
    }
  }
  const rng = new SeededRNG(seed);
  const selectedScenario = resolveScenario(scenario);
  const baseParameters = resolveParameters(selectedScenario, rng);
  const parameters = Object.freeze(instance ? { ...baseParameters,
    arrival_multiplier: baseParameters.arrival_multiplier * instance.sampled_parameters.arrival_scale,
    default_poi_capacity: baseParameters.default_poi_capacity
      * instance.sampled_parameters.poi_capacity_scale,
    default_service_rate: baseParameters.default_service_rate
      * instance.sampled_parameters.poi_service_scale,
    default_admission_rate: baseParameters.default_admission_rate
      * instance.sampled_parameters.poi_service_scale,
    road_reference_capacity: baseParameters.road_reference_capacity
      * instance.sampled_parameters.road_capacity_scale,
    event_admission_rate: baseParameters.event_admission_rate
      * instance.sampled_parameters.event_admission_scale,
    event_release_rate: baseParameters.event_release_rate
      * instance.sampled_parameters.event_release_scale }
    : baseParameters);
  validateFatigueParameters(parameters);
  const eventRng = new SeededRNG((seed ^ 0x1f123bb5) >>> 0);
  const restRng = new SeededRNG((seed ^ 0x6a09e667) >>> 0);
  const baseObservationParameters = resolveObservationParameters();
  const observationParameters = Object.freeze(instance ? { ...baseObservationParameters,
    queue_noise_std: baseObservationParameters.queue_noise_std
      * instance.sampled_parameters.observation_noise_scale,
    crowd_noise_std: baseObservationParameters.crowd_noise_std
      * instance.sampled_parameters.observation_noise_scale,
    travel_time_noise_ratio: baseObservationParameters.travel_time_noise_ratio
      * instance.sampled_parameters.observation_noise_scale,
    queue_missing_rate: Math.min(1, baseObservationParameters.queue_missing_rate
      * instance.sampled_parameters.observation_missing_scale),
    travel_time_missing_rate: Math.min(1, baseObservationParameters.travel_time_missing_rate
      * instance.sampled_parameters.observation_missing_scale),
    observation_delay_min: instance.sampled_parameters.observation_delay_min,
    position_confidence: instance.sampled_parameters.position_confidence }
    : baseObservationParameters);
  const effectiveObservationScenario = instance
    ? `P1D_${instance.dimensions.observation_quality}` : observationScenario;
  // Separate substream: sensor draws never alter environmental dynamics.
  const observationRng = new SeededRNG((seed ^ 0x9e3779b9) >>> 0);
  const positionRng = new SeededRNG((seed ^ 0xb7e15162) >>> 0);
  const arrivalOnlyParameters = Object.freeze({ ...parameters, departure_rate: 0 });
  const { graph, state } = createSimulationState(sourceGraph, effectiveState, selectedScenario, parameters);
  if (instance?.dimensions.event_condition === 'EVENT_DELAY') {
    const event = state.events['show-1'];
    for (const name of ['boarding_start', 'latest_entry_time', 'start_time', 'end_time']) {
      event.time_sources[name] = { type: 'SCENARIO_T4_OVERLAY',
        scenario_instance_id: instance.scenario_instance_id,
        delay_min: instance.sampled_parameters.event_delay_min };
    }
  }
  const profile = visitorProfile ? clone(validateVisitorProfile(visitorProfile))
    : instance ? createVisitorProfile({ seed, scenarioInstance: instance }) : null;
  if (instance && profile?.scenario_instance_id
    && profile.scenario_instance_id !== instance.scenario_instance_id) {
    throw new RangeError('visitor profile references a different scenario instance');
  }
  if (profile) state.visitor.profile = clone(profile);
  syncRoadOccupancy(state, parameters);
  validateEvents(effectiveEvents, graph);
  const clock = new EventClock(state.simulation_time, parameters.simulation_step_min,
    [...effectiveEvents, ...showMilestones(state.events, state.simulation_time)]);
  validateInvariants(state, null, null, null, graph, parameters);
  const observationBuffer = createObservationBuffer();
  observationBuffer.capture(generateObservation(state, observationRng,
    observationParameters, effectiveObservationScenario, graph, positionRng));
  let activeDecisionTransition = null;
  const completedDecisionTransitions = [];
  let nextDecisionTransitionId = 1;

  function getLegalActionsSnapshot() {
    if (state.visitor.shadow_in_park === false) return {
      legal: [], rejected: [], observation: clone(observationBuffer.latestAvailable(state.simulation_time)),
      planner_view_fallbacks: null, adapter_defaults: 'shadow decision visitor has exited'
    };
    const result = evaluateLegalActions(graph,
      observationBuffer.latestAvailable(state.simulation_time), rules, observationParameters);
    validateInvariants(state, null, null, result, graph, parameters);
    return clone(result);
  }

  function startDecisionTransition(action) {
    if (activeDecisionTransition) throw new Error('decision transition already in progress');
    const legal = getLegalActionsSnapshot();
    const matched = legal.legal.find(item => {
      const expected = item.action;
      return action && Object.keys(action).length === Object.keys(expected).length
        && Object.keys(expected).every(key => action[key] === expected[key]);
    });
    if (!matched) {
      const error = new Error('INVALID_ACTION: chosen action is absent from current legal actions');
      error.code = 'INVALID_ACTION';
      throw error;
    }
    activeDecisionTransition = createTransition({
      id: `transition_${String(nextDecisionTransitionId++).padStart(6, '0')}`,
      action: matched.action, legalEvaluation: matched,
      observation: legal.observation, state
    });
    return clone({ audit: activeDecisionTransition.audit, reward: null });
  }

  function step() {
    const beforeTime = state.simulation_time;
    const populationBefore = state.environment.park_population;
    const walkingBefore = state.population_ledger.walking;
    const queueBefore = state.population_ledger.queueing;
    const poiQueueBefore = Object.values(state.pois).reduce((sum, poi) => sum + poi.queue_count, 0);
    const insideBefore = state.population_ledger.inside_poi;
    const attendingBefore = state.population_ledger.attending_event;
    const restBefore = state.population_ledger.resting;
    const nodeBefore = Object.values(state.mobility_ledger.node_walkers).reduce((sum, count) => sum + count, 0);
    const transitBefore = state.mobility_ledger.transit_groups.reduce((sum, group) => sum + group.count, 0);
    const poiFlows = Object.fromEntries(Object.entries(state.pois).map(([id, poi]) => [id, {
      queue_before: poi.queue_count, inside_before: poi.inside_count, arrivals: 0,
      admitted: 0, completed: 0, served: 0
    }]));
    const eventFlows = Object.fromEntries(Object.entries(state.events)
      .filter(([, event]) => event.is_show_event).map(([id, event]) => [id, {
        queue_before: event.event_queue_count, attending_before: event.attending_count,
        intents: 0, arrivals: 0, admitted: 0, queue_missed: 0,
        travel_missed: 0, released: 0
      }]));
    const schedule = clock.nextStep();
    let cursor = schedule.startMs;
    let arrivals = 0, departures = 0, queueArrivals = 0, admitted = 0, completed = 0;
    let eventQueueArrivals = 0, eventAdmitted = 0, eventQueueMissed = 0;
    let eventReleased = 0, eventTravelMissed = 0, eventIntentCreated = 0;
    let restStarted = 0, restCompleted = 0;
    const restAudit = { started: [], completed: [] };
    const applied = [];
    const mobilityEvents = { dispatched: [], edge_entries: [], reroutes: [], blocked: [],
      arrived_total: 0, closed_poi_returns: 0, closed_poi_nodes: [],
      exit_intent_created: 0, exit_arrivals_completed: 0, exit_departures_at_gate: 0,
      exit_blocked: 0, exit_dispatches: [], exit_completions: [] };
    const eventAudit = { dispatches: [], arrivals: [] };
    const blockedExitNodes = new Set();
    const missedEventNodes = new Set();
    let decisionTransitionResult = null;

    for (const checkpoint of schedule.checkpoints) {
      const durationMin = (checkpoint.timeMs - cursor) / 60000;
      if (durationMin > 0) {
        const decisionFatigueAtStart = activeDecisionTransition ? state.visitor.fatigue : null;
        ageFatigue(state, durationMin, parameters);
        const population = advancePopulation(state.environment, durationMin, arrivalOnlyParameters, rng,
          state.population_ledger, state.mobility_ledger);
        const queueLedger = advancePoiService(state.pois, state.population_ledger,
          state.mobility_ledger, durationMin, state.simulation_time);
        const eventService = advanceEventService(state, durationMin, parameters);
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
        for (const [id, row] of Object.entries(eventService)) {
          eventAdmitted += row.admitted;
          eventReleased += row.released;
          eventFlows[id].admitted += row.admitted;
          eventFlows[id].released += row.released;
        }
        for (const [id, count] of Object.entries(transit.event_queue_arrivals)) {
          eventQueueArrivals += count;
          eventFlows[id].arrivals += count;
        }
        eventTravelMissed += transit.event_missed_total;
        for (const id of transit.event_missed_nodes) missedEventNodes.add(id);
        for (const [id, count] of Object.entries(transit.event_missed_by_event)) {
          eventFlows[id].travel_missed += count;
        }
        eventAudit.arrivals.push(...transit.event_arrivals);
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
        if (activeDecisionTransition) {
          // Generic P1-F visitor aging is replaced by this action's actual phase time.
          state.visitor.fatigue = decisionFatigueAtStart;
          const terminal = advanceTransition(activeDecisionTransition, {
            state, graph, parameters, startTime: state.simulation_time, durationMin
          });
          if (terminal) {
            const finished = activeDecisionTransition;
            finished.reward = computeReward({ action: finished.audit.action,
              beforeState: finished.beforeState,
              afterState: { visitor: clone(state.visitor) },
              transitionAudit: finished.audit });
            decisionTransitionResult = clone({ audit: finished.audit, reward: finished.reward });
            completedDecisionTransitions.push(decisionTransitionResult);
            activeDecisionTransition = null;
          }
        }
        cursor = checkpoint.timeMs;
      }
      state.simulation_time = checkpoint.timestamp;
      for (const event of checkpoint.events) {
        const change = applyEvent(state, event);
        applied.push(change);
        if (event.event_type === 'SHOW_LATEST_ENTRY') {
          eventQueueMissed += change.missed;
          eventFlows[change.event_id].queue_missed += change.missed;
        }
      }
      if (durationMin > 0) {
        const restRelease = completeRest(state, checkpoint.timestamp, parameters);
        restCompleted += restRelease.rest_completed;
        restAudit.completed.push(...restRelease.groups);
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
          ...mobilityEvents.closed_poi_nodes, ...missedEventNodes]);
        const restFlow = dispatchRestIntents(state, durationMin, parameters,
          restRng, checkpoint.timestamp, blockedNodes);
        restStarted += restFlow.rest_started;
        restAudit.started.push(...restFlow.groups);
        const eventIntent = dispatchEventIntents(graph, state, durationMin, parameters,
          eventRng, checkpoint.timestamp, blockedNodes);
        eventIntentCreated += eventIntent.event_intent_created;
        eventAudit.dispatches.push(...eventIntent.event_dispatches);
        for (const [id, count] of Object.entries(eventIntent.event_queue_arrivals)) {
          eventQueueArrivals += count;
          eventFlows[id].arrivals += count;
        }
        for (const item of eventIntent.event_dispatches) eventFlows[item.target_event_id].intents += item.count;
        for (const [id, count] of Object.entries(eventIntent.event_queue_arrivals)) {
          eventFlows[id].intents += count;
        }
        mobilityEvents.dispatched.push(...dispatchNodeWalkers(graph, state, durationMin, parameters,
          rng, checkpoint.timestamp, blockedNodes));
      }
    }
    state.step_count += 1;
    const population = { population_before: populationBefore, arrivals, departures, population_after: state.environment.park_population };
    const queueAfter = state.population_ledger.queueing;
    const poiQueueAfter = Object.values(state.pois).reduce((sum, poi) => sum + poi.queue_count, 0);
    const insideAfter = state.population_ledger.inside_poi;
    const attendingAfter = state.population_ledger.attending_event;
    const restAfter = state.population_ledger.resting;
    const walkingAfter = state.population_ledger.walking;
    if (queueAfter !== queueBefore + queueArrivals + eventQueueArrivals
      - admitted - eventAdmitted - eventQueueMissed) throw new Error('combined queue conservation failed');
    if (insideAfter !== insideBefore + admitted - completed) throw new Error('POI inside conservation failed');
    if (attendingAfter !== attendingBefore + eventAdmitted - eventReleased) {
      throw new Error('event attendance conservation failed');
    }
    if (restAfter !== restBefore + restStarted - restCompleted) {
      throw new Error('rest population conservation failed');
    }
    if (walkingAfter !== walkingBefore + arrivals - departures - queueArrivals
      - eventQueueArrivals + completed + eventQueueMissed + eventReleased
      - restStarted + restCompleted) {
      throw new Error('walking pool conservation failed');
    }
    for (const [id, row] of Object.entries(poiFlows)) {
      row.queue_after = state.pois[id].queue_count;
      row.inside_after = state.pois[id].inside_count;
      if (row.queue_after !== row.queue_before + row.arrivals - row.admitted
        || row.inside_after !== row.inside_before + row.admitted - row.completed) {
        throw new Error(`POI flow conservation failed: ${id}`);
      }
    }
    for (const [id, row] of Object.entries(eventFlows)) {
      row.queue_after = state.events[id].event_queue_count;
      row.attending_after = state.events[id].attending_count;
      if (row.queue_after !== row.queue_before + row.arrivals - row.admitted - row.queue_missed
        || row.attending_after !== row.attending_before + row.admitted - row.released) {
        throw new Error(`event flow conservation failed: ${id}`);
      }
    }
    observationBuffer.capture(generateObservation(state, observationRng,
      observationParameters, effectiveObservationScenario, graph, positionRng));
    const availableObservation = observationBuffer.latestAvailable(state.simulation_time);
    const legal = state.visitor.shadow_in_park === false
      ? { legal: [], rejected: [] }
      : evaluateLegalActions(graph, availableObservation, rules, observationParameters);
    const invariant_summary = validateInvariants(state, beforeTime, population, legal, graph, parameters);
    const nodeAfter = Object.values(state.mobility_ledger.node_walkers).reduce((sum, count) => sum + count, 0);
    const transitAfter = state.mobility_ledger.transit_groups.reduce((sum, group) => sum + group.count, 0);
    return clone({
      timestamp: state.simulation_time,
      population,
      poi_queue_summary: { queue_before: poiQueueBefore, arrivals: queueArrivals, served: admitted,
        admitted, completed, queue_after: poiQueueAfter, inside_before: insideBefore, inside_after: insideAfter },
      population_flow: { walking_before: walkingBefore, walking_after: walkingAfter,
        walking_to_queue: queueArrivals + eventQueueArrivals,
        queue_to_inside: admitted, inside_to_walking: completed,
        queue_to_attending: eventAdmitted, queue_to_walking: eventQueueMissed,
        attending_to_walking: eventReleased },
      mobility_flow: { node_before: nodeBefore, transit_before: transitBefore,
        node_after: nodeAfter, transit_after: transitAfter, ...mobilityEvents,
        exit_ledger: summarizeExitLedger(state) },
      road_metrics_summary: summarizeRoads(state),
      poi_flows: poiFlows,
      event_flow_summary: {
        event_intent_created: eventIntentCreated,
        event_travel_count: state.mobility_ledger.transit_groups
          .filter(group => group.purpose === 'EVENT_TRAVEL').reduce((sum, group) => sum + group.count, 0),
        event_queue_arrivals: eventQueueArrivals,
        event_queue_count: Object.values(state.events).filter(event => event.is_show_event)
          .reduce((sum, event) => sum + event.event_queue_count, 0),
        event_admitted_count: eventAdmitted, event_attending_count: attendingAfter,
        event_missed_count: eventQueueMissed + eventTravelMissed,
        event_released_count: eventReleased,
        dispatches: eventAudit.dispatches, arrivals: eventAudit.arrivals
      },
      event_flows: eventFlows,
      event_status_changes: applied.filter(event => event.event_type.startsWith('SHOW_')),
      fatigue_summary: { ...summarizeFatigue(state), rest_intent_created: restStarted,
        rest_started: restStarted, rest_completed: restCompleted,
        rest_groups_started: restAudit.started, rest_groups_completed: restAudit.completed },
      road_status_changes: applied.filter(event => event.event_type.startsWith('ROAD_')),
      poi_status_changes: applied.filter(event => event.event_type.startsWith('POI_')),
      legal_actions: legal.legal,
      rejected_actions: legal.rejected,
      observation: availableObservation,
      decision_transition: activeDecisionTransition
        ? { audit: activeDecisionTransition.audit, reward: null } : decisionTransitionResult,
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
    getObservation: () => clone(observationBuffer.latestAvailable(state.simulation_time)),
    getExitLedger: () => clone(summarizeExitLedger(state)),
    getGraph: () => clone(graph),
    getScenarioInstance: () => clone(instance),
    getResolvedParameters: () => clone(parameters),
    getLegalActions: getLegalActionsSnapshot,
    startDecisionTransition,
    getActiveDecisionTransition: () => activeDecisionTransition
      ? clone({ audit: activeDecisionTransition.audit, reward: null }) : null,
    getCompletedDecisionTransitions: () => clone(completedDecisionTransitions),
    getMetadata: () => ({ graph_version: GRAPH_VERSION, scenario_id: scenario,
      observation_scenario_id: effectiveObservationScenario, observation_version: OBSERVATION_VERSION,
      observation_parameter_version: OBSERVATION_VERSION,
      seed, simulator_version: SIMULATOR_VERSION, parameter_version: VERSION,
      reward_version: REWARD_VERSION, visitor_mode: 'SHADOW_VISITOR',
      scenario_instance_id: instance?.scenario_instance_id ?? null,
      closure_edge_id: instance?.closure_edge_id ?? null,
      scenario_parameter_version: instance?.scenario_parameter_version ?? null,
      visitor_profile_version: profile?.profile_version ?? null,
      synthetic: true, source_tier: 'T4' }),
    reset: (nextSeed = seed) => createSimulator({ initialGraph: sourceGraph, initialState: sourceState,
      scenario, observationScenario, seed: nextSeed, events: sourceEvents, rules,
      scenarioInstance: instance && nextSeed !== seed
        ? sampleScenario({ scenario_family: instance.scenario_family, seed: nextSeed,
          index: instance.index, dimensions: instance.dimensions }) : instance,
      visitorProfile: visitorProfile && nextSeed === seed ? visitorProfile : null })
  };
}

module.exports = { createSimulator, validateInvariants };

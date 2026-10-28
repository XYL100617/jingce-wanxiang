'use strict';

const { buildLivePlannerScenario } = require('../planner/live-adapter');
const { findPath } = require('../planner/astar');
const { parseTime, stamp } = require('../state/scenarioEngine');
const { toVisibleState } = require('./legal-action-adapter');
const { stochasticCount } = require('./dynamics');
const { addMinutes, toMillis } = require('../planner/time');
const { addNodeFatigue, addPoiQueueFatigue, addEventQueueFatigue } = require('./fatigue-rest');

function returnToNode(mobility, group) {
  addNodeFatigue(mobility, group.current_node_id, group.count, group.fatigue_level);
  mobility.node_walkers[group.current_node_id] += group.count;
}

function plannerSnapshot(graph, state) {
  return buildLivePlannerScenario(graph, toVisibleState(state), {}, null);
}

function routeToNode(planner, startNodeId, goalNodeId, departureTime) {
  return findPath({ graph: planner.graph, state: planner.state, forecast: planner.forecast,
    startNodeId, goalNodeId, departureTime });
}

function chooseReachableExit(planner, mobility, originNodeId, departureTime) {
  let best = null;
  for (const exitNodeId of mobility.exit_node_ids) {
    const route = routeToNode(planner, originNodeId, exitNodeId, departureTime);
    if (!route.reachable) continue;
    if (!best || route.travel_time_min < best.route.travel_time_min) {
      best = { exit_node_id: exitNodeId, route };
    }
  }
  return best;
}

function summarizeExitLedger(state) {
  const mobility = state.mobility_ledger;
  return {
    exit_intent_created: mobility.exit_intent_created_total,
    exit_completed: mobility.exit_completed_total,
    exit_in_transit: mobility.transit_groups
      .filter(group => group.purpose === 'EXIT_TRAVEL').reduce((sum, group) => sum + group.count, 0),
    exit_pending_at_node: Object.values(mobility.pending_exit_intent).reduce((sum, count) => sum + count, 0),
    exit_blocked: Object.values(mobility.blocked_exit_intent).reduce((sum, count) => sum + count, 0)
  };
}

function completeExit(state, count, exitNodeId, fromTransit = false) {
  const mobility = state.mobility_ledger;
  if (!mobility.exit_node_ids.includes(exitNodeId)) throw new Error(`invalid exit node: ${exitNodeId}`);
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('exit count must be positive');
  if (!fromTransit) {
    if (mobility.pending_exit_intent[exitNodeId] < count || mobility.node_walkers[exitNodeId] < count) {
      throw new Error('exit exceeds pending node walkers');
    }
    mobility.pending_exit_intent[exitNodeId] -= count;
    mobility.blocked_exit_intent[exitNodeId] = 0;
    mobility.node_walkers[exitNodeId] -= count;
  } else mobility.exit_arrivals_completed_total += count;
  mobility.exit_completed_total += count;
  state.population_ledger.walking -= count;
  state.population_ledger.exited_total += count;
  state.environment.park_population -= count;
  state.environment.departures_total += count;
}

function advanceExitIntents(graph, state, durationMin, parameters, rng, departureTime,
  blockedNodes = new Set()) {
  const mobility = state.mobility_ledger;
  const planner = plannerSnapshot(graph, state);
  const events = { exit_intent_created: 0, exit_departures_at_gate: 0,
    exit_blocked: 0, exit_blocked_nodes: [], exit_dispatches: [], exit_completions: [] };
  for (const originNodeId of Object.keys(mobility.node_walkers)) {
    if (blockedNodes.has(originNodeId)) continue;
    const eligible = mobility.node_walkers[originNodeId] - mobility.pending_exit_intent[originNodeId];
    if (eligible < 0) throw new Error(`pending exit exceeds node walkers: ${originNodeId}`);
    if (eligible) {
      const created = Math.min(eligible, stochasticCount(
        eligible * parameters.exit_intent_rate / parameters.simulation_step_min, durationMin, rng));
      mobility.pending_exit_intent[originNodeId] += created;
      mobility.exit_intent_created_total += created;
      events.exit_intent_created += created;
    }
    const pending = mobility.pending_exit_intent[originNodeId];
    if (!pending) continue;
    const chosen = chooseReachableExit(planner, mobility, originNodeId, departureTime);
    if (!chosen) {
      events.exit_blocked += pending;
      events.exit_blocked_nodes.push(originNodeId);
      mobility.blocked_exit_intent[originNodeId] = pending;
      mobility.exit_blocked_attempts_total += pending;
      continue;
    }
    mobility.blocked_exit_intent[originNodeId] = 0;
    if (originNodeId === chosen.exit_node_id) {
      completeExit(state, pending, originNodeId);
      events.exit_departures_at_gate += pending;
      events.exit_completions.push({ count: pending, origin_node_id: originNodeId,
        exit_node_id: originNodeId, from_transit: false });
      continue;
    }
    const route = chosen.route;
    if (!route.edge_sequence.length || route.edge_sequence.some(id => !state.roads[id]?.is_open)) {
      throw new Error('C exit route is empty or enters a closed edge');
    }
    const group = {
      group_id: `cohort_${String(mobility.next_group_id++).padStart(6, '0')}`,
      purpose: 'EXIT_TRAVEL', count: pending, origin_node_id: originNodeId,
      fatigue_level: mobility.node_fatigue?.[originNodeId] ?? 0,
      target_exit_id: chosen.exit_node_id, destination_node_id: chosen.exit_node_id,
      path: { node_sequence: route.node_sequence, edge_sequence: route.edge_sequence },
      path_index: 0, current_node_id: originNodeId,
      current_edge_id: null, edge_entered_at: null, remaining_edge_min: 0,
      departed_at: departureTime
    };
    mobility.pending_exit_intent[originNodeId] = 0;
    mobility.node_walkers[originNodeId] -= pending;
    mobility.transit_groups.push(group);
    events.exit_dispatches.push({ group_id: group.group_id, count: pending,
      origin_node_id: originNodeId, target_exit_id: chosen.exit_node_id,
      path: group.path, departed_at: departureTime });
  }
  return events;
}

function dispatchToPoi({ graph, state, originNodeId, poiId, count, departureTime = state.simulation_time, planner = null }) {
  const mobility = state.mobility_ledger;
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('dispatch count must be a nonnegative integer');
  if (!Object.hasOwn(mobility.node_walkers, originNodeId)) throw new RangeError(`unknown origin node: ${originNodeId}`);
  if (count > mobility.node_walkers[originNodeId]) throw new RangeError('dispatch exceeds node walkers');
  const destinationNodeId = mobility.poi_node_map[poiId];
  if (!destinationNodeId || !state.pois[poiId]) throw new RangeError(`unknown POI mapping: ${poiId}`);
  if (!count) return { dispatched: 0, reason: 'EMPTY' };
  if (!state.pois[poiId].is_open) return { dispatched: 0, reason: 'POI_CLOSED' };
  if (originNodeId === destinationNodeId) return { dispatched: 0, reason: 'SAME_NODE' };
  const route = routeToNode(planner || plannerSnapshot(graph, state), originNodeId, destinationNodeId, departureTime);
  if (!route.reachable || !route.edge_sequence.length) return { dispatched: 0, reason: 'NO_PATH' };
  for (const edgeId of route.edge_sequence) if (!state.roads[edgeId]?.is_open) throw new Error(`C route uses closed edge: ${edgeId}`);
  const group = {
    group_id: `cohort_${String(mobility.next_group_id++).padStart(6, '0')}`,
    purpose: 'POI_TRAVEL', count, origin_node_id: originNodeId, destination_poi_id: poiId,
    fatigue_level: mobility.node_fatigue?.[originNodeId] ?? 0,
    destination_node_id: destinationNodeId,
    path: { node_sequence: route.node_sequence, edge_sequence: route.edge_sequence },
    path_index: 0, current_node_id: originNodeId,
    current_edge_id: null, edge_entered_at: null, remaining_edge_min: 0,
    departed_at: departureTime
  };
  mobility.node_walkers[originNodeId] -= count;
  mobility.transit_groups.push(group);
  return { dispatched: count, group };
}

function dispatchNodeWalkers(graph, state, durationMin, parameters, rng, departureTime, blockedNodes = new Set()) {
  const mobility = state.mobility_ledger;
  const activeShowNodes = new Set(Object.values(state.events)
    .filter(event => event.is_show_event && event.phase !== 'FINISHED').map(event => event.node_id));
  const openPois = Object.keys(state.pois).filter(id => state.pois[id].is_open
    && !activeShowNodes.has(mobility.poi_node_map[id]));
  const planner = plannerSnapshot(graph, state);
  const dispatched = [];
  for (const originNodeId of Object.keys(mobility.node_walkers)) {
    if (blockedNodes.has(originNodeId)) continue;
    const available = mobility.node_walkers[originNodeId] - mobility.pending_exit_intent[originNodeId];
    const targets = openPois.filter(id => mobility.poi_node_map[id] !== originNodeId);
    if (!available || !targets.length) continue;
    const desired = Math.min(available, stochasticCount(
      available * parameters.poi_arrival_fraction * parameters.queue_multiplier / parameters.simulation_step_min,
      durationMin, rng));
    const groupCount = Math.min(desired, parameters.max_dispatch_groups_per_node);
    let remaining = desired;
    for (let i = 0; i < groupCount; i += 1) {
      const count = Math.ceil(remaining / (groupCount - i));
      const poiId = rng.choice(targets);
      const result = dispatchToPoi({ graph, state, originNodeId, poiId, count, departureTime, planner });
      if (result.dispatched) dispatched.push({ group_id: result.group.group_id, count, origin_node_id: originNodeId,
        destination_poi_id: poiId, departed_at: departureTime, path: result.group.path });
      remaining -= count;
    }
  }
  return dispatched;
}

function edgeTravelMin(state, edgeId, parameters) {
  const road = state.roads[edgeId];
  if (!road) throw new Error(`unknown transit edge: ${edgeId}`);
  const raw = road.base_travel_time_min / road.speed_factor * parameters.travel_time_multiplier;
  const step = parameters.simulation_step_min;
  return Math.max(parameters.minimum_edge_travel_min, Math.ceil(raw / step) * step);
}

function advanceTransit(graph, state, durationMin, parameters) {
  const mobility = state.mobility_ledger;
  const planner = plannerSnapshot(graph, state);
  const segmentStartMs = parseTime(state.simulation_time, 'simulation time');
  const events = { arrivals: {}, arrived_total: 0, closed_poi_returns: 0, closed_poi_nodes: [],
    edge_entries: [], reroutes: [], blocked: [], exit_arrivals_completed: 0,
    exit_blocked: 0, exit_blocked_nodes: [], exit_completions: [],
    event_queue_arrivals: {}, event_arrived_total: 0, event_missed_total: 0,
    event_missed_by_event: {}, event_missed_nodes: [], event_arrivals: [] };
  const survivors = [];
  for (const group of mobility.transit_groups) {
    let remaining = durationMin;
    let finished = false;
    while (remaining > 0 && !finished) {
      if (!group.current_edge_id) {
        const now = stamp(segmentStartMs + (durationMin - remaining) * 60000);
        if (group.purpose === 'EVENT_TRAVEL') {
          const show = state.events[group.target_event_id];
          if (!show?.is_show_event) throw new Error(`unknown event travel target: ${group.target_event_id}`);
          if (show.cancelled || ['RELEASING', 'FINISHED'].includes(show.phase)
            || toMillis(now) >= toMillis(show.latest_entry_time)) {
            returnToNode(mobility, group);
            show.missed_count += group.count;
            events.event_missed_total += group.count;
            events.event_missed_by_event[group.target_event_id] =
              (events.event_missed_by_event[group.target_event_id] || 0) + group.count;
            events.event_missed_nodes.push(group.current_node_id);
            finished = true;
            break;
          }
        }
        const nextEdgeId = group.path.edge_sequence[group.path_index];
        if (!nextEdgeId) throw new Error(`transit group has no next edge: ${group.group_id}`);
        if (!state.roads[nextEdgeId]?.is_open) {
          let alternative = routeToNode(planner, group.current_node_id, group.destination_node_id, now);
          if (group.purpose === 'EXIT_TRAVEL' && !alternative.reachable) {
            const replacement = chooseReachableExit(planner, mobility, group.current_node_id, now);
            if (replacement) {
              group.target_exit_id = replacement.exit_node_id;
              group.destination_node_id = replacement.exit_node_id;
              alternative = replacement.route;
            }
          }
          if (group.purpose === 'EXIT_TRAVEL' && alternative.reachable && !alternative.edge_sequence.length) {
            completeExit(state, group.count, group.current_node_id, true);
            events.exit_arrivals_completed += group.count;
            events.exit_completions.push({ group_id: group.group_id, count: group.count,
              origin_node_id: group.origin_node_id, exit_node_id: group.current_node_id,
              from_transit: true });
            finished = true;
            break;
          }
          if (!alternative.reachable || !alternative.edge_sequence.length) {
            returnToNode(mobility, group);
            if (group.purpose === 'EVENT_TRAVEL') {
              state.events[group.target_event_id].missed_count += group.count;
              events.event_missed_total += group.count;
              events.event_missed_by_event[group.target_event_id] =
                (events.event_missed_by_event[group.target_event_id] || 0) + group.count;
              events.event_missed_nodes.push(group.current_node_id);
            }
            if (group.purpose === 'EXIT_TRAVEL') {
              mobility.pending_exit_intent[group.current_node_id] += group.count;
              mobility.blocked_exit_intent[group.current_node_id] += group.count;
              mobility.exit_blocked_attempts_total += group.count;
              events.exit_blocked += group.count;
              events.exit_blocked_nodes.push(group.current_node_id);
            }
            events.blocked.push({ group_id: group.group_id, count: group.count, node_id: group.current_node_id });
            finished = true;
            break;
          }
          group.path = { node_sequence: alternative.node_sequence, edge_sequence: alternative.edge_sequence };
          group.path_index = 0;
          if (group.purpose === 'EVENT_TRAVEL'
            && toMillis(addMinutes(now, alternative.travel_time_min)) >=
              toMillis(state.events[group.target_event_id].latest_entry_time)) {
            returnToNode(mobility, group);
            state.events[group.target_event_id].missed_count += group.count;
            events.event_missed_total += group.count;
            events.event_missed_by_event[group.target_event_id] =
              (events.event_missed_by_event[group.target_event_id] || 0) + group.count;
            events.event_missed_nodes.push(group.current_node_id);
            finished = true;
            break;
          }
          events.reroutes.push({ group_id: group.group_id, node_id: group.current_node_id,
            edge_sequence: alternative.edge_sequence });
        }
        const edgeId = group.path.edge_sequence[group.path_index];
        if (!state.roads[edgeId]?.is_open) throw new Error(`attempt to enter closed edge: ${edgeId}`);
        group.current_edge_id = edgeId;
        group.edge_entered_at = stamp(segmentStartMs + (durationMin - remaining) * 60000);
        group.remaining_edge_min = edgeTravelMin(state, edgeId, parameters);
        events.edge_entries.push({ group_id: group.group_id, edge_id: edgeId, timestamp: group.edge_entered_at });
      }
      const elapsed = Math.min(remaining, group.remaining_edge_min);
      group.remaining_edge_min = Math.round((group.remaining_edge_min - elapsed) * 1000) / 1000;
      remaining = Math.round((remaining - elapsed) * 1000) / 1000;
      if (group.remaining_edge_min > 0) break;
      group.path_index += 1;
      group.current_node_id = group.path.node_sequence[group.path_index];
      group.current_edge_id = null;
      group.edge_entered_at = null;
      if (group.current_node_id === group.destination_node_id) {
        const poi = group.purpose === 'POI_TRAVEL' ? state.pois[group.destination_poi_id] : null;
        const reachedAt = stamp(segmentStartMs + (durationMin - remaining) * 60000);
        if (group.purpose === 'EXIT_TRAVEL') {
          completeExit(state, group.count, group.current_node_id, true);
          events.exit_arrivals_completed += group.count;
          events.exit_completions.push({ group_id: group.group_id, count: group.count,
            origin_node_id: group.origin_node_id, exit_node_id: group.current_node_id,
            from_transit: true });
        } else if (group.purpose === 'EVENT_TRAVEL') {
          const show = state.events[group.target_event_id];
          if (toMillis(reachedAt) <= toMillis(show.latest_entry_time)
            && !show.cancelled && !['RELEASING', 'FINISHED'].includes(show.phase)) {
            addEventQueueFatigue(show, group.count, group.fatigue_level);
            show.event_queue_count += group.count;
            show.queue_arrivals_total += group.count;
            state.population_ledger.walking -= group.count;
            state.population_ledger.queueing += group.count;
            events.event_queue_arrivals[group.target_event_id] =
              (events.event_queue_arrivals[group.target_event_id] || 0) + group.count;
            events.event_arrived_total += group.count;
            events.event_arrivals.push({ group_id: group.group_id, event_id: group.target_event_id,
              count: group.count, node_id: group.current_node_id, timestamp: reachedAt });
          } else {
            returnToNode(mobility, group);
            show.missed_count += group.count;
            events.event_missed_total += group.count;
            events.event_missed_by_event[group.target_event_id] =
              (events.event_missed_by_event[group.target_event_id] || 0) + group.count;
            events.event_missed_nodes.push(group.current_node_id);
          }
        } else if (poi.is_open) {
          addPoiQueueFatigue(poi, group.count, group.fatigue_level);
          poi.queue_count += group.count;
          poi.queue = poi.queue_count;
          state.population_ledger.walking -= group.count;
          state.population_ledger.queueing += group.count;
          events.arrivals[group.destination_poi_id] = (events.arrivals[group.destination_poi_id] || 0) + group.count;
          events.arrived_total += group.count;
        } else {
          returnToNode(mobility, group);
          events.closed_poi_returns += group.count;
          events.closed_poi_nodes.push(group.current_node_id);
        }
        finished = true;
      }
    }
    if (!finished) survivors.push(group);
  }
  mobility.transit_groups = survivors;
  return events;
}

module.exports = { plannerSnapshot, routeToNode, chooseReachableExit, summarizeExitLedger,
  completeExit, advanceExitIntents,
  dispatchToPoi, dispatchNodeWalkers, edgeTravelMin, advanceTransit };

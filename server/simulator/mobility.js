'use strict';

const { buildLivePlannerScenario } = require('../planner/live-adapter');
const { findPath } = require('../planner/astar');
const { parseTime, stamp } = require('../state/scenarioEngine');
const { toVisibleState } = require('./legal-action-adapter');
const { stochasticCount } = require('./dynamics');

function plannerSnapshot(graph, state) {
  return buildLivePlannerScenario(graph, toVisibleState(state), {}, null);
}

function routeToNode(planner, startNodeId, goalNodeId, departureTime) {
  return findPath({ graph: planner.graph, state: planner.state, forecast: planner.forecast,
    startNodeId, goalNodeId, departureTime });
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
    count, origin_node_id: originNodeId, destination_poi_id: poiId,
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
  const openPois = Object.keys(state.pois).filter(id => state.pois[id].is_open);
  const planner = plannerSnapshot(graph, state);
  const dispatched = [];
  for (const originNodeId of Object.keys(mobility.node_walkers)) {
    if (blockedNodes.has(originNodeId)) continue;
    const available = mobility.node_walkers[originNodeId];
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
    edge_entries: [], reroutes: [], blocked: [] };
  const survivors = [];
  for (const group of mobility.transit_groups) {
    let remaining = durationMin;
    let finished = false;
    while (remaining > 0 && !finished) {
      if (!group.current_edge_id) {
        const nextEdgeId = group.path.edge_sequence[group.path_index];
        if (!nextEdgeId) throw new Error(`transit group has no next edge: ${group.group_id}`);
        if (!state.roads[nextEdgeId]?.is_open) {
          const now = stamp(segmentStartMs + (durationMin - remaining) * 60000);
          const alternative = routeToNode(planner, group.current_node_id, group.destination_node_id, now);
          if (!alternative.reachable || !alternative.edge_sequence.length) {
            mobility.node_walkers[group.current_node_id] += group.count;
            events.blocked.push({ group_id: group.group_id, count: group.count, node_id: group.current_node_id });
            finished = true;
            break;
          }
          group.path = { node_sequence: alternative.node_sequence, edge_sequence: alternative.edge_sequence };
          group.path_index = 0;
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
        const poi = state.pois[group.destination_poi_id];
        if (poi.is_open) {
          poi.queue_count += group.count;
          poi.queue = poi.queue_count;
          state.population_ledger.walking -= group.count;
          state.population_ledger.queueing += group.count;
          events.arrivals[group.destination_poi_id] = (events.arrivals[group.destination_poi_id] || 0) + group.count;
          events.arrived_total += group.count;
        } else {
          mobility.node_walkers[group.current_node_id] += group.count;
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

module.exports = { plannerSnapshot, routeToNode, dispatchToPoi, dispatchNodeWalkers, edgeTravelMin, advanceTransit };

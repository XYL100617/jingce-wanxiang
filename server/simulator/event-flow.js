'use strict';

const { addMinutes, toMillis } = require('../planner/time');
const { stochasticCount } = require('./dynamics');
const { plannerSnapshot, routeToNode } = require('./mobility');
const { addNodeFatigue, addEventQueueFatigue, addEventAttendingFatigue } = require('./fatigue-rest');

function showMilestones(events, initialTime) {
  const startMs = toMillis(initialTime);
  const schedule = [];
  for (const event of Object.values(events).filter(item => item.is_show_event)) {
    for (const [event_type, timestamp] of [
      ['SHOW_BOARDING', event.boarding_open_time],
      ['SHOW_START', event.start_time],
      ['SHOW_LATEST_ENTRY', event.latest_entry_time],
      ['SHOW_END', event.end_time]
    ]) {
      if (toMillis(timestamp) >= startMs) schedule.push({ event_id: `${event.event_id}_${event_type}`,
        event_type, target_id: event.event_id, timestamp });
    }
  }
  return schedule;
}

function advanceEventService(state, durationMin, parameters) {
  const flows = {};
  for (const [id, event] of Object.entries(state.events)) {
    if (!event.is_show_event) continue;
    const queue_before = event.event_queue_count, attending_before = event.attending_count;
    let admitted = 0, released = 0;
    const canBoard = event.phase === 'BOARDING'
      || (event.phase === 'RUNNING' && toMillis(state.simulation_time) < toMillis(event.latest_entry_time));
    if (canBoard && !event.cancelled) {
      admitted = Math.min(event.event_queue_count, event.capacity - event.attending_count,
        Math.floor(parameters.event_admission_rate * durationMin));
      addEventAttendingFatigue(event, admitted, event.queue_fatigue);
      event.event_queue_count -= admitted;
      event.attending_count += admitted;
      event.admitted_total += admitted;
      state.population_ledger.queueing -= admitted;
      state.population_ledger.attending_event += admitted;
    }
    if (event.phase === 'RELEASING') {
      released = Math.min(event.attending_count, Math.floor(parameters.event_release_rate * durationMin));
      event.attending_count -= released;
      event.released_count += released;
      state.population_ledger.attending_event -= released;
      state.population_ledger.walking += released;
      addNodeFatigue(state.mobility_ledger, event.node_id, released, event.attending_fatigue);
      state.mobility_ledger.node_walkers[event.node_id] += released;
      if (event.attending_count === 0 && event.event_queue_count === 0) {
        event.phase = 'FINISHED';
        event.status = 'finished';
      }
    }
    flows[id] = { queue_before, attending_before, arrivals: 0, admitted,
      missed: 0, released, queue_after: event.event_queue_count,
      attending_after: event.attending_count };
  }
  return flows;
}

function applyShowMilestone(state, milestone) {
  const event = state.events[milestone.target_id];
  if (!event?.is_show_event) throw new Error(`unknown show milestone: ${milestone.target_id}`);
  let missed = 0;
  if (milestone.event_type === 'SHOW_BOARDING') event.phase = 'BOARDING';
  else if (milestone.event_type === 'SHOW_START') event.phase = 'RUNNING';
  else if (milestone.event_type === 'SHOW_LATEST_ENTRY') {
    missed = event.event_queue_count;
    event.event_queue_count = 0;
    event.missed_count += missed;
    state.population_ledger.queueing -= missed;
    state.population_ledger.walking += missed;
    addNodeFatigue(state.mobility_ledger, event.node_id, missed, event.queue_fatigue);
    state.mobility_ledger.node_walkers[event.node_id] += missed;
  } else if (milestone.event_type === 'SHOW_END') {
    event.phase = event.attending_count ? 'RELEASING' : 'FINISHED';
  }
  event.status = event.phase.toLowerCase();
  return { event_id: event.event_id, event_type: milestone.event_type,
    timestamp: state.simulation_time, phase: event.phase, missed };
}

function dispatchEventIntents(graph, state, durationMin, parameters, rng, departureTime,
  blockedNodes = new Set()) {
  const mobility = state.mobility_ledger;
  const planner = plannerSnapshot(graph, state);
  const result = { event_intent_created: 0, event_queue_arrivals: {},
    event_dispatches: [] };
  for (const event of Object.values(state.events)) {
    if (!event.is_show_event || event.cancelled || !['BEFORE_ENTRY', 'BOARDING', 'RUNNING'].includes(event.phase)
      || toMillis(departureTime) >= toMillis(event.latest_entry_time)) continue;
    for (const originNodeId of Object.keys(mobility.node_walkers)) {
      if (blockedNodes.has(originNodeId)) continue;
      const eligible = mobility.node_walkers[originNodeId] - mobility.pending_exit_intent[originNodeId];
      if (eligible <= 0) continue;
      const desired = Math.min(eligible, stochasticCount(eligible * parameters.event_interest_rate
        / parameters.simulation_step_min, durationMin, rng));
      if (!desired) continue;
      const route = routeToNode(planner, originNodeId, event.node_id, departureTime);
      if (!route.reachable || toMillis(addMinutes(departureTime, route.travel_time_min))
        >= toMillis(event.latest_entry_time)) continue;
      if (originNodeId === event.node_id) {
        addEventQueueFatigue(event, desired, mobility.node_fatigue?.[originNodeId] ?? 0);
        mobility.node_walkers[originNodeId] -= desired;
        state.population_ledger.walking -= desired;
        state.population_ledger.queueing += desired;
        event.event_queue_count += desired;
        event.queue_arrivals_total += desired;
        result.event_queue_arrivals[event.event_id] = (result.event_queue_arrivals[event.event_id] || 0) + desired;
      } else {
        if (!route.edge_sequence.length || route.edge_sequence.some(id => !state.roads[id]?.is_open)) {
          throw new Error(`invalid C event route: ${event.event_id}`);
        }
        const group = {
          group_id: `cohort_${String(mobility.next_group_id++).padStart(6, '0')}`,
          purpose: 'EVENT_TRAVEL', count: desired, origin_node_id: originNodeId,
          fatigue_level: mobility.node_fatigue?.[originNodeId] ?? 0,
          target_event_id: event.event_id, destination_node_id: event.node_id,
          path: { node_sequence: route.node_sequence, edge_sequence: route.edge_sequence },
          path_index: 0, current_node_id: originNodeId,
          current_edge_id: null, edge_entered_at: null, remaining_edge_min: 0,
          departed_at: departureTime
        };
        mobility.node_walkers[originNodeId] -= desired;
        mobility.transit_groups.push(group);
        result.event_dispatches.push({ group_id: group.group_id, count: desired,
          origin_node_id: originNodeId, target_event_id: event.event_id,
          path: group.path, departed_at: departureTime });
      }
      event.intent_created_total += desired;
      result.event_intent_created += desired;
    }
  }
  return result;
}

module.exports = { showMilestones, advanceEventService, applyShowMilestone, dispatchEventIntents };

'use strict';

const { toMillis } = require('../planner/time');
const { plannerSnapshot, routeToNode } = require('./mobility');
const { estimateRoad, lockedTravelMin } = require('./road-dynamics');
const { COMPLETION_KINDS } = require('./reward-engine');

const stamp = ms => new Date(ms).toISOString();
const rounded = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));

function createTransition({ id, action, legalEvaluation, observation, state }) {
  const chosen = { action_type: action.action_type, target_id: action.target_id,
    target_node_id: legalEvaluation.action.target_node_id };
  const audit = {
    transition_id: id, visitor_id: state.visitor.visitor_id,
    action: chosen, action_type: chosen.action_type, target_id: chosen.target_id,
    started_at: state.simulation_time, ended_at: null, status: 'IN_PROGRESS',
    phase: chosen.action_type === 'WAIT' ? 'WAITING' : 'TRAVEL', outcome: 'IN_PROGRESS',
    observation_version: observation.observation_version,
    observation_observed_at: observation.observed_at,
    planned_route: legalEvaluation.route ? {
      node_sequence: [...legalEvaluation.route.node_sequence],
      edge_sequence: [...legalEvaluation.route.edge_sequence]
    } : null,
    actual_route: { edges: [], reroutes: [] },
    timeline: { travel_started_at: null, travel_ended_at: null,
      queue_started_at: null, queue_ended_at: null,
      inside_started_at: null, inside_ended_at: null,
      attending_started_at: null, attending_ended_at: null,
      rest_started_at: null, rest_ended_at: null,
      wait_started_at: null, wait_ended_at: null, departure_at: null },
    actual_travel_time_min: ['VISIT_POI', 'ATTEND_EVENT', 'REST', 'EXIT'].includes(chosen.action_type) ? 0 : null,
    actual_queue_time_min: ['VISIT_POI', 'ATTEND_EVENT'].includes(chosen.action_type) ? 0 : null,
    actual_wait_time_min: chosen.action_type === 'WAIT' ? 0 : null,
    fatigue_before: state.visitor.fatigue, fatigue_after: null,
    legal_action_confirmed: true, safety_violation: false,
    safety_audit: { originally_legal: true, entered_closed_road: false,
      visited_closed_poi: false, event_time_violation: false,
      other_invariant_violation: false, blocked_edge_attempts: 0 },
    completion_event: null, missed_event: null, failure_reason: null,
    shadow_visitor: true, aggregate_population_delta: 0
  };
  const runtime = { path: null, path_index: 0, current_edge_id: null, edge_remaining_min: 0,
    queue_ahead: 0, dwell_remaining_min: 0,
    wait_remaining_min: chosen.action_type === 'WAIT' ? legalEvaluation.duration_min : 0,
    rest_min_end_ms: null };
  if (chosen.action_type === 'WAIT') audit.timeline.wait_started_at = state.simulation_time;
  return { audit, runtime, beforeState: { visitor: { ...state.visitor } }, reward: null };
}

function advanceTransition(transition, { state, graph, parameters, startTime, durationMin }) {
  const { audit, runtime } = transition;
  if (audit.status !== 'IN_PROGRESS' || durationMin <= 0) return false;
  const action = audit.action;
  const visitor = state.visitor;
  let now = toMillis(startTime);
  let left = durationMin;
  const time = () => stamp(now);
  const phase = next => { audit.phase = next; };
  const use = (minutes, metric, fatigueRate) => {
    const amount = Math.min(left, Math.max(0, minutes));
    if (metric) audit[metric] = rounded(audit[metric] + amount);
    visitor.fatigue = rounded(clamp(visitor.fatigue + fatigueRate * amount));
    now += amount * 60000;
    left = rounded(left - amount);
    return amount;
  };
  const finish = (outcome, reason = null) => {
    audit.status = outcome;
    audit.outcome = outcome;
    audit.phase = outcome;
    audit.ended_at = time();
    audit.fatigue_after = visitor.fatigue;
    audit.failure_reason = reason;
    if (outcome === 'COMPLETED') {
      audit.completion_event = { kind: COMPLETION_KINDS[action.action_type],
        visitor_id: audit.visitor_id, target_id: action.target_id, timestamp: time() };
      if (action.action_type === 'VISIT_POI') visitor.visited_poi_ids.push(action.target_id);
      if (action.action_type === 'ATTEND_EVENT') visitor.attended_event_ids.push(action.target_id);
      if (action.action_type === 'REST') visitor.visited_facility_ids.push(action.target_id);
      if (action.action_type === 'EXIT') visitor.shadow_in_park = false;
    }
    if (outcome === 'MISSED') audit.missed_event = { kind: 'EVENT_MISSED',
      visitor_id: audit.visitor_id, target_id: action.target_id, timestamp: time() };
  };
  const beginTarget = () => {
    audit.timeline.travel_ended_at = audit.timeline.travel_started_at ? time() : null;
    if (action.action_type === 'EXIT') {
      audit.timeline.departure_at = time();
      finish('COMPLETED');
      return;
    }
    if (action.action_type === 'REST') {
      phase('RESTING');
      audit.timeline.rest_started_at = time();
      runtime.rest_min_end_ms = now + parameters.minimum_rest_duration_min * 60000;
      return;
    }
    if (action.action_type === 'VISIT_POI') {
      const poi = state.pois[action.target_id];
      if (!poi?.is_open) { finish('FAILED', 'POI_CLOSED'); return; }
      phase('QUEUE');
      audit.timeline.queue_started_at = time();
      runtime.queue_ahead = poi.queue_count;
      return;
    }
    const event = state.events[action.target_id];
    if (!event?.is_show_event || event.cancelled) { finish('FAILED', 'EVENT_UNAVAILABLE'); return; }
    if (now >= toMillis(event.latest_entry_time)) { finish('MISSED', 'LATEST_ENTRY_PASSED'); return; }
    phase('QUEUE');
    audit.timeline.queue_started_at = time();
    runtime.queue_ahead = event.event_queue_count;
  };

  for (let guard = 0; guard < 100 && left > 0 && audit.status === 'IN_PROGRESS'; guard += 1) {
    const current = audit.phase;
    if (current === 'TRAVEL') {
      if (!runtime.current_edge_id && visitor.current_node_id === action.target_node_id) {
        beginTarget();
        continue;
      }
      if (!runtime.current_edge_id) {
        if (action.action_type === 'ATTEND_EVENT'
          && now >= toMillis(state.events[action.target_id].latest_entry_time)) {
          finish('MISSED', 'LATEST_ENTRY_PASSED');
          break;
        }
        let edgeId = runtime.path?.edge_sequence[runtime.path_index];
        if (!edgeId || !state.roads[edgeId]?.is_open) {
          if (edgeId && !state.roads[edgeId]?.is_open) audit.safety_audit.blocked_edge_attempts += 1;
          const route = routeToNode(plannerSnapshot(graph, state), visitor.current_node_id,
            action.target_node_id, time());
          if (!route.reachable || !route.edge_sequence.length) {
            finish('FAILED', 'TARGET_UNREACHABLE');
            break;
          }
          runtime.path = { node_sequence: route.node_sequence, edge_sequence: route.edge_sequence };
          runtime.path_index = 0;
          edgeId = route.edge_sequence[0];
          audit.actual_route.reroutes.push({ at: time(), from_node_id: visitor.current_node_id,
            edge_sequence: [...route.edge_sequence] });
        }
        if (!state.roads[edgeId]?.is_open) { finish('FAILED', 'TARGET_UNREACHABLE'); break; }
        runtime.current_edge_id = edgeId;
        const speedFactor = visitor.profile?.walking_speed_factor ?? 1;
        runtime.edge_remaining_min = lockedTravelMin(
          estimateRoad(state, edgeId, parameters).effective_travel_time_min / speedFactor, parameters);
        if (!audit.timeline.travel_started_at) audit.timeline.travel_started_at = time();
        audit.actual_route.edges.push({ edge_id: edgeId, entered_at: time(),
          left_at: null, locked_travel_time_min: runtime.edge_remaining_min });
      }
      const spent = use(runtime.edge_remaining_min, 'actual_travel_time_min', parameters.fatigue_walk_rate);
      runtime.edge_remaining_min = rounded(runtime.edge_remaining_min - spent);
      if (runtime.edge_remaining_min > 0) break;
      audit.actual_route.edges.at(-1).left_at = time();
      runtime.current_edge_id = null;
      runtime.path_index += 1;
      visitor.current_node_id = runtime.path.node_sequence[runtime.path_index];
      if (visitor.current_node_id === action.target_node_id) beginTarget();
      continue;
    }
    if (current === 'QUEUE') {
      const eventAction = action.action_type === 'ATTEND_EVENT';
      const target = eventAction ? state.events[action.target_id] : state.pois[action.target_id];
      if (!eventAction && !target.is_open) { finish('FAILED', 'POI_CLOSED_WHILE_QUEUEING'); break; }
      if (eventAction && (target.cancelled || target.phase === 'FINISHED')) {
        finish('FAILED', 'EVENT_UNAVAILABLE'); break;
      }
      if (eventAction && now >= toMillis(target.latest_entry_time)) {
        finish('MISSED', 'LATEST_ENTRY_PASSED'); break;
      }
      const available = eventAction
        ? target.capacity > target.attending_count : target.capacity > target.inside_count;
      const canEnter = !eventAction || now >= toMillis(target.boarding_open_time);
      if (runtime.queue_ahead <= 0 && available && canEnter) {
        audit.timeline.queue_ended_at = time();
        if (eventAction) {
          phase('ATTENDING');
          audit.timeline.attending_started_at = time();
        } else {
          phase('INSIDE');
          audit.timeline.inside_started_at = time();
          runtime.dwell_remaining_min = rounded(target.visit_duration_min
            * (visitor.profile?.dwell_time_factor ?? 1));
        }
        continue;
      }
      let spend = left;
      if (eventAction) spend = Math.min(spend, (toMillis(target.latest_entry_time) - now) / 60000);
      if (eventAction && !canEnter) spend = Math.min(spend,
        (toMillis(target.boarding_open_time) - now) / 60000);
      const rate = eventAction ? parameters.event_admission_rate : target.admission_rate;
      if (available && canEnter && runtime.queue_ahead > 0 && rate > 0) {
        spend = Math.min(spend, runtime.queue_ahead / rate);
      }
      if (!(spend > 0)) { finish(eventAction ? 'MISSED' : 'FAILED', 'QUEUE_CANNOT_ADVANCE'); break; }
      const consumed = use(spend, 'actual_queue_time_min', parameters.fatigue_queue_rate);
      if (available && canEnter && rate > 0) runtime.queue_ahead = Math.max(0,
        rounded(runtime.queue_ahead - rate * consumed));
      continue;
    }
    if (current === 'INSIDE') {
      const spent = use(runtime.dwell_remaining_min, null, parameters.fatigue_visit_rate);
      runtime.dwell_remaining_min = rounded(runtime.dwell_remaining_min - spent);
      if (runtime.dwell_remaining_min > 0) break;
      audit.timeline.inside_ended_at = time();
      finish('COMPLETED');
      break;
    }
    if (current === 'ATTENDING') {
      const event = state.events[action.target_id];
      const untilEnd = Math.max(0, (toMillis(event.end_time) - now) / 60000);
      if (untilEnd === 0) {
        audit.timeline.attending_ended_at = time(); finish('COMPLETED'); break;
      }
      use(untilEnd, null, parameters.fatigue_event_rate);
      if (now >= toMillis(event.end_time)) {
        audit.timeline.attending_ended_at = time(); finish('COMPLETED');
      }
      break;
    }
    if (current === 'RESTING') {
      const untilMin = Math.max(0, (runtime.rest_min_end_ms - now) / 60000);
      const untilRecovery = Math.max(0, (visitor.fatigue - parameters.rest_release_threshold)
        / parameters.fatigue_recovery_rate);
      const needed = Math.max(untilMin, untilRecovery);
      if (needed === 0) { audit.timeline.rest_ended_at = time(); finish('COMPLETED'); break; }
      use(needed, null, -parameters.fatigue_recovery_rate);
      if (now >= runtime.rest_min_end_ms && visitor.fatigue <= parameters.rest_release_threshold) {
        audit.timeline.rest_ended_at = time(); finish('COMPLETED');
      }
      break;
    }
    if (current === 'WAITING') {
      const spent = use(runtime.wait_remaining_min, 'actual_wait_time_min', parameters.fatigue_walk_rate);
      runtime.wait_remaining_min = rounded(runtime.wait_remaining_min - spent);
      if (runtime.wait_remaining_min <= 0) {
        audit.timeline.wait_ended_at = time(); finish('COMPLETED');
      }
      break;
    }
    throw new Error(`unknown decision transition phase: ${current}`);
  }
  return audit.status !== 'IN_PROGRESS';
}

module.exports = { createTransition, advanceTransition };

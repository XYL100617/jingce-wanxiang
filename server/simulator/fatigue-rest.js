'use strict';

const { addMinutes, toMillis } = require('../planner/time');

const clamp = value => Math.max(0, Math.min(1, value));
const level = value => clamp(Number(value ?? 0));

function mergeLevel(existingCount, existingLevel, incomingCount, incomingLevel) {
  if (!incomingCount) return level(existingLevel);
  return clamp((existingCount * level(existingLevel) + incomingCount * level(incomingLevel))
    / (existingCount + incomingCount));
}

// Call before the matching count is added to its destination stock.
function addNodeFatigue(mobility, nodeId, count, incomingLevel) {
  if (!count || !mobility.node_fatigue) return;
  mobility.node_fatigue[nodeId] = mergeLevel(mobility.node_walkers[nodeId],
    mobility.node_fatigue[nodeId], count, incomingLevel);
}

function addPoiQueueFatigue(poi, count, incomingLevel) {
  if (!count || poi.queue_fatigue === undefined) return;
  poi.queue_fatigue = mergeLevel(poi.queue_count, poi.queue_fatigue, count, incomingLevel);
}

function addEventQueueFatigue(event, count, incomingLevel) {
  if (!count || event.queue_fatigue === undefined) return;
  event.queue_fatigue = mergeLevel(event.event_queue_count, event.queue_fatigue, count, incomingLevel);
}

function addEventAttendingFatigue(event, count, incomingLevel) {
  if (!count || event.attending_fatigue === undefined) return;
  event.attending_fatigue = mergeLevel(event.attending_count, event.attending_fatigue,
    count, incomingLevel);
}

function validateFatigueParameters(parameters) {
  for (const name of ['fatigue_walk_rate', 'fatigue_queue_rate', 'fatigue_visit_rate',
    'fatigue_event_rate', 'fatigue_recovery_rate', 'rest_trigger_threshold',
    'rest_release_threshold', 'rest_accept_rate', 'minimum_rest_duration_min']) {
    if (!Number.isFinite(parameters[name]) || parameters[name] < 0) {
      throw new RangeError(`invalid fatigue parameter: ${name}`);
    }
  }
  if (parameters.rest_trigger_threshold <= parameters.rest_release_threshold
    || parameters.rest_trigger_threshold > 1 || parameters.rest_accept_rate > 1
    || parameters.minimum_rest_duration_min <= 0) {
    throw new RangeError('rest thresholds, acceptance or duration are invalid');
  }
}

function ageFatigue(state, durationMin, parameters) {
  const mobility = state.mobility_ledger;
  for (const nodeId of Object.keys(mobility.node_walkers)) {
    if (mobility.node_walkers[nodeId]) mobility.node_fatigue[nodeId] =
      clamp(mobility.node_fatigue[nodeId] + parameters.fatigue_walk_rate * durationMin);
  }
  for (const group of mobility.transit_groups) group.fatigue_level =
    clamp(level(group.fatigue_level) + parameters.fatigue_walk_rate * durationMin);
  for (const poi of Object.values(state.pois)) {
    if (poi.queue_count) poi.queue_fatigue =
      clamp(poi.queue_fatigue + parameters.fatigue_queue_rate * durationMin);
    for (const group of poi.inside_groups) group.fatigue_level =
      clamp(level(group.fatigue_level) + parameters.fatigue_visit_rate * durationMin);
  }
  for (const event of Object.values(state.events)) {
    if (!event.is_show_event) continue;
    if (event.event_queue_count) event.queue_fatigue =
      clamp(event.queue_fatigue + parameters.fatigue_queue_rate * durationMin);
    if (event.attending_count) event.attending_fatigue =
      clamp(event.attending_fatigue + parameters.fatigue_event_rate * durationMin);
  }
  for (const group of state.rest_groups) group.fatigue_level =
    clamp(group.fatigue_level - parameters.fatigue_recovery_rate * durationMin);
  state.visitor.fatigue = clamp(state.visitor.fatigue + parameters.fatigue_walk_rate * durationMin);
}

function completeRest(state, currentTime, parameters) {
  let completed = 0;
  const retained = [];
  const groups = [];
  for (const group of state.rest_groups) {
    if (toMillis(currentTime) < toMillis(group.minimum_rest_until)
      || group.fatigue_level > parameters.rest_release_threshold) {
      retained.push(group);
      continue;
    }
    addNodeFatigue(state.mobility_ledger, group.node_id, group.count, group.fatigue_level);
    state.mobility_ledger.node_walkers[group.node_id] += group.count;
    state.population_ledger.resting -= group.count;
    state.population_ledger.walking += group.count;
    completed += group.count;
    groups.push({ ...group, completed_at: currentTime });
  }
  state.rest_groups = retained;
  state.rest_completed_total += completed;
  return { rest_completed: completed, groups };
}

function dispatchRestIntents(state, durationMin, parameters, rng, departureTime,
  blockedNodes = new Set()) {
  const mobility = state.mobility_ledger;
  let started = 0;
  const groups = [];
  for (const nodeId of Object.keys(mobility.node_walkers)) {
    if (blockedNodes.has(nodeId) || mobility.node_fatigue[nodeId] < parameters.rest_trigger_threshold) continue;
    const eligible = mobility.node_walkers[nodeId] - mobility.pending_exit_intent[nodeId];
    if (eligible <= 0) continue;
    const expected = eligible * parameters.rest_accept_rate * durationMin
      / parameters.simulation_step_min;
    const desired = Math.min(eligible, Math.floor(expected) + Number(rng.next() < expected % 1));
    if (!desired) continue;
    const group = { rest_id: `rest_${String(state.next_rest_id++).padStart(6, '0')}`,
      count: desired, node_id: nodeId,
      started_at: departureTime,
      minimum_rest_until: addMinutes(departureTime, parameters.minimum_rest_duration_min),
      fatigue_level: mobility.node_fatigue[nodeId] };
    mobility.node_walkers[nodeId] -= desired;
    state.population_ledger.walking -= desired;
    state.population_ledger.resting += desired;
    state.rest_groups.push(group);
    groups.push(group);
    started += desired;
  }
  state.rest_started_total += started;
  return { rest_intent_created: started, rest_started: started, groups };
}

function summarizeFatigue(state) {
  const stocks = [];
  const mobility = state.mobility_ledger;
  for (const [id, count] of Object.entries(mobility.node_walkers)) {
    stocks.push([count, mobility.node_fatigue[id]]);
  }
  for (const group of mobility.transit_groups) stocks.push([group.count, group.fatigue_level]);
  for (const poi of Object.values(state.pois)) {
    stocks.push([poi.queue_count, poi.queue_fatigue]);
    for (const group of poi.inside_groups) stocks.push([group.count, group.fatigue_level]);
  }
  for (const event of Object.values(state.events).filter(item => item.is_show_event)) {
    stocks.push([event.event_queue_count, event.queue_fatigue]);
    stocks.push([event.attending_count, event.attending_fatigue]);
  }
  for (const group of state.rest_groups) stocks.push([group.count, group.fatigue_level]);
  const summary = { fatigue_low_count: 0, fatigue_medium_count: 0, fatigue_high_count: 0 };
  let mass = 0;
  for (const [count, fatigue] of stocks) {
    if (!count) continue;
    const key = fatigue < .35 ? 'fatigue_low_count'
      : fatigue < .7 ? 'fatigue_medium_count' : 'fatigue_high_count';
    summary[key] += count;
    mass += count * fatigue;
  }
  summary.fatigue_mean = state.environment.park_population
    ? Math.round(mass / state.environment.park_population * 1000) / 1000 : 0;
  summary.rest_started_total = state.rest_started_total;
  summary.rest_completed_total = state.rest_completed_total;
  summary.resting_current = state.population_ledger.resting;
  return summary;
}

function validateFatigue(state, nodeIds) {
  const valid = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const mobility = state.mobility_ledger;
  if (Object.keys(mobility.node_fatigue).length !== Object.keys(mobility.node_walkers).length
    || Object.values(mobility.node_fatigue).some(value => !valid(value))
    || mobility.transit_groups.some(group => !valid(group.fatigue_level))
    || Object.values(state.pois).some(poi => !valid(poi.queue_fatigue)
      || poi.inside_groups.some(group => !valid(group.fatigue_level)))
    || Object.values(state.events).filter(event => event.is_show_event).some(event =>
      !valid(event.queue_fatigue) || !valid(event.attending_fatigue))
    || !valid(state.visitor.fatigue)
    || !Number.isSafeInteger(state.rest_started_total) || !Number.isSafeInteger(state.rest_completed_total)
    || state.rest_started_total < state.rest_completed_total) {
    throw new Error('fatigue level invariant failed');
  }
  let restTotal = 0;
  for (const group of state.rest_groups) {
    if (typeof group.rest_id !== 'string' || !Number.isSafeInteger(group.count)
      || group.count <= 0 || !nodeIds.has(group.node_id)
      || !valid(group.fatigue_level) || toMillis(group.minimum_rest_until) <= toMillis(group.started_at)) {
      throw new Error('rest group invariant failed');
    }
    restTotal += group.count;
  }
  if (restTotal !== state.population_ledger.resting
    || state.rest_started_total - state.rest_completed_total !== restTotal) {
    throw new Error('rest population conservation failed');
  }
  const summary = summarizeFatigue(state);
  if (summary.fatigue_low_count + summary.fatigue_medium_count + summary.fatigue_high_count
    !== state.environment.park_population) throw new Error('fatigue stock coverage failed');
  return summary;
}

module.exports = { clamp, mergeLevel, addNodeFatigue, addPoiQueueFatigue,
  addEventQueueFatigue, addEventAttendingFatigue, validateFatigueParameters,
  ageFatigue, completeRest, dispatchRestIntents, summarizeFatigue, validateFatigue };

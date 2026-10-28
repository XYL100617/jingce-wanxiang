'use strict';

const { addMinutes, toMillis } = require('../planner/time');
const { OBSERVATION_VERSION } = require('./parameter-registry');

const clone = value => JSON.parse(JSON.stringify(value));
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const SCENARIOS = Object.freeze({
  P1D_CLEAN: Object.freeze({ noise: false, missing: false, delay: false }),
  P1D_NOISY: Object.freeze({ noise: true, missing: false, delay: false }),
  P1D_MISSING: Object.freeze({ noise: false, missing: true, delay: false }),
  P1D_DELAYED: Object.freeze({ noise: false, missing: false, delay: true }),
  P1D_MIXED: Object.freeze({ noise: true, missing: true, delay: true })
});

function gaussian(rng) {
  const u1 = Math.max(Number.EPSILON, rng.next());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng.next());
}

function generateObservation(state, rng, parameters, scenarioId = 'P1D_CLEAN') {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new RangeError(`unknown observation scenario: ${scenarioId}`);
  if (!rng || typeof rng.next !== 'function') throw new TypeError('observation requires SeededRNG');
  const observed_at = state.simulation_time;
  const available_at = addMinutes(observed_at, scenario.delay ? parameters.observation_delay_min : 0);
  const pois = {}, roads = {}, events = {}, missing_mask = { pois: {}, roads: {}, events: {} };
  for (const [id, poi] of Object.entries(state.pois)) {
    const missing = scenario.missing && rng.next() < parameters.queue_missing_rate;
    const queueCount = missing ? null : Math.max(0, Math.round(poi.queue_count
      + (scenario.noise ? gaussian(rng) * parameters.queue_noise_std : 0)));
    const queueTime = queueCount === null || poi.service_rate <= 0
      ? null : round(queueCount / poi.service_rate);
    const crowd = clamp(Number(poi.crowd_ratio || 0)
      + (scenario.noise ? gaussian(rng) * parameters.crowd_noise_std : 0), 0, 1);
    pois[id] = { queue_count: queueCount, queue_time_min: queueTime,
      crowd_ratio: round(crowd, 3), is_open: poi.is_open,
      observed_at, available_at, is_open_available_at: observed_at };
    missing_mask.pois[id] = { queue_count: queueCount === null,
      queue_time_min: queueTime === null, crowd_ratio: false, is_open: false };
  }
  for (const [id, road] of Object.entries(state.roads)) {
    const missing = scenario.missing && rng.next() < parameters.travel_time_missing_rate;
    const base = road.effective_travel_time_min;
    const travelTime = missing ? null : Math.max(0, round(base *
      (1 + (scenario.noise ? gaussian(rng) * parameters.travel_time_noise_ratio : 0)), 2));
    roads[id] = { is_open: road.is_open, travel_time_min: travelTime,
      observed_at, available_at, is_open_available_at: observed_at };
    missing_mask.roads[id] = { is_open: false, travel_time_min: travelTime === null };
  }
  for (const [id, event] of Object.entries(state.events)) {
    if (!event.is_show_event) continue; // A forecast marker is not a published show.
    const missing = scenario.missing && rng.next() < parameters.queue_missing_rate;
    events[id] = {
      event_id: event.event_id, node_id: event.node_id,
      start_time: event.start_time, latest_entry_time: event.latest_entry_time,
      end_time: event.end_time, end_time_basis: event.end_time_basis,
      boarding_open_time: event.boarding_open_time, time_sources: clone(event.time_sources),
      phase: event.phase, status: event.status, cancelled: event.cancelled,
      event_queue_count: missing ? null : Math.max(0, Math.round(event.event_queue_count
        + (scenario.noise ? gaussian(rng) * parameters.queue_noise_std : 0))),
      attending_count: missing ? null : Math.max(0, Math.round(event.attending_count
        + (scenario.noise ? gaussian(rng) * parameters.queue_noise_std : 0))),
      observed_at, available_at, status_available_at: observed_at
    };
    missing_mask.events[id] = { event_queue_count: missing, attending_count: missing,
      phase: false, status: false, cancelled: false };
  }
  const visitor = state.visitor;
  return {
    synthetic: true, source_tier: 'T4', observation_version: OBSERVATION_VERSION,
    parameter_version: OBSERVATION_VERSION, observation_scenario_id: scenarioId,
    schema_version: state.schema_version, scenario_id: state.scenario_id,
    observed_at, available_at,
    weather: clone(state.environment.weather),
    pois, roads,
    visitor: { visitor_id: visitor.visitor_id, current_node_id: visitor.current_node_id,
      remaining_time_min: visitor.remaining_time_min, fatigue: visitor.fatigue,
      visited_poi_ids: clone(visitor.visited_poi_ids),
      attended_event_ids: clone(visitor.attended_event_ids),
      visited_facility_ids: clone(visitor.visited_facility_ids),
      preference: clone(visitor.preference) },
    events, missing_mask
  };
}

function createObservationBuffer() {
  const captures = [];
  return {
    capture(observation) {
      if (captures.length && toMillis(observation.observed_at) <= toMillis(captures.at(-1).observed_at)) {
        throw new Error('observation captures must have increasing observed_at');
      }
      captures.push(clone(observation));
    },
    latestAvailable(currentTime) {
      const now = toMillis(currentTime);
      const safety = captures.findLast(item => toMillis(item.observed_at) <= now);
      if (!safety) return null;
      const ordinary = captures.findLast(item => toMillis(item.available_at) <= now);
      const pois = {}, roads = {}, events = {}, missing_mask = { pois: {}, roads: {}, events: {} };
      for (const [id, current] of Object.entries(safety.pois)) {
        const old = ordinary?.pois[id];
        pois[id] = { is_open: current.is_open,
          queue_count: old?.queue_count ?? null, queue_time_min: old?.queue_time_min ?? null,
          crowd_ratio: old?.crowd_ratio ?? null,
          observed_at: old?.observed_at ?? null, available_at: old?.available_at ?? null,
          is_open_available_at: safety.observed_at };
        missing_mask.pois[id] = { is_open: false,
          queue_count: pois[id].queue_count === null,
          queue_time_min: pois[id].queue_time_min === null,
          crowd_ratio: pois[id].crowd_ratio === null };
      }
      for (const [id, current] of Object.entries(safety.roads)) {
        const old = ordinary?.roads[id];
        roads[id] = { is_open: current.is_open, travel_time_min: old?.travel_time_min ?? null,
          observed_at: old?.observed_at ?? null, available_at: old?.available_at ?? null,
          is_open_available_at: safety.observed_at };
        missing_mask.roads[id] = { is_open: false, travel_time_min: roads[id].travel_time_min === null };
      }
      for (const [id, current] of Object.entries(safety.events)) {
        const old = ordinary?.events[id];
        events[id] = { event_id: current.event_id, node_id: current.node_id,
          start_time: current.start_time, latest_entry_time: current.latest_entry_time,
          end_time: current.end_time, end_time_basis: current.end_time_basis,
          boarding_open_time: current.boarding_open_time, time_sources: clone(current.time_sources),
          phase: current.phase, status: current.status, cancelled: current.cancelled,
          event_queue_count: old?.event_queue_count ?? null,
          attending_count: old?.attending_count ?? null,
          observed_at: old?.observed_at ?? null, available_at: old?.available_at ?? null,
          status_available_at: safety.observed_at };
        missing_mask.events[id] = { event_queue_count: events[id].event_queue_count === null,
          attending_count: events[id].attending_count === null,
          phase: false, status: false, cancelled: false };
      }
      return {
        synthetic: true, source_tier: 'T4', observation_version: safety.observation_version,
        parameter_version: safety.parameter_version,
        observation_scenario_id: safety.observation_scenario_id,
        schema_version: safety.schema_version, scenario_id: safety.scenario_id,
        timestamp: currentTime, observed_at: ordinary?.observed_at ?? null,
        available_at: ordinary?.available_at ?? null,
        safety_observed_at: safety.observed_at,
        weather: ordinary ? clone(ordinary.weather) : null,
        pois, roads, visitor: clone(safety.visitor), events, missing_mask
      };
    }
  };
}

module.exports = { SCENARIOS, generateObservation, createObservationBuffer };

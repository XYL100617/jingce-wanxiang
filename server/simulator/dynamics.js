'use strict';

const { addMinutes, toMillis } = require('../planner/time');
const { addNodeFatigue } = require('./fatigue-rest');

function stochasticCount(ratePerMin, durationMin, rng) {
  if (!Number.isFinite(ratePerMin) || ratePerMin < 0 || !Number.isFinite(durationMin) || durationMin < 0) {
    throw new RangeError('rate and duration must be nonnegative finite numbers');
  }
  const expected = ratePerMin * durationMin;
  const whole = Math.floor(expected);
  return whole + Number(rng.next() < expected - whole);
}

function advancePopulation(environment, durationMin, parameters, rng, ledger = null, mobility = null) {
  const population_before = environment.park_population;
  const arrivals = stochasticCount(parameters.arrival_rate * parameters.arrival_multiplier, durationMin, rng);
  const requestedDepartures = stochasticCount(parameters.departure_rate * parameters.departure_multiplier, durationMin, rng);
  if (ledger) {
    // Outside is an exogenous source, not a finite population forecast in P1-A.
    ledger.outside += arrivals;
    ledger.outside -= arrivals;
    ledger.walking += arrivals;
    if (mobility) {
      addNodeFatigue(mobility, mobility.entry_node_id, arrivals,
        parameters.initial_fatigue_level ?? 0.1);
      mobility.node_walkers[mobility.entry_node_id] += arrivals;
    }
  }
  const exitAvailable = mobility
    ? mobility.exit_node_ids.reduce((sum, id) => sum + mobility.node_walkers[id], 0) : null;
  const departures = Math.min(requestedDepartures, mobility ? exitAvailable : ledger ? ledger.walking : population_before + arrivals);
  if (ledger) {
    ledger.walking -= departures;
    ledger.exited_total += departures;
    if (mobility) {
      let remaining = departures;
      for (const id of mobility.exit_node_ids) {
        const leaving = Math.min(remaining, mobility.node_walkers[id]);
        mobility.node_walkers[id] -= leaving;
        remaining -= leaving;
      }
      if (remaining) throw new Error('exit node departure allocation failed');
    }
  }
  environment.park_population = population_before + arrivals - departures;
  environment.arrivals_total += arrivals;
  environment.departures_total += departures;
  return { population_before, arrivals, departures, population_after: environment.park_population };
}

function advancePoiService(pois, ledger, mobility, durationMin, segmentStartTime) {
  const segmentEnd = addMinutes(segmentStartTime, durationMin);
  const flows = {};
  for (const [poiId, poi] of Object.entries(pois)) {
    const queue_before = poi.queue_count, inside_before = poi.inside_count;
    const admitted = poi.is_open
      ? Math.min(poi.queue_count, Math.max(0, Math.floor(poi.capacity - poi.inside_count)), Math.floor(poi.admission_rate * durationMin)) : 0;
    // Only groups admitted before this interval can complete. A due group may
    // wait for service throughput, but nobody leaves before its own leave_at.
    let remainingService = Math.floor(poi.service_rate * durationMin);
    let completed = 0;
    const retained = [];
    for (const group of poi.inside_groups) {
      const leaving = toMillis(group.leave_at) <= toMillis(segmentEnd)
        ? Math.min(group.count, remainingService) : 0;
      completed += leaving;
      remainingService -= leaving;
      if (leaving) {
        const nodeId = mobility.poi_node_map[poiId];
        addNodeFatigue(mobility, nodeId, leaving, group.fatigue_level);
        mobility.node_walkers[nodeId] += leaving;
      }
      if (group.count > leaving) retained.push({ ...group, count: group.count - leaving });
    }
    poi.inside_groups = retained;
    if (admitted) poi.inside_groups.push({ count: admitted, poi_id: poiId,
      entered_at: segmentEnd, leave_at: addMinutes(segmentEnd, poi.visit_duration_min),
      fatigue_level: poi.queue_fatigue ?? 0 });
    poi.queue_count -= admitted;
    poi.inside_count += admitted - completed;
    ledger.queueing -= admitted;
    ledger.inside_poi += admitted - completed;
    ledger.walking += completed;
    poi.queue = poi.queue_count;
    flows[poiId] = { queue_before, inside_before, arrivals: 0, admitted, completed,
      served: admitted, queue_after: poi.queue_count, inside_after: poi.inside_count };
  }
  return flows;
}

function advanceQueues(pois, ledger, durationMin, parameters, rng) {
  const openIds = Object.keys(pois).filter(id => pois[id].is_open);
  const assigned = Object.fromEntries(Object.keys(pois).map(id => [id, 0]));
  const desired = openIds.length
    ? stochasticCount(ledger.walking * parameters.poi_arrival_fraction * parameters.queue_multiplier / parameters.simulation_step_min, durationMin, rng)
    : 0;
  const arrivalsToPois = Math.min(ledger.walking, desired);
  for (let i = 0; i < arrivalsToPois; i += 1) assigned[rng.choice(openIds)] += 1;
  ledger.walking -= arrivalsToPois;

  const flows = {};
  for (const [poiId, poi] of Object.entries(pois)) {
    const queue_before = poi.queue_count, inside_before = poi.inside_count;
    const arrivals = assigned[poiId];
    poi.queue_count += arrivals;
    // Capacity is simultaneous inside occupancy. Admission and completion
    // rates are separate; no slot freed later in this segment is reused here.
    const admitted = poi.is_open
      ? Math.min(poi.queue_count, Math.max(0, Math.floor(poi.capacity - poi.inside_count)), Math.floor(poi.admission_rate * durationMin)) : 0;
    poi.queue_count -= admitted;
    poi.inside_count += admitted;
    // Closure blocks new arrivals/admission, while already-inside visitors finish.
    const completed = Math.min(poi.inside_count, Math.floor(poi.service_rate * durationMin));
    poi.inside_count -= completed;
    ledger.walking += completed;
    ledger.queueing += arrivals - admitted;
    ledger.inside_poi += admitted - completed;
    poi.queue = poi.queue_count; // Read compatibility for the committed P0 API.
    flows[poiId] = { queue_before, inside_before, arrivals, admitted, completed,
      served: admitted, queue_after: poi.queue_count, inside_after: poi.inside_count };
  }
  return flows;
}

module.exports = { stochasticCount, advancePopulation, advanceQueues, advancePoiService };

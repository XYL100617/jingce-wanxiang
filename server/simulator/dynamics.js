'use strict';

function stochasticCount(ratePerMin, durationMin, rng) {
  if (!Number.isFinite(ratePerMin) || ratePerMin < 0 || !Number.isFinite(durationMin) || durationMin < 0) {
    throw new RangeError('rate and duration must be nonnegative finite numbers');
  }
  const expected = ratePerMin * durationMin;
  const whole = Math.floor(expected);
  return whole + Number(rng.next() < expected - whole);
}

function advancePopulation(environment, durationMin, parameters, rng) {
  const population_before = environment.park_population;
  const arrivals = stochasticCount(parameters.arrival_rate * parameters.arrival_multiplier, durationMin, rng);
  const requestedDepartures = stochasticCount(parameters.departure_rate * parameters.departure_multiplier, durationMin, rng);
  const departures = Math.min(requestedDepartures, population_before + arrivals);
  environment.park_population = population_before + arrivals - departures;
  environment.arrivals_total += arrivals;
  environment.departures_total += departures;
  return { population_before, arrivals, departures, population_after: environment.park_population };
}

function advanceQueues(pois, durationMin, parameters, rng) {
  const ledger = {};
  for (const [poiId, poi] of Object.entries(pois)) {
    const queue_before = poi.queue;
    // P0 closure rule: no new arrivals or service; the existing queue stays put.
    const arrivals = poi.is_open
      ? stochasticCount(parameters.queue_arrival_range * parameters.queue_multiplier, durationMin, rng) : 0;
    // Capacity is a T4 per-interval service cap proxy until occupancy is modeled in P1.
    const served = poi.is_open
      ? Math.min(queue_before + arrivals, Math.floor(poi.service_rate * durationMin), Math.floor(poi.capacity)) : 0;
    poi.queue = queue_before + arrivals - served;
    ledger[poiId] = { queue_before, arrivals, served, queue_after: poi.queue };
  }
  return ledger;
}

module.exports = { stochasticCount, advancePopulation, advanceQueues };

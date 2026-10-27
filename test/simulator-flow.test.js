'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SeededRNG } = require('../server/simulator/seeded-rng');
const { advancePopulation, advanceQueues } = require('../server/simulator/dynamics');
const { createSimulator } = require('../server/simulator/simulator');

function inPark(ledger) {
  return ledger.walking + ledger.queueing + ledger.inside_poi + ledger.resting + ledger.attending_event;
}

function fixture({ open = true, walking = 20, capacity = 10, inside = 2, queue = 4 } = {}) {
  return {
    pois: { museum: { queue_count: queue, queue, inside_count: inside, capacity,
      service_rate: 0.2, admission_rate: 1, is_open: open, crowd_ratio: 0.5 } },
    ledger: { outside: 0, walking, queueing: queue, inside_poi: inside,
      resting: 0, attending_event: 0, exited_total: 0 },
    params: { arrival_rate: 0, arrival_multiplier: 1, departure_rate: 0, departure_multiplier: 1,
      poi_arrival_fraction: 0.5, queue_multiplier: 1, simulation_step_min: 5 },
    rng: new SeededRNG(42)
  };
}

test('A: initial ledger components equal park population', () => {
  const state = createSimulator({ seed: 42 }).getState();
  assert.equal(inPark(state.population_ledger), state.environment.park_population);
  assert.equal(state.population_ledger.outside, 0);
  assert.equal(state.population_ledger.exited_total, 0);
});

test('B: new park arrivals move from outside source to walking', () => {
  const { ledger, params, rng } = fixture();
  const environment = { park_population: inPark(ledger), arrivals_total: 0, departures_total: 0 };
  params.arrival_rate = 2;
  const result = advancePopulation(environment, 5, params, rng, ledger);
  assert.equal(result.arrivals, 10);
  assert.equal(ledger.walking, 30);
  assert.equal(environment.park_population, 36);
  assert.equal(ledger.outside, 0);
});

test('C: walking to POI queue only transfers existing people', () => {
  const { pois, ledger, params, rng } = fixture();
  const before = inPark(ledger), walkingBefore = ledger.walking;
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.arrivals, 10);
  assert.equal(ledger.walking, walkingBefore - flow.arrivals + flow.completed);
  assert.equal(inPark(ledger), before);
});

test('D: queue admission increases inside without increasing park population', () => {
  const { pois, ledger, params, rng } = fixture();
  const before = inPark(ledger);
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.admitted, 5);
  assert.equal(flow.queue_after, flow.queue_before + flow.arrivals - flow.admitted);
  assert.equal(inPark(ledger), before);
});

test('E: completed visitors return from inside to walking', () => {
  const { pois, ledger, params, rng } = fixture();
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.completed, 1);
  assert.equal(flow.inside_after, flow.inside_before + flow.admitted - flow.completed);
  assert.equal(ledger.walking, 20 - flow.arrivals + flow.completed);
});

test('F: departures come only from walking and increase exited_total', () => {
  const { ledger, params, rng } = fixture();
  const environment = { park_population: inPark(ledger), arrivals_total: 0, departures_total: 0 };
  params.departure_rate = 2;
  const result = advancePopulation(environment, 5, params, rng, ledger);
  assert.equal(result.departures, 10);
  assert.equal(ledger.walking, 10);
  assert.equal(ledger.exited_total, 10);
  assert.equal(environment.park_population, inPark(ledger));
});

test('F2: departures cannot remove people who are queueing or inside', () => {
  const { ledger, params, rng } = fixture({ walking: 0 });
  const environment = { park_population: inPark(ledger), arrivals_total: 0, departures_total: 0 };
  params.departure_rate = 100;
  const result = advancePopulation(environment, 5, params, rng, ledger);
  assert.equal(result.departures, 0);
  assert.equal(environment.park_population, 6);
  assert.equal(ledger.exited_total, 0);
});

test('G: sum of POI queues equals ledger.queueing', () => {
  const simulator = createSimulator({ seed: 42 });
  simulator.runSteps(8);
  const state = simulator.getState();
  assert.equal(Object.values(state.pois).reduce((sum, poi) => sum + poi.queue_count, 0), state.population_ledger.queueing);
});

test('H: sum of inside counts equals ledger.inside_poi', () => {
  const simulator = createSimulator({ seed: 42 });
  simulator.runSteps(8);
  const state = simulator.getState();
  assert.equal(Object.values(state.pois).reduce((sum, poi) => sum + poi.inside_count, 0), state.population_ledger.inside_poi);
});

test('I: admission never exceeds available simultaneous capacity', () => {
  const { pois, ledger, params, rng } = fixture({ capacity: 3, inside: 2 });
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.admitted, 1);
  assert.ok(pois.museum.inside_count <= pois.museum.capacity);
});

test('J: a POI queue cannot gain people when walking pool is empty', () => {
  const { pois, ledger, params, rng } = fixture({ walking: 0 });
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.arrivals, 0);
  assert.ok(flow.queue_after <= flow.queue_before);
  assert.equal(inPark(ledger), 6);
});

test('K: closed POI receives no walking visitors or admission', () => {
  const { pois, ledger, params, rng } = fixture({ open: false });
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.arrivals, 0);
  assert.equal(flow.admitted, 0);
  assert.equal(flow.queue_after, flow.queue_before);
});

test('L: already inside a closed POI may finish and return to walking', () => {
  const { pois, ledger, params, rng } = fixture({ open: false });
  const before = inPark(ledger);
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.equal(flow.completed, 1);
  assert.equal(ledger.walking, 21);
  assert.equal(inPark(ledger), before);
});

test('M: reopening a POI resumes walking arrivals and admission', () => {
  const { pois, ledger, params, rng } = fixture({ open: false });
  advanceQueues(pois, ledger, 5, params, rng);
  pois.museum.is_open = true;
  const flow = advanceQueues(pois, ledger, 5, params, rng).museum;
  assert.ok(flow.arrivals > 0);
  assert.ok(flow.admitted > 0);
});

test('N: all population and POI invariants hold through 50 steps', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  for (const step of simulator.runSteps(50)) {
    assert.equal(step.invariant_summary.ledger, 'PASS');
    assert.equal(step.invariant_summary.inside_capacity, 'PASS');
    assert.equal(step.invariant_summary.cumulative_population, 'PASS');
    const state = step.population;
    assert.equal(state.population_after, state.population_before + state.arrivals - state.departures);
    for (const flow of Object.values(step.poi_flows)) {
      assert.equal(flow.queue_after, flow.queue_before + flow.arrivals - flow.admitted);
      assert.equal(flow.inside_after, flow.inside_before + flow.admitted - flow.completed);
    }
  }
  const state = simulator.getState();
  assert.equal(inPark(state.population_ledger), state.environment.park_population);
  assert.equal(state.environment.initial_population + state.environment.arrivals_total - state.environment.departures_total,
    state.environment.park_population);
  assert.equal(state.population_ledger.exited_total, state.environment.departures_total);
});

test('O: same seed reproduces the full aggregate flow ledger', () => {
  const run = seed => createSimulator({ scenario: 'P0_BASELINE', seed }).runSteps(20)
    .map(step => ({ population: step.population, population_flow: step.population_flow,
      poi_queue_summary: step.poi_queue_summary, poi_flows: step.poi_flows }));
  assert.deepEqual(run(42), run(42));
});

test('P: different seeds change aggregate flow allocation', () => {
  const run = seed => createSimulator({ scenario: 'P0_BASELINE', seed }).runSteps(20)
    .map(step => ({ population: step.population, population_flow: step.population_flow, poi_flows: step.poi_flows }));
  assert.notDeepEqual(run(42), run(43));
});

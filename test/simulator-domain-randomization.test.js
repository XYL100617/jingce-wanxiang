'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const provider = require('../server/state/stateProvider');
const { createSimulator } = require('../server/simulator/simulator');
const { sampleScenario, validateScenarioInstance } = require('../server/simulator/scenario-sampler');
const { createVisitorProfile, samplePlanAcceptance, sampleDeviation,
  earlyExitPropensity, validateVisitorProfile } = require('../server/simulator/visitor-profile');
const { createEpisode } = require('../server/simulator/episode-writer');
const { advancePoiService } = require('../server/simulator/dynamics');
const { estimateRoad } = require('../server/simulator/road-dynamics');
const { advanceEventService } = require('../server/simulator/event-flow');
const { addMinutes } = require('../server/planner/time');

const BASE = { crowd_level: 'MEDIUM', calendar_type: 'WEEKDAY', weather: 'CLEAR',
  visitor_speed_distribution: 'NORMAL', dwell_distribution: 'NORMAL',
  road_condition: 'NORMAL', event_condition: 'NORMAL_EVENT', observation_quality: 'CLEAN' };
const sample = (changes = {}, seed = 42) => sampleScenario({ seed,
  dimensions: { ...BASE, ...changes } });
function runAction(sim, type, target) {
  const action = sim.getLegalActions().legal.find(row => row.action.action_type === type
    && row.action.target_id === target)?.action;
  assert.ok(action, `legal ${type}:${target}`);
  sim.startDecisionTransition(action);
  for (let index = 0; index < 70; index += 1) {
    const step = sim.step();
    if (step.decision_transition?.audit.status !== 'IN_PROGRESS' && step.decision_transition) {
      return { ...step.decision_transition, step };
    }
  }
  throw new Error('transition did not end');
}

test('DR1 same seed reproduces scenario instance', () => assert.deepEqual(sample(), sample()));
test('DR2 different seed changes sampled parameters', () => {
  assert.notDeepEqual(sample({}, 42).sampled_parameters, sample({}, 43).sampled_parameters);
});
test('DR3 sampled parameters stay within declared bounds', () => {
  for (const seed of [0, 1, 42, 4294967295])
    assert.doesNotThrow(() => validateScenarioInstance(sample({}, seed)));
  const invalid = structuredClone(sample());
  invalid.sampled_parameters.position_confidence = 2;
  assert.throws(() => validateScenarioInstance(invalid), /invalid/);
});
test('DR4 LOW arrival scale is below MEDIUM below HIGH', () => {
  const scales = ['LOW', 'MEDIUM', 'HIGH'].map(crowd_level =>
    sample({ crowd_level }).sampled_parameters.arrival_scale);
  assert.ok(scales[0] < scales[1] && scales[1] < scales[2]);
});
test('DR5 WEEKDAY and WEEKEND have distinct T4 arrival scales', () => {
  assert.ok(sample({ calendar_type: 'WEEKDAY' }).sampled_parameters.arrival_scale
    < sample({ calendar_type: 'WEEKEND' }).sampled_parameters.arrival_scale);
});
test('DR6 CLEAR, HOT and RAIN affect the existing road dynamics', () => {
  const times = ['CLEAR', 'HOT', 'RAIN'].map(weather => {
    const state = createSimulator({ seed: 42, scenarioInstance: sample({ weather }) }).getState();
    assert.deepEqual(state.environment.weather, { category: weather });
    return state.roads.edge_001.effective_travel_time_min;
  });
  assert.ok(times[0] < times[1] && times[1] < times[2]);
});
test('DR7 LOCAL_CLOSURE closes and reopens the selected edge', () => {
  const instance = sample({ road_condition: 'LOCAL_CLOSURE' });
  const sim = createSimulator({ seed: 42, scenarioInstance: instance });
  const edgeId = sim.getScenarioInstance().closure_edge_id;
  assert.ok(sim.getGraph().edges.some(edge => edge.edge_id === edgeId));
  assert.equal(sim.getScenarioInstance().provenance.closure_edge_id, edgeId);
  assert.equal(sim.getState().roads[edgeId].is_open, true);
  const startSteps = instance.sampled_parameters.road_closure_start_min / 5;
  sim.runSteps(startSteps);
  assert.equal(sim.getState().roads[edgeId].is_open, false);
  sim.runSteps(instance.sampled_parameters.road_closure_duration_min / 5);
  assert.equal(sim.getState().roads[edgeId].is_open, true);
});
test('DR8 EVENT_DELAY shifts all show-1 milestones and preserves order', () => {
  const instance = sample({ event_condition: 'EVENT_DELAY' });
  const original = createSimulator({ seed: 42 }).getState().events['show-1'];
  const delayed = createSimulator({ seed: 42, scenarioInstance: instance }).getState().events['show-1'];
  for (const key of ['boarding_open_time', 'latest_entry_time', 'start_time', 'end_time'])
    assert.equal(delayed[key], addMinutes(original[key], instance.sampled_parameters.event_delay_min));
  assert.ok(delayed.boarding_open_time < delayed.start_time && delayed.start_time < delayed.end_time);
  assert.equal(delayed.time_sources.start_time.type, 'SCENARIO_T4_OVERLAY');
  assert.deepEqual(provider.getState().event_states['show-1'].start_time, original.start_time);
});
test('DR9 NOISY changes numeric observations through P1-D', () => {
  const sim = createSimulator({ seed: 42, scenarioInstance: sample({ observation_quality: 'NOISY' }) });
  const observed = sim.getObservation(), state = sim.getState();
  assert.equal(observed.observation_scenario_id, 'P1D_NOISY');
  assert.ok(Object.keys(observed.pois).some(id => observed.pois[id].queue_count !== state.pois[id].queue_count));
});
test('DR10 MISSING masks ordinary observation fields', () => {
  const sim = createSimulator({ seed: 42, scenarioInstance: sample({ observation_quality: 'MISSING' }) });
  const observation = sim.getObservation();
  assert.equal(observation.observation_scenario_id, 'P1D_MISSING');
  assert.ok(Object.values(observation.missing_mask.pois).some(mask => mask.queue_count));
  assert.ok(Object.values(observation.roads).every(road => typeof road.is_open === 'boolean'));
});
test('DR11 DELAYED postpones ordinary fields while safety stays current', () => {
  const instance = sample({ observation_quality: 'DELAYED' });
  const sim = createSimulator({ seed: 42, scenarioInstance: instance });
  const before = sim.getObservation();
  assert.equal(before.available_at, null);
  assert.ok(Object.values(before.roads).every(road => typeof road.is_open === 'boolean'));
  sim.runSteps(instance.sampled_parameters.observation_delay_min / 5);
  const after = sim.getObservation();
  assert.ok(after.observed_at);
  assert.ok(after.observed_at < after.timestamp);
});
test('DR12 shadow speed changes actual travel time without changing the aggregate road', () => {
  const results = [0.8, 1, 1.2].map(walking_speed_factor => {
    const profile = createVisitorProfile({ seed: 42, overrides: { walking_speed_factor } });
    const sim = createSimulator({ seed: 42, visitorProfile: profile });
    return runAction(sim, 'EXIT', 'exit_southgate').audit.actual_travel_time_min;
  });
  assert.ok(results[0] > results[1] && results[1] > results[2]);
});
test('DR13 dwell factor changes shadow VISIT duration', () => {
  const duration = [0.8, 1, 1.2].map(dwell_time_factor => {
    const sim = createSimulator({ seed: 42, visitorProfile: createVisitorProfile({ seed: 42,
      overrides: { dwell_time_factor } }) });
    const audit = runAction(sim, 'VISIT_POI', 'market').audit;
    return (Date.parse(audit.timeline.inside_ended_at) - Date.parse(audit.timeline.inside_started_at)) / 60000;
  });
  assert.ok(duration[0] < duration[1] && duration[1] < duration[2]);
});
test('DR14 preference profile is deterministic and uses graph node types', () => {
  const one = createVisitorProfile({ seed: 42 });
  assert.deepEqual(one, createVisitorProfile({ seed: 42 }));
  assert.deepEqual(Object.keys(one.preference_weights).sort(), ['culture', 'scenery', 'show', 'view']);
  assert.deepEqual(createSimulator({ seed: 42, visitorProfile: one }).getObservation().visitor.profile, one);
});
test('DR15 plan acceptance sample is seeded and does not choose actions', () => {
  const profile = createVisitorProfile({ seed: 42 });
  assert.deepEqual(samplePlanAcceptance(profile, 2), samplePlanAcceptance(profile, 2));
  assert.equal(typeof samplePlanAcceptance(profile, 2).accepted, 'boolean');
});
test('DR16 next-decision deviation sample is seeded', () => {
  const profile = createVisitorProfile({ seed: 42 });
  assert.deepEqual(sampleDeviation(profile, 2), sampleDeviation(profile, 2));
  assert.equal(typeof sampleDeviation(profile, 2).deviate_at_next_decision, 'boolean');
});
test('DR17 early-exit propensity rises with fatigue and time pressure', () => {
  const profile = createVisitorProfile({ seed: 42 });
  const low = earlyExitPropensity(profile, { fatigue: 0.1, remaining_time_min: 240, weather: 'CLEAR' });
  const high = earlyExitPropensity(profile, { fatigue: 0.9, remaining_time_min: 30, weather: 'CLEAR' });
  assert.ok(high > low);
});
test('DR18 early-exit propensity does not teleport or start an EXIT action', () => {
  const profile = createVisitorProfile({ seed: 42 });
  const sim = createSimulator({ seed: 42, visitorProfile: profile });
  const before = sim.getState();
  earlyExitPropensity(profile, { fatigue: 0.9, remaining_time_min: 30, weather: 'RAIN' });
  assert.deepEqual(sim.getState(), before);
  assert.equal(sim.getActiveDecisionTransition(), null);
});
test('DR19 visitor profile leaves aggregate population trajectory unchanged', () => {
  const a = createSimulator({ seed: 42 });
  const b = createSimulator({ seed: 42, visitorProfile: createVisitorProfile({ seed: 42 }) });
  for (let i = 0; i < 5; i += 1) {
    a.step(); b.step();
    assert.equal(a.getState().environment.park_population, b.getState().environment.park_population);
  }
});
test('DR20 randomized scenario preserves road occupancy invariants', () => {
  const sim = createSimulator({ seed: 42, scenarioInstance: sample({ crowd_level: 'HIGH',
    calendar_type: 'WEEKEND', weather: 'RAIN', road_condition: 'LOCAL_CLOSURE',
    event_condition: 'EVENT_DELAY', observation_quality: 'MIXED' }) });
  for (const step of sim.runSteps(8)) {
    assert.equal(step.invariant_summary.population, 'PASS');
    assert.equal(step.invariant_summary.road_occupancy, 'PASS');
  }
});
test('DR21 sampling modules contain no unseeded Math.random', () => {
  for (const path of ['../server/simulator/visitor-profile.js', '../server/simulator/scenario-sampler.js'])
    assert.equal(fs.readFileSync(require.resolve(path), 'utf8').includes('Math.random('), false);
});
test('DR22 every sampled scenario parameter records T4 provenance', () => {
  const instance = sample();
  for (const name of Object.keys(instance.sampled_parameters)) {
    const meta = instance.provenance.parameters[name];
    assert.equal(meta.parameter_name, name);
    assert.equal(meta.source_tier, 'T4');
    assert.equal(meta.basis, 'ASSUMPTION');
    assert.ok(meta.distribution_type && meta.version);
  }
});
test('DR23 scenario instance ID is deterministic', () => {
  assert.match(sample().scenario_instance_id, /^scn_DR_BASE_seed42_000001_[0-9a-f]{8}$/);
  assert.notEqual(sample({}, 43).scenario_instance_id, sample().scenario_instance_id);
  assert.notEqual(sample({ weather: 'RAIN' }).scenario_instance_id, sample().scenario_instance_id);
});
test('DR24 Episode provenance retains scenario and visitor profile versions', () => {
  const instance = sample();
  const sim = createSimulator({ seed: 42, scenarioInstance: instance });
  const provenance = createEpisode(sim).provenance;
  assert.equal(provenance.scenario_instance_id, instance.scenario_instance_id);
  assert.equal(provenance.scenario_parameter_version, 'dr-p1.1');
  assert.equal(provenance.visitor_profile_version, 'visitor-p1.2');
  assert.equal(provenance.source_tier, 'T4');
});
test('DR25 baseline Episode and Transition Audit contracts remain available', () => {
  const sim = createSimulator({ seed: 42 });
  assert.equal(createEpisode(sim).episode_schema_version, 'episode-p1.1');
  assert.equal(sim.getMetadata().visitor_mode, 'SHADOW_VISITOR');
  assert.equal(validateVisitorProfile(createVisitorProfile({ seed: 42 })).source_tier, 'T4');
});

test('scenario dimensions reject invalid choices and keep input state immutable', () => {
  assert.throws(() => sample({ weather: 'SNOW' }), /invalid/);
  const state = provider.getState();
  const snapshot = structuredClone(state);
  createSimulator({ seed: 42, initialState: state,
    scenarioInstance: sample({ weather: 'RAIN', event_condition: 'EVENT_DELAY' }) });
  assert.deepEqual(state, snapshot);
});

test('position confidence describes uncertainty without moving the authoritative node', () => {
  const instance = sample({ observation_quality: 'NOISY' });
  const sim = createSimulator({ seed: 42, scenarioInstance: instance });
  assert.equal(sim.getObservation().visitor.current_node_id, sim.getState().visitor.current_node_id);
  assert.ok(sim.getObservation().visitor.position_confidence < 1);
  assert.ok(sim.getLegalActions().legal.length > 0);
});

test('DR26 noisy position observation stays on an adjacent graph node', () => {
  const sim = createSimulator({ seed: 42,
    scenarioInstance: sample({ observation_quality: 'NOISY' }) });
  const original = sim.getState().visitor.current_node_id;
  const graph = sim.getGraph();
  let sawUncertain = false;
  for (let index = 0; index < 20; index += 1) {
    const observation = sim.getObservation().visitor.position_observation;
    assert.equal(observation.authoritative_node_id, sim.getState().visitor.current_node_id);
    assert.ok(observation.candidate_nodes.includes(observation.reported_node_id));
    assert.ok(observation.candidate_nodes.every(id => id === observation.authoritative_node_id
      || graph.edges.some(edge => edge.from_node_id === observation.authoritative_node_id
        && edge.to_node_id === id || edge.to_node_id === observation.authoritative_node_id
        && edge.from_node_id === id)));
    if (observation.reported_node_id !== observation.authoritative_node_id) sawUncertain = true;
    sim.step();
  }
  assert.equal(sim.getState().visitor.current_node_id, original);
  assert.equal(sawUncertain, true);
  const clean = createSimulator({ seed: 42, scenarioInstance: sample() }).getObservation().visitor.position_observation;
  assert.equal(clean.reported_node_id, clean.authoritative_node_id);
  assert.equal(clean.noise_type, 'NONE');
});

test('DR27 closure edge is seeded and varies across seeds', () => {
  const run = seed => createSimulator({ seed, scenarioInstance:
    sample({ road_condition: 'LOCAL_CLOSURE' }, seed) }).getScenarioInstance().closure_edge_id;
  assert.equal(run(42), run(42));
  assert.notEqual(run(42), run(43));
});

test('DR28 sampled capacity and service scales multiply existing base parameters', () => {
  const instance = sample();
  const base = createSimulator({ seed: 42 }).getResolvedParameters();
  const effective = createSimulator({ seed: 42, scenarioInstance: instance }).getResolvedParameters();
  const p = instance.sampled_parameters;
  for (const [baseKey, scaleKey] of [
    ['default_poi_capacity', 'poi_capacity_scale'], ['default_service_rate', 'poi_service_scale'],
    ['road_reference_capacity', 'road_capacity_scale'],
    ['event_admission_rate', 'event_admission_scale'], ['event_release_rate', 'event_release_scale']
  ]) assert.equal(effective[baseKey], base[baseKey] * p[scaleKey]);
  assert.equal(effective.default_admission_rate, base.default_admission_rate * p.poi_service_scale);
  assert.equal(instance.provenance.parameters.poi_service_scale.source_tier, 'T4');
});

test('DR29 slower POI service leaves a longer queue under identical arrivals', () => {
  const base = createSimulator({ seed: 42 }).getState();
  const evolve = scale => {
    const state = structuredClone(base);
    const poi = state.pois.market;
    poi.queue_count = 100; poi.queue = 100; poi.inside_count = 0; poi.inside_groups = [];
    poi.service_rate *= scale; poi.admission_rate *= scale;
    advancePoiService(state.pois, state.population_ledger, state.mobility_ledger, 5,
      state.simulation_time);
    return poi.queue_count;
  };
  assert.ok(evolve(0.8) > evolve(1.2));
});

test('DR30 lower road capacity raises congestion at the same occupancy', () => {
  const sim = createSimulator({ seed: 42 });
  const base = sim.getState(), parameters = sim.getResolvedParameters();
  const travel = scale => {
    const state = structuredClone(base);
    state.roads.edge_001.reference_capacity *= scale;
    return estimateRoad(state, 'edge_001', parameters, 6).effective_travel_time_min;
  };
  assert.ok(travel(0.9) > travel(1.1));
});

test('DR31 slower event release leaves more people attending after one interval', () => {
  const base = createSimulator({ seed: 42 }).getState();
  const remain = scale => {
    const state = structuredClone(base);
    state.events['show-1'].phase = 'RELEASING';
    state.events['show-1'].attending_count = 40;
    state.events['show-1'].admitted_total = 40;
    advanceEventService(state, 5, { event_release_rate: 4 * scale,
      event_admission_rate: 4 });
    return state.events['show-1'].attending_count;
  };
  assert.ok(remain(0.8) > remain(1.2));
});

test('scenario instance cannot double multiply a P0 variant or borrow a mismatched profile', () => {
  assert.throws(() => createSimulator({ seed: 42, scenario: 'P0_HIGH',
    scenarioInstance: sample() }), /P0_BASELINE/);
  const other = sample({}, 43);
  const profile = createVisitorProfile({ seed: 43, scenarioInstance: other });
  assert.throws(() => createSimulator({ seed: 42, scenarioInstance: sample(),
    visitorProfile: profile }), /different scenario instance/);
});

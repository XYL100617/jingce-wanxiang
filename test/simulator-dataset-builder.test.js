'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleScenario } = require('../server/simulator/scenario-sampler');
const { createSimulator } = require('../server/simulator/simulator');
const { createVisitorProfile } = require('../server/simulator/visitor-profile');
const { selectRolloutAction } = require('../server/simulator/rollout-policy');
const { generateDecisionDataset, generateEnvironmentRollout } = require('../server/simulator/dataset-builder');
const { validateDecisionDataset, validateEnvironmentRollout,
  HORIZONS } = require('../server/simulator/dataset-contract');
const { toMillis } = require('../server/planner/time');

const base = { crowd_level: 'LOW', calendar_type: 'WEEKDAY', weather: 'CLEAR',
  visitor_speed_distribution: 'NORMAL', dwell_distribution: 'NORMAL',
  road_condition: 'NORMAL', event_condition: 'NORMAL_EVENT', observation_quality: 'CLEAN' };
const scenarioInstances = [base,
  { ...base, crowd_level: 'MEDIUM', calendar_type: 'WEEKEND', weather: 'HOT',
    observation_quality: 'MISSING' },
  { ...base, crowd_level: 'HIGH', calendar_type: 'WEEKEND', weather: 'RAIN',
    road_condition: 'LOCAL_CLOSURE', event_condition: 'EVENT_DELAY',
    observation_quality: 'NOISY' }]
  .map((dimensions, index) => sampleScenario({ seed: 42, index: index + 1, dimensions }));
const visitorProfiles = [
  { preference_weights: { culture: 1.5, scenery: 0.5, show: 0.5, view: 0.5 },
    plan_acceptance_rate: 0.6, deviation_rate: 0.3, early_exit_base: 0.05 },
  { initial_fatigue: 0.7,
    preference_weights: { culture: 0.5, scenery: 1.5, show: 1.5, view: 1.5 },
    plan_acceptance_rate: 0.7, deviation_rate: 0.3, early_exit_base: 0.15 }
];
const decisionOptions = { scenarioInstances, visitorProfiles, seeds: [42, 43],
  episodes_per_scenario: 2, max_decisions: 4 };
const environmentOptions = { scenarioInstances, seeds: [42, 43], steps: 12 };
const decisions = generateDecisionDataset(decisionOptions);
const environment = generateEnvironmentRollout(environmentOptions);

test('DS1 two explicit in-memory dataset contracts validate', () => {
  assert.equal(validateDecisionDataset(decisions), true);
  assert.equal(validateEnvironmentRollout(environment), true);
  assert.equal(decisions.dataset_type, 'DECISION_TRANSITION');
  assert.equal(environment.dataset_type, 'FIXED_5_MIN_ENVIRONMENT');
});
test('DS2 decision input, target, audit and metadata are separate', () => {
  const sample = decisions.samples[0];
  assert.deepEqual(Object.keys(sample).sort(), ['input', 'target', 'audit', 'metadata'].sort());
  assert.ok(sample.input.legal_actions.some(item =>
    JSON.stringify(item.action) === JSON.stringify(sample.input.chosen_action)));
  assert.equal(sample.input.latent_target, undefined);
  assert.equal(sample.input.reward, undefined);
  assert.ok(sample.audit.transition_audit && sample.target.reward);
  assert.equal(sample.metadata.source_tier, 'T4');
  assert.equal(sample.metadata.synthetic, true);
});
test('DS3 small decision batch records all action counts and policy effects', () => {
  assert.equal(decisions.stats.episode_count, 12);
  assert.equal(decisions.stats.sample_count, decisions.samples.length);
  assert.deepEqual(Object.keys(decisions.stats.action_counts).sort(),
    ['VISIT_POI', 'ATTEND_EVENT', 'REST', 'WAIT', 'EXIT'].sort());
  assert.ok(decisions.stats.action_counts.VISIT_POI > 0);
  assert.ok(decisions.stats.action_counts.ATTEND_EVENT > 0);
  assert.ok(decisions.stats.action_counts.REST > 0);
  assert.ok(decisions.stats.action_counts.EXIT > 0);
  assert.ok(decisions.stats.plan_accepted > 0);
  assert.ok(decisions.stats.deviation_occurred > 0);
  assert.ok(decisions.stats.early_exit_occurred > 0);
  assert.ok(decisions.stats.reward_min <= decisions.stats.reward_max);
});
test('DS4 each generated Episode ends through a real terminal action', () => {
  assert.ok(decisions.episode_summaries.every(item => item.done
    && ['EXITED', 'TIME_EXHAUSTED'].includes(item.termination_reason)));
  for (const summary of decisions.episode_summaries) {
    const last = decisions.samples.filter(sample => sample.metadata.episode_id === summary.episode_id).at(-1);
    assert.ok(last.target.done);
    assert.equal(last.target.termination_reason, summary.termination_reason);
  }
});
test('DS5 reward and invariant evidence come only from terminal simulation', () => {
  for (const sample of decisions.samples) {
    assert.equal(sample.audit.invariant_summary.population, 'PASS');
    assert.equal(sample.audit.invariant_summary.road_occupancy, 'PASS');
    assert.equal(sample.target.reward.raw_metrics.outcome,
      sample.audit.transition_audit.outcome);
  }
});
test('DS6 fixed rollout keeps five-minute inputs independent of action duration', () => {
  assert.equal(environment.step_min, 5);
  assert.equal(environment.stats.sample_count, 72);
  assert.equal(environment.samples[0].observed_input.delta_t_min, undefined);
  const sameTrajectory = environment.samples.filter(sample => sample.metadata.trajectory_id
    === environment.samples[0].metadata.trajectory_id);
  for (let index = 1; index < sameTrajectory.length; index += 1)
    assert.equal(toMillis(sameTrajectory[index].latent_current.environment_state.timestamp)
      - toMillis(sameTrajectory[index - 1].latent_current.environment_state.timestamp), 5 * 60000);
});
test('DS7 5/15/30/60 targets point to correct future steps', () => {
  const first = environment.samples[0];
  for (const [key, offset] of Object.entries(HORIZONS)) {
    assert.equal(first.future_target[key].step_index, offset);
    assert.equal(toMillis(first.future_target[key].environment.timestamp)
      - toMillis(first.latent_current.environment_state.timestamp), offset * 5 * 60000);
  }
  assert.deepEqual(environment.stats.valid_targets,
    { target_5: 72, target_15: 60, target_30: 42, target_60: 6 });
});
test('DS8 tail samples mark unavailable future instead of fabricating it', () => {
  const tail = environment.samples.find(sample => sample.metadata.step_index === 11);
  assert.equal(tail.future_target.target_60, null);
  assert.equal(tail.target_available.target_60, false);
  assert.ok(tail.future_target.target_5);
});
test('DS9 validators reject leakage, invalid actions, NaN, negative queues and bad time', () => {
  const corruptDecision = mutation => {
    const copy = structuredClone(decisions); mutation(copy.samples[0]);
    assert.throws(() => validateDecisionDataset(copy), /INVALID_DATASET/);
  };
  corruptDecision(row => { row.input.latent_target = {}; });
  corruptDecision(row => { row.input.observation.reward = 1; });
  corruptDecision(row => { row.input.chosen_action.target_id = 'unknown'; });
  corruptDecision(row => { row.target.reward.total = NaN; });
  corruptDecision(row => { row.target.latent_target.pois.market.queue_count = -1; });
  corruptDecision(row => { row.input.delta_t_min = 999; });
  const corruptEnvironment = mutation => {
    const copy = structuredClone(environment); mutation(copy.samples[0]);
    assert.throws(() => validateEnvironmentRollout(copy), /INVALID_DATASET/);
  };
  corruptEnvironment(row => { row.latent_current.environment_state.roads.edge_001.occupancy += 1; });
  corruptEnvironment(row => { row.future_target.target_15.step_index = 99; });
  corruptEnvironment(row => { row.future_target.target_5.environment.pois.market.queue_count += 1; });
  corruptEnvironment(row => { row.latent_current.environment_state.population.park_population += 1; });
});
test('DS10 same seed, scenario and profile specs replay identically', () => {
  assert.deepEqual(generateDecisionDataset(decisionOptions), decisions);
  assert.deepEqual(generateEnvironmentRollout(environmentOptions), environment);
});
test('DS11 crowd, weather and closure scenarios have different trajectories', () => {
  const first = environment.samples.filter(sample => sample.metadata.seed === 42
    && sample.metadata.step_index === 0);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map(sample => sample.latent_current.environment_state.weather.category),
    ['CLEAR', 'HOT', 'RAIN']);
  assert.ok(first[0].latent_current.environment_state.roads.edge_001.travel_time_min
    < first[2].latent_current.environment_state.roads.edge_001.travel_time_min);
  const atFive = environment.samples.filter(sample => sample.metadata.seed === 42
    && sample.metadata.step_index === 5);
  assert.notEqual(atFive[0].latent_current.environment_state.population.arrivals_total,
    atFive[2].latent_current.environment_state.population.arrivals_total);
  const summaries = environment.trajectory_summaries.filter(row => row.seed === 42);
  assert.ok(summaries[0].arrival_scale < summaries[1].arrival_scale
    && summaries[1].arrival_scale < summaries[2].arrival_scale);
  assert.ok(summaries[0].arrivals_total < summaries[2].arrivals_total);
  assert.equal(summaries[2].closure_observed, true);
  assert.ok(summaries[2].closure_edge_id);
});
test('DS12 rollout preference can change a choice among real legal actions', () => {
  const sim = createSimulator({ seed: 42, scenarioInstance: scenarioInstances[0] });
  const legalActions = sim.getLegalActions().legal;
  const nodeTypes = Object.fromEntries(sim.getGraph().nodes.map(node => [node.node_id, node.type]));
  const recommendedAction = legalActions.find(item => item.action.action_type === 'VISIT_POI').action;
  const visitorState = sim.getState().visitor;
  const common = { legalActions, recommendedAction, observation: sim.getObservation(),
    visitorState, nodeTypes, seed: 42 };
  const culture = createVisitorProfile({ seed: 42, overrides: {
    preference_weights: { culture: 1.5, scenery: 0.5, show: 0.5, view: 0.5 },
    plan_acceptance_rate: 0.5, early_exit_base: 0.02 } });
  const scenery = createVisitorProfile({ seed: 42, overrides: {
    preference_weights: { culture: 0.5, scenery: 1.5, show: 0.5, view: 1.5 },
    plan_acceptance_rate: 0.5, early_exit_base: 0.02 } });
  const differences = Array.from({ length: 40 }, (_, decisionIndex) => {
    const a = selectRolloutAction({ ...common, profile: culture, decisionIndex });
    const b = selectRolloutAction({ ...common, profile: scenery, decisionIndex });
    return a.chosen_action.target_id !== b.chosen_action.target_id
      && a.chosen_action.action_type !== 'EXIT' && b.chosen_action.action_type !== 'EXIT';
  });
  assert.ok(differences.some(Boolean));
});
test('DS13 acceptance, deviation and early-exit inputs change policy outcomes', () => {
  const sim = createSimulator({ seed: 42, scenarioInstance: scenarioInstances[0] });
  const legalActions = sim.getLegalActions().legal;
  const nodeTypes = Object.fromEntries(sim.getGraph().nodes.map(node => [node.node_id, node.type]));
  const common = { legalActions,
    recommendedAction: legalActions.find(item => item.action.action_type === 'VISIT_POI').action,
    observation: sim.getObservation(), visitorState: sim.getState().visitor,
    nodeTypes, seed: 42 };
  const profile = overrides => createVisitorProfile({ seed: 42, overrides });
  const choices = (overrides, state = common.visitorState) => Array.from({ length: 60 },
    (_, decisionIndex) => selectRolloutAction({ ...common, visitorState: state,
      profile: profile(overrides), decisionIndex }));
  const accepted = choices({ plan_acceptance_rate: 0.95, early_exit_base: 0.02 });
  const rejected = choices({ plan_acceptance_rate: 0.5, early_exit_base: 0.02 });
  assert.ok(accepted.some((item, i) => item.policy_audit.plan_accepted
    && rejected[i].policy_audit.chosen_reason === 'PLAN_REJECTED'));
  const steady = choices({ plan_acceptance_rate: 0.95, deviation_rate: 0.02,
    early_exit_base: 0.02 });
  const deviating = choices({ plan_acceptance_rate: 0.95, deviation_rate: 0.3,
    early_exit_base: 0.02 });
  assert.ok(steady.some((item, i) => !item.policy_audit.deviation_occurred
    && deviating[i].policy_audit.deviation_occurred));
  const highPressure = { ...common.visitorState, fatigue: 0.9, remaining_time_min: 30 };
  const lowExit = choices({ early_exit_base: 0.02 });
  const highExit = choices({ early_exit_base: 0.15 }, highPressure);
  assert.ok(lowExit.some((item, i) => !item.policy_audit.early_exit_occurred
    && highExit[i].policy_audit.early_exit_occurred));
});
test('DS14 review batch guard blocks bulk generation', () => {
  assert.throws(() => generateDecisionDataset({ ...decisionOptions,
    episodes_per_scenario: 20 }), /small review batch/);
  assert.throws(() => generateEnvironmentRollout({ ...environmentOptions,
    steps: 1000 }), /small/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleScenario } = require('../server/simulator/scenario-sampler');
const { generateDecisionDataset, generateEnvironmentRollout } = require('../server/simulator/dataset-builder');
const { projectDecisionRoles, projectEnvironmentRoles } = require('../server/simulator/dataset-contract');
const { validateDatasetBatch } = require('../server/simulator/dataset-validator');
const { createVisitorProfile, earlyExitPropensity,
  VISITOR_PROFILE_VERSION } = require('../server/simulator/visitor-profile');

const base = { crowd_level: 'LOW', calendar_type: 'WEEKDAY', weather: 'CLEAR',
  visitor_speed_distribution: 'NORMAL', dwell_distribution: 'NORMAL',
  road_condition: 'NORMAL', event_condition: 'NORMAL_EVENT', observation_quality: 'CLEAN' };
const dimensions = [base,
  { ...base, crowd_level: 'MEDIUM', weather: 'HOT', observation_quality: 'NOISY' },
  { ...base, crowd_level: 'HIGH', calendar_type: 'WEEKEND', weather: 'RAIN',
    road_condition: 'LOCAL_CLOSURE', event_condition: 'EVENT_DELAY',
    observation_quality: 'MIXED' }];
const scenarioInstances = dimensions.map((item, index) =>
  sampleScenario({ seed: 42, index: index + 1, dimensions: item }));
const options = { scenarioInstances, seeds: [42, 43] };
const visitorProfiles = [
  { preference_weights: { culture: 1.5, scenery: 0.5, show: 0.5, view: 0.5 },
    plan_acceptance_rate: 0.8, deviation_rate: 0.2, early_exit_base: 0.03 },
  { initial_fatigue: 0.7,
    preference_weights: { culture: 0.5, scenery: 1.5, show: 1.5, view: 1.5 },
    plan_acceptance_rate: 0.7, deviation_rate: 0.3, early_exit_base: 0.1 }
];
const decisions = generateDecisionDataset({ ...options, visitorProfiles,
  episodes_per_scenario: 2, max_decisions: 8 });
const environment = generateEnvironmentRollout({ ...options, steps: 18 });
const report = validateDatasetBatch({ decisionDataset: decisions, environmentDataset: environment });

test('DV1 distribution report counts episodes and visitor profile categories', () => {
  assert.equal(report.valid, true);
  assert.equal(report.episode_statistics.count, 12);
  assert.equal(Object.values(report.profile_coverage.speed).reduce((a, b) => a + b, 0), 12);
  assert.equal(Object.values(report.profile_coverage.dwell).reduce((a, b) => a + b, 0), 12);
  assert.equal(Object.values(report.profile_coverage.preference).reduce((a, b) => a + b, 0), 12);
});
test('DV2 scenario coverage counts unique episodes and rollouts, not steps', () => {
  assert.deepEqual(report.scenario_coverage.crowd_level.LOW, { episodes: 4, rollouts: 2 });
  assert.deepEqual(report.scenario_coverage.weather.HOT, { episodes: 4, rollouts: 2 });
  assert.deepEqual(report.scenario_coverage.road_condition.LOCAL_CLOSURE,
    { episodes: 4, rollouts: 2 });
});
test('DV3 behavior coverage matches audited actions and outcomes', () => {
  const counts = report.behavior_coverage.action_counts;
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), decisions.samples.length);
  assert.equal(report.behavior_coverage.plan_rejected, decisions.samples.filter(row =>
    row.audit.policy_audit.chosen_reason === 'PLAN_REJECTED').length);
  assert.equal(report.behavior_coverage.event_missed, decisions.samples.filter(row =>
    row.audit.transition_audit.missed_event?.kind === 'EVENT_MISSED').length);
});
test('DV4 early exit counts unique episodes and uses policy audit', () => {
  const count = decisions.episode_summaries.filter(item => item.early_exit).length;
  assert.equal(report.episode_statistics.early_exit_count, count);
  assert.equal(report.episode_statistics.early_exit_rate,
    Math.round(count / decisions.episode_summaries.length * 1e6) / 1e6);
});
test('DV5 WAIT count comes only from legal executed WAIT', () => {
  const wait = decisions.samples.filter(row => row.input.chosen_action.action_type === 'WAIT');
  assert.equal(report.behavior_coverage.action_counts.WAIT, wait.length);
  assert.ok(wait.every(row => row.input.legal_actions.some(item =>
    item.action.action_type === 'WAIT')));
});
test('DV6 reward ranges and contract violations are reported', () => {
  const values = decisions.samples.map(row => row.target.reward.total);
  assert.equal(report.reward_statistics.total.min, Math.min(...values));
  assert.equal(report.reward_statistics.total.max, Math.max(...values));
  assert.equal(report.reward_statistics.outside_contract_count, 0);
});
test('DV7 horizon coverage uses real available targets', () => {
  assert.equal(report.horizon_coverage.target_5.count, 108);
  assert.equal(report.horizon_coverage.target_15.count, 96);
  assert.equal(report.horizon_coverage.target_30.count, 78);
  assert.equal(report.horizon_coverage.target_60.count, 42);
  assert.equal(report.horizon_coverage.target_60.coverage_rate, 0.388889);
});
test('DV8 observed deployment input is separate from current latent state', () => {
  const roles = projectEnvironmentRoles(environment.samples[0]);
  assert.deepEqual(Object.keys(roles.OBSERVED_INPUT), ['observation']);
  assert.ok(roles.LATENT_CURRENT.environment_state.population);
  assert.equal(roles.OBSERVED_INPUT.environment_state, undefined);
  assert.equal(report.role_checks.observed_input_excludes_latent, true);
});
test('DV9 policy input excludes chosen action and actual delta_t_min', () => {
  const roles = projectDecisionRoles(decisions.samples[0]);
  assert.deepEqual(Object.keys(roles.POLICY_INPUT),
    ['observation', 'visitor_state', 'legal_actions']);
  assert.ok(roles.ACTION_LABEL.chosen_action);
  assert.ok(roles.TRANSITION_MODEL_INPUT.delta_t_min > 0);
  assert.equal(roles.POLICY_INPUT.delta_t_min, undefined);
  assert.equal(report.role_checks.policy_input_excludes_action_and_delta_t, true);
});
test('DV10 same seed gives the same validation report', () => {
  const replayDecision = generateDecisionDataset({ ...options, visitorProfiles,
    episodes_per_scenario: 2, max_decisions: 8 });
  const replayEnvironment = generateEnvironmentRollout({ ...options, steps: 18 });
  assert.deepEqual(validateDatasetBatch({ decisionDataset: replayDecision,
    environmentDataset: replayEnvironment }), report);
});
test('DV11 invalid samples return explicit errors', () => {
  const bad = structuredClone(environment);
  bad.samples[0].observed_input.observation.reward = 2;
  const invalid = validateDatasetBatch({ decisionDataset: decisions, environmentDataset: bad });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0].message, /INVALID_DATASET/);
});
test('DV12 validator does not mutate either dataset', () => {
  const beforeDecision = structuredClone(decisions);
  const beforeEnvironment = structuredClone(environment);
  validateDatasetBatch({ decisionDataset: decisions, environmentDataset: environment });
  assert.deepEqual(decisions, beforeDecision);
  assert.deepEqual(environment, beforeEnvironment);
});
test('DV13 calibrated T4 exit terms remain monotone and versioned', () => {
  assert.equal(VISITOR_PROFILE_VERSION, 'visitor-p1.2');
  const profile = createVisitorProfile({ seed: 42 });
  const context = { fatigue: 0.2, remaining_time_min: 240,
    weather: 'CLEAR', completed_visit_count: 0 };
  const baseline = earlyExitPropensity(profile, context);
  assert.ok(earlyExitPropensity(profile, { ...context, fatigue: 0.8 }) > baseline);
  assert.ok(earlyExitPropensity(profile, { ...context, remaining_time_min: 30 }) > baseline);
  assert.ok(earlyExitPropensity(profile, { ...context, weather: 'RAIN' }) > baseline);
  assert.ok(earlyExitPropensity(profile, { ...context, completed_visit_count: 3 }) > baseline);
});

'use strict';

const { HORIZONS, validateDecisionDataset, validateEnvironmentRollout,
  projectDecisionRoles, projectEnvironmentRoles } = require('./dataset-contract');

const SCENARIO_CHOICES = Object.freeze({
  crowd_level: ['LOW', 'MEDIUM', 'HIGH'],
  calendar_type: ['WEEKDAY', 'WEEKEND'],
  weather: ['CLEAR', 'RAIN', 'HOT'],
  road_condition: ['NORMAL', 'LOCAL_CLOSURE'],
  event_condition: ['NORMAL_EVENT', 'EVENT_DELAY'],
  observation_quality: ['CLEAN', 'NOISY', 'MISSING', 'DELAYED', 'MIXED']
});
const ACTIONS = ['VISIT_POI', 'ATTEND_EVENT', 'REST', 'WAIT', 'EXIT'];
const mean = values => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const round = value => value === null ? null : Math.round(value * 1e6) / 1e6;
const range = values => ({ min: values.length ? Math.min(...values) : null,
  max: values.length ? Math.max(...values) : null, mean: round(mean(values)) });
const countBy = (items, key) => items.reduce((result, item) => {
  result[key(item)] = (result[key(item)] || 0) + 1;
  return result;
}, {});
const category = value => value < 0.9 ? 'slower' : value > 1.1 ? 'faster' : 'normal';
const dwellCategory = value => value < 0.9 ? 'short' : value > 1.1 ? 'long' : 'normal';
const preferenceCategory = weights => {
  const maximum = Math.max(...Object.values(weights));
  const leaders = Object.keys(weights).filter(key => weights[key] === maximum);
  return leaders.length === 1 ? leaders[0] : 'TIED';
};

function validateDatasetBatch({ decisionDataset, environmentDataset }) {
  const errors = [];
  for (const [name, data, validate] of [
    ['decision', decisionDataset, validateDecisionDataset],
    ['environment', environmentDataset, validateEnvironmentRollout]
  ]) {
    try { validate(data); } catch (error) { errors.push({ dataset: name, message: error.message }); }
  }
  if (errors.length) return { report_version: 'dataset-validation-p1.1',
    source_tier: 'T4', synthetic: true, valid: false, errors };

  const decisions = decisionDataset.samples;
  const environments = environmentDataset.samples;
  const firstDecisionByEpisode = new Map();
  for (const row of decisions) if (!firstDecisionByEpisode.has(row.metadata.episode_id))
    firstDecisionByEpisode.set(row.metadata.episode_id, row);
  const firstEnvironmentByTrajectory = new Map();
  for (const row of environments) if (!firstEnvironmentByTrajectory.has(row.metadata.trajectory_id))
    firstEnvironmentByTrajectory.set(row.metadata.trajectory_id, row);
  const episodeRows = [...firstDecisionByEpisode.values()];
  const rolloutRows = [...firstEnvironmentByTrajectory.values()];
  const scenario_coverage = Object.fromEntries(Object.entries(SCENARIO_CHOICES)
    .map(([dimension, choices]) => [dimension, Object.fromEntries(choices.map(choice => [choice, {
      episodes: episodeRows.filter(row => row.metadata.scenario_dimensions?.[dimension] === choice).length,
      rollouts: rolloutRows.filter(row => row.metadata.scenario_dimensions?.[dimension] === choice).length
    }]))]));
  const profile_coverage = {
    speed: countBy(episodeRows, row => category(row.metadata.visitor_profile.walking_speed_factor)),
    dwell: countBy(episodeRows, row => dwellCategory(row.metadata.visitor_profile.dwell_time_factor)),
    preference: countBy(episodeRows,
      row => preferenceCategory(row.metadata.visitor_profile.preference_weights))
  };
  const reasons = decisions.map(row => row.audit.policy_audit.chosen_reason);
  const behavior_coverage = {
    action_counts: Object.fromEntries(ACTIONS.map(action =>
      [action, decisions.filter(row => row.input.chosen_action.action_type === action).length])),
    plan_accepted: reasons.filter(reason => reason === 'PLAN_ACCEPTED').length,
    plan_rejected: reasons.filter(reason => reason === 'PLAN_REJECTED').length,
    deviation: reasons.filter(reason => reason === 'PLAN_DEVIATION').length,
    early_exit: reasons.filter(reason => reason === 'EARLY_EXIT').length,
    event_missed: decisions.filter(row => row.audit.transition_audit.missed_event?.kind === 'EVENT_MISSED').length
  };
  const summaries = decisionDataset.episode_summaries;
  const earlyExitCount = summaries.filter(row => row.early_exit).length;
  const episode_statistics = {
    count: summaries.length,
    step_count: range(summaries.map(row => row.step_count)),
    duration_min: range(summaries.map(row => row.duration_min)),
    poi_completed: range(summaries.map(row => row.poi_completed)),
    event_completed: range(summaries.map(row => row.event_completed)),
    early_exit_count: earlyExitCount,
    early_exit_rate: round(summaries.length ? earlyExitCount / summaries.length : 0),
    termination_reason: countBy(summaries, row => row.termination_reason)
  };
  const rewards = decisions.map(row => row.target.reward);
  const components = [...new Set(rewards.flatMap(reward => Object.keys(reward.components)))];
  const reward_statistics = {
    total: range(rewards.map(reward => reward.total)),
    outside_contract_count: rewards.filter(reward => reward.total < reward.total_bounds.min
      || reward.total > reward.total_bounds.max).length,
    components: Object.fromEntries(components.map(name => {
      const values = rewards.map(reward => reward.components[name]).filter(value => value !== null);
      const penalty = name.endsWith('_penalty');
      return [name, { ...range(values), count: values.length,
        outside_contract_count: values.filter(value => penalty ? value < -1 || value > 0
          : value < 0 || value > 1).length }];
    }))
  };
  const horizon_coverage = Object.fromEntries(Object.keys(HORIZONS).map(key => {
    const valid = environments.filter(row => row.target_available[key]).length;
    return [key, { count: valid, total: environments.length,
      coverage_rate: round(environments.length ? valid / environments.length : 0) }];
  }));
  const role_checks = {
    observed_input_excludes_latent: environments.every(row => {
      const roles = projectEnvironmentRoles(row);
      return Object.keys(roles.OBSERVED_INPUT).join(',') === 'observation'
        && !Object.hasOwn(roles.OBSERVED_INPUT, 'environment_state');
    }),
    policy_input_excludes_action_and_delta_t: decisions.every(row => {
      const roles = projectDecisionRoles(row);
      return Object.keys(roles.POLICY_INPUT).sort().join(',')
        === ['observation', 'visitor_state', 'legal_actions'].sort().join(',')
        && !Object.hasOwn(roles.POLICY_INPUT, 'delta_t_min');
    })
  };
  const warnings = [];
  for (const [dimension, choices] of Object.entries(scenario_coverage))
    for (const [choice, counts] of Object.entries(choices))
      if (!counts.episodes || !counts.rollouts) warnings.push(`SCENARIO_COVERAGE:${dimension}:${choice}`);
  if (!behavior_coverage.action_counts.WAIT) warnings.push('WAIT_NOT_OBSERVED');
  if (episode_statistics.early_exit_rate > 0.75) warnings.push('EARLY_EXIT_DOMINANT');
  if (horizon_coverage.target_60.coverage_rate < 0.5) warnings.push('LOW_60MIN_COVERAGE');
  if (reward_statistics.outside_contract_count
    || Object.values(reward_statistics.components).some(item => item.outside_contract_count))
    errors.push({ dataset: 'reward', message: 'reward outside contract' });
  if (!Object.values(role_checks).every(Boolean))
    errors.push({ dataset: 'roles', message: 'observed or policy input leakage' });
  return { report_version: 'dataset-validation-p1.1', source_tier: 'T4', synthetic: true,
    valid: errors.length === 0, errors, warnings, scenario_coverage, profile_coverage,
    behavior_coverage, episode_statistics, reward_statistics, horizon_coverage,
    role_checks, sample_counts: { decisions: decisions.length, environments: environments.length } };
}

module.exports = { validateDatasetBatch, SCENARIO_CHOICES };

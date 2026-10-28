'use strict';

const { SeededRNG } = require('./seeded-rng');
const { validateScenarioInstance } = require('./scenario-sampler');

const VISITOR_PROFILE_VERSION = 'visitor-p1.2';
// T4/ASSUMPTION calibration: reduce compounding exit pressure observed in
// validation episodes; keep fatigue, time, weather and completed visits active.
const EARLY_EXIT_CONTRIBUTIONS = Object.freeze({ fatigue: 0.12,
  remaining_time: 0.12, adverse_weather: 0.04, completed_visit: 0.01 });
const PROFILE_BOUNDS = Object.freeze({
  walking_speed_factor: [0.7, 1.3], dwell_time_factor: [0.7, 1.3],
  preference_weight: [0.5, 1.5], plan_acceptance_rate: [0.5, 0.95],
  deviation_rate: [0.02, 0.3], early_exit_base: [0.02, 0.15]
});
const PREFERENCE_TYPES = Object.freeze(['scenery', 'culture', 'show', 'view']);
const provenance = (name, range) => ({ parameter_name: name, distribution_type: 'UNIFORM',
  min: range[0], max: range[1], source_tier: 'T4', basis: 'ASSUMPTION',
  version: VISITOR_PROFILE_VERSION });
const round = n => Math.round(n * 1e6) / 1e6;
const profileId = (seed, index, scenarioId) => `visitor_seed${seed}_${String(index).padStart(6, '0')}`
  + (scenarioId ? `_${scenarioId.split('_').at(-1)}` : '');

function validateVisitorProfile(profile) {
  if (!profile || profile.profile_version !== VISITOR_PROFILE_VERSION
    || profile.source_tier !== 'T4' || profile.parameter_basis !== 'ASSUMPTION'
    || !Number.isInteger(profile.seed) || profile.seed < 0 || profile.seed > 0xffffffff
    || !Number.isInteger(profile.profile_index) || profile.profile_index < 0
    || profile.profile_id !== profileId(profile.seed, profile.profile_index,
      profile.scenario_instance_id)) {
    throw new TypeError('invalid T4 visitor profile provenance');
  }
  for (const key of ['walking_speed_factor', 'dwell_time_factor', 'plan_acceptance_rate',
    'deviation_rate', 'early_exit_base']) {
    const [min, max] = PROFILE_BOUNDS[key];
    if (!Number.isFinite(profile[key]) || profile[key] < min || profile[key] > max) {
      throw new RangeError(`visitor profile ${key} out of bounds`);
    }
  }
  if (!profile.preference_weights || Object.keys(profile.preference_weights).sort().join(',')
    !== [...PREFERENCE_TYPES].sort().join(',')) throw new TypeError('unknown preference type');
  for (const weight of Object.values(profile.preference_weights)) {
    if (!Number.isFinite(weight) || weight < PROFILE_BOUNDS.preference_weight[0]
      || weight > PROFILE_BOUNDS.preference_weight[1]) throw new RangeError('preference weight out of bounds');
  }
  for (const key of ['walking_speed_factor', 'dwell_time_factor', 'preference_weights',
    'plan_acceptance_rate', 'deviation_rate', 'early_exit_base']) {
    const meta = profile.parameter_provenance?.[key];
    if (!meta || meta.parameter_name !== key
      || !['UNIFORM', 'EXPLICIT_T4_OVERRIDE'].includes(meta.distribution_type)
      || meta.source_tier !== 'T4' || meta.basis !== 'ASSUMPTION'
      || meta.version !== VISITOR_PROFILE_VERSION
      || !Number.isFinite(meta.min) || !Number.isFinite(meta.max)
      || meta.min <= 0 || meta.max < meta.min) {
      throw new TypeError(`invalid visitor ${key} provenance`);
    }
  }
  return profile;
}

function createVisitorProfile({ seed = 42, profileIndex = 1, scenarioInstance = null,
  overrides = {} } = {}) {
  if (!Number.isInteger(profileIndex) || profileIndex < 0) throw new RangeError('invalid profileIndex');
  if (scenarioInstance) validateScenarioInstance(scenarioInstance);
  const rng = new SeededRNG((seed ^ Math.imul(profileIndex + 1, 0x85ebca6b) ^ 0x243f6a88) >>> 0);
  const speedRange = scenarioInstance?.sampled_parameters?.walking_speed_factor_range
    || PROFILE_BOUNDS.walking_speed_factor;
  const dwellRange = scenarioInstance?.sampled_parameters?.dwell_time_factor_range
    || PROFILE_BOUNDS.dwell_time_factor;
  const weights = Object.fromEntries(PREFERENCE_TYPES.map(type =>
    [type, round(rng.uniform(...PROFILE_BOUNDS.preference_weight))]));
  const profile = {
    profile_id: profileId(seed, profileIndex, scenarioInstance?.scenario_instance_id),
    profile_version: VISITOR_PROFILE_VERSION, seed, profile_index: profileIndex,
    scenario_instance_id: scenarioInstance?.scenario_instance_id ?? null,
    source_tier: 'T4', parameter_basis: 'ASSUMPTION',
    walking_speed_factor: round(rng.uniform(...speedRange)),
    dwell_time_factor: round(rng.uniform(...dwellRange)),
    preference_weights: weights,
    plan_acceptance_rate: round(rng.uniform(...PROFILE_BOUNDS.plan_acceptance_rate)),
    deviation_rate: round(rng.uniform(...PROFILE_BOUNDS.deviation_rate)),
    early_exit_base: round(rng.uniform(...PROFILE_BOUNDS.early_exit_base)),
    parameter_provenance: {
      walking_speed_factor: provenance('walking_speed_factor', speedRange),
      dwell_time_factor: provenance('dwell_time_factor', dwellRange),
      preference_weights: provenance('preference_weights', PROFILE_BOUNDS.preference_weight),
      plan_acceptance_rate: provenance('plan_acceptance_rate', PROFILE_BOUNDS.plan_acceptance_rate),
      deviation_rate: provenance('deviation_rate', PROFILE_BOUNDS.deviation_rate),
      early_exit_base: provenance('early_exit_base', PROFILE_BOUNDS.early_exit_base)
    }
  };
  if (overrides.preference_weights) {
    profile.preference_weights = { ...weights, ...overrides.preference_weights };
    profile.parameter_provenance.preference_weights = {
      ...profile.parameter_provenance.preference_weights,
      distribution_type: 'EXPLICIT_T4_OVERRIDE',
      min: Math.min(...Object.values(profile.preference_weights)),
      max: Math.max(...Object.values(profile.preference_weights)) };
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'preference_weights') {
      if (!Object.hasOwn(PROFILE_BOUNDS, key)) throw new RangeError(`unknown visitor override: ${key}`);
      profile[key] = value;
      profile.parameter_provenance[key] = { ...profile.parameter_provenance[key],
        distribution_type: 'EXPLICIT_T4_OVERRIDE', min: value, max: value };
    }
  }
  return validateVisitorProfile(profile);
}

function decisionDraw(profile, decisionIndex, salt) {
  validateVisitorProfile(profile);
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0) throw new RangeError('decisionIndex');
  return new SeededRNG((profile.seed ^ Math.imul(profile.profile_index + 1, 0x9e3779b9)
    ^ Math.imul(decisionIndex + 1, 0x85ebca6b) ^ salt) >>> 0).next();
}

function samplePlanAcceptance(profile, decisionIndex = 0) {
  const draw = decisionDraw(profile, decisionIndex, 0x13a1);
  return { accepted: draw < profile.plan_acceptance_rate, draw,
    probability: profile.plan_acceptance_rate };
}

function sampleDeviation(profile, decisionIndex = 0) {
  const draw = decisionDraw(profile, decisionIndex, 0x21b2);
  return { deviate_at_next_decision: draw < profile.deviation_rate, draw,
    probability: profile.deviation_rate };
}

function earlyExitPropensity(profile, { fatigue, remaining_time_min, weather,
  completed_visit_count = 0 }) {
  validateVisitorProfile(profile);
  if (!Number.isFinite(fatigue) || fatigue < 0 || fatigue > 1
    || !Number.isFinite(remaining_time_min) || remaining_time_min < 0
    || !Number.isInteger(completed_visit_count) || completed_visit_count < 0) {
    throw new RangeError('invalid current early-exit state');
  }
  const label = String(weather?.category || weather?.label || weather || '').toUpperCase();
  const adverseWeather = label === 'RAIN' || label === 'HOT' || label.includes('雨') || label.includes('高温');
  return round(Math.min(1, profile.early_exit_base
    + EARLY_EXIT_CONTRIBUTIONS.fatigue * fatigue
    + EARLY_EXIT_CONTRIBUTIONS.remaining_time
      * (1 - Math.min(remaining_time_min, 240) / 240)
    + (adverseWeather ? EARLY_EXIT_CONTRIBUTIONS.adverse_weather : 0)
    + Math.min(completed_visit_count, 5) * EARLY_EXIT_CONTRIBUTIONS.completed_visit));
}

module.exports = { VISITOR_PROFILE_VERSION, PROFILE_BOUNDS, PREFERENCE_TYPES,
  EARLY_EXIT_CONTRIBUTIONS,
  createVisitorProfile, validateVisitorProfile, samplePlanAcceptance,
  sampleDeviation, earlyExitPropensity };

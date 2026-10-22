'use strict';

const DEFAULT_RULES = Object.freeze({
  beam_width: 6,
  max_actions: 4,
  min_actions: 2,
  wait_duration_min: 10,
  return_buffer_min: 5,
  max_walk_per_leg_min: 30,
  max_queue_min: 45,
  fatigue_walk_per_min: 0.008,
  fatigue_queue_per_min: 0.004,
  fatigue_rest_recovery_per_min: 0.012,
  score: Object.freeze({
    preference_reward: 34,
    walk_cost_per_min: 0.35,
    queue_cost_per_min: 0.45,
    wait_cost_per_min: 0.25,
    fatigue_cost: 12,
    late_risk_cost: 8,
    route_switch_cost: 3,
    early_exit_cost: 18
  })
});

function mergeRules(overrides = {}) {
  return {
    ...DEFAULT_RULES,
    ...overrides,
    score: { ...DEFAULT_RULES.score, ...(overrides.score || {}) }
  };
}

module.exports = { DEFAULT_RULES, mergeRules };

'use strict';

const DEFAULT_RULES = Object.freeze({
  beam_width: 2,
  // Limit branching after ranking all POIs by Map1 access and arrival-time conditions.
  planner_candidate_limit: 6,
  // Covers a full-day sequence rather than the original three-POI demo.
  // Legal-time checks still stop actions that do not fit before departure.
  max_actions: 18,
  min_actions: 2,
  wait_duration_min: 10,
  max_event_wait_min: 20,
  return_buffer_min: 5,
  max_walk_per_leg_min: 30,
  max_queue_min: 45,
  fatigue_walk_per_min: 0.008,
  fatigue_queue_per_min: 0.004,
  fatigue_rest_recovery_per_min: 0.012,
  score: Object.freeze({
    preference_reward: 34,
    // A full-day route must not gain score by zig-zagging across the park just
    // to add one more attractive POI. This uses the shared A/C spatial frame.
    walk_cost_per_min: 1.2,
    // Start close to the selected entrance when preferences are otherwise
    // comparable; later legs keep the normal full-day continuity penalty.
    first_leg_walk_cost_per_min: 2.5,
    queue_cost_per_min: 0.45,
    crowd_cost_per_ratio: 12,
    crowd_trend_cost: 6,
    wait_cost_per_min: 0.25,
    fatigue_cost: 12,
    late_risk_cost: 8,
    route_switch_cost: 3,
    // Prefer a short nearby wait/rest buffer over ending a user-requested
    // full-day plan half an hour early.
    early_exit_cost: 80
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

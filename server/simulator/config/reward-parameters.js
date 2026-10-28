'use strict';

const REWARD_VERSION = 'reward-p1.1';
const PARAMETER_VERSION = 'reward-params-p1.1';

// Synthetic training-feedback choices. None is a measured satisfaction or operator objective.
const definitions = {
  efficiency_time_scale_min: { value: 60, unit: 'attributed travel + queue + wait minutes' },
  travel_penalty_scale_min: { value: 30, unit: 'attributed travel minutes' },
  queue_penalty_scale_min: { value: 30, unit: 'attributed queue minutes' },
  fatigue_delta_scale: { value: 0.3, unit: 'normalized decision-visitor fatigue increase' },
  weight_efficiency: { value: 0.15, unit: 'reward weight' },
  weight_experience: { value: 0.10, unit: 'reserved reward weight; no quality metric yet' },
  weight_safety: { value: 0.15, unit: 'reward weight' },
  weight_completion: { value: 0.25, unit: 'reward weight' },
  weight_completion_wait: { value: 0.05, unit: 'WAIT-specific completed-action weight; T4 anti-stalling baseline' },
  weight_travel_penalty: { value: 0.10, unit: 'reward weight' },
  weight_queue_penalty: { value: 0.10, unit: 'reward weight' },
  weight_fatigue_penalty: { value: 0.05, unit: 'reward weight' },
  weight_missed_event_penalty: { value: 0.10, unit: 'reward weight' }
};

const PARAMETERS = Object.freeze(Object.fromEntries(Object.entries(definitions)
  .map(([name, definition]) => [name, Object.freeze({ name, ...definition,
    source_tier: 'T4', parameter_basis: 'ASSUMPTION', version: PARAMETER_VERSION })])));

module.exports = { REWARD_VERSION, PARAMETER_VERSION, PARAMETERS };

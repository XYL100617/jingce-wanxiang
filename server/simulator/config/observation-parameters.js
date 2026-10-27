'use strict';

const VERSION = 'obs-p1d.1';

const definitions = {
  queue_noise_std: { value: 3, unit: 'visitors' },
  crowd_noise_std: { value: 0.05, unit: 'crowd ratio 0..1' },
  travel_time_noise_ratio: { value: 0.12, unit: 'fraction of DEMO travel time' },
  queue_missing_rate: { value: 0.25, unit: 'probability per POI capture' },
  travel_time_missing_rate: { value: 0.2, unit: 'probability per road capture' },
  observation_delay_min: { value: 5, unit: 'min for ordinary fields' },
  unknown_queue_fallback_min: { value: 30, unit: 'min; planner fallback only' },
  unknown_crowd_fallback_ratio: { value: 0.5, unit: 'ratio; planner fallback only' }
};

module.exports = {
  VERSION,
  PARAMETERS: Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, definition]) =>
    [name, Object.freeze({ name, ...definition, source_tier: 'T4', parameter_basis: 'ASSUMPTION', version: VERSION })])))
};

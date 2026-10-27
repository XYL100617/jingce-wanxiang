'use strict';

const scenarios = {
  P0_BASELINE: { description: 'Baseline synthetic flow', parameter_overrides: {} },
  P0_LOW: { description: 'Lower synthetic arrivals and queues', parameter_overrides: {
    arrival_multiplier: 'low_arrival_multiplier',
    departure_multiplier: 'low_departure_multiplier',
    queue_multiplier: 'low_queue_multiplier'
  } },
  P0_HIGH: { description: 'Higher synthetic arrivals and queues', parameter_overrides: {
    arrival_multiplier: 'high_arrival_multiplier',
    departure_multiplier: 'high_departure_multiplier',
    queue_multiplier: 'high_queue_multiplier'
  } }
};

module.exports = Object.freeze(Object.fromEntries(Object.entries(scenarios).map(([scenario_id, value]) => [scenario_id,
  Object.freeze({ scenario_id, ...value, parameter_overrides: Object.freeze(value.parameter_overrides), synthetic: true, source_tier: 'T4' })
])));

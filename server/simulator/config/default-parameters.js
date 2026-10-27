'use strict';

const VERSION = 'p1c.1';

// Every number below is a broad T4 engineering assumption, not measured park data.
const definitions = {
  simulation_step_min: { value: 5, unit: 'min' },
  initial_park_population: { range: [120, 280], unit: 'visitors' },
  arrival_rate: { range: [0.5, 2.5], unit: 'visitors/min' },
  departure_rate: { range: [0.3, 1.8], unit: 'visitors/min' },
  default_poi_capacity: { value: 80, unit: 'persons simultaneous inside POI' },
  default_service_rate: { range: [0.6, 1.4], unit: 'visitors/min' },
  default_admission_rate: { range: [1.2, 3.0], unit: 'visitors/min' },
  default_visit_duration_min: { value: 22, unit: 'min; DEMO other POI' },
  view_visit_duration_min: { value: 15, unit: 'min; DEMO view POI' },
  show_visit_duration_min: { value: 30, unit: 'min; DEMO show POI' },
  initial_queue_fraction: { value: 0.32, unit: 'fraction of initial park population' },
  initial_inside_fraction: { value: 0.18, unit: 'fraction of initial park population' },
  poi_arrival_fraction: { range: [0.04, 0.14], unit: 'fraction of walking pool per 5 min' },
  minimum_edge_travel_min: { value: 5, unit: 'min/edge; DEMO minimum' },
  travel_time_multiplier: { value: 1, unit: 'ratio; DEMO schematic edge time' },
  max_dispatch_groups_per_node: { value: 3, unit: 'aggregate cohorts/node/interval' },
  exit_intent_rate: { range: [0.03, 0.08], unit: 'fraction of eligible node walkers per 5 min' },
  visitor_speed_range: { range: [0.7, 1.5], unit: 'm/s' },
  queue_arrival_range: { range: [0, 0.45], unit: 'visitors/min/poi' },
  arrival_multiplier: { value: 1, unit: 'ratio' },
  departure_multiplier: { value: 1, unit: 'ratio' },
  queue_multiplier: { value: 1, unit: 'ratio' },
  low_arrival_multiplier: { value: 0.55, unit: 'ratio' },
  low_departure_multiplier: { value: 0.85, unit: 'ratio' },
  low_queue_multiplier: { value: 0.6, unit: 'ratio' },
  high_arrival_multiplier: { value: 1.65, unit: 'ratio' },
  high_departure_multiplier: { value: 1.15, unit: 'ratio' },
  high_queue_multiplier: { value: 1.6, unit: 'ratio' }
};

module.exports = {
  VERSION,
  PARAMETERS: Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, Object.freeze({
    name, ...definition, source_tier: 'T4', parameter_basis: 'ASSUMPTION', version: VERSION
  })])))
};

'use strict';

const VERSION = 'dr-p1.1';
const DIMENSIONS = Object.freeze({
  crowd_level: Object.freeze(['LOW', 'MEDIUM', 'HIGH']),
  calendar_type: Object.freeze(['WEEKDAY', 'WEEKEND']),
  weather: Object.freeze(['CLEAR', 'RAIN', 'HOT']),
  visitor_speed_distribution: Object.freeze(['SLOWER', 'NORMAL', 'FASTER', 'MIXED']),
  dwell_distribution: Object.freeze(['SHORT', 'NORMAL', 'LONG', 'MIXED']),
  road_condition: Object.freeze(['NORMAL', 'LOCAL_CLOSURE']),
  event_condition: Object.freeze(['NORMAL_EVENT', 'EVENT_DELAY']),
  observation_quality: Object.freeze(['CLEAN', 'NOISY', 'MISSING', 'DELAYED', 'MIXED'])
});
const CROWD_ARRIVAL = Object.freeze({ LOW: [0.5, 0.65], MEDIUM: [0.95, 1.05],
  HIGH: [1.5, 1.75] });
const CALENDAR_SCALE = Object.freeze({ WEEKDAY: [0.9, 1], WEEKEND: [1.1, 1.2] });
const SPEED_RANGES = Object.freeze({ SLOWER: [0.75, 0.9], NORMAL: [0.95, 1.05],
  FASTER: [1.1, 1.25], MIXED: [0.75, 1.25] });
const DWELL_RANGES = Object.freeze({ SHORT: [0.75, 0.9], NORMAL: [0.95, 1.05],
  LONG: [1.1, 1.25], MIXED: [0.75, 1.25] });
const NOISE_SCALE = Object.freeze([0.8, 1.2]);
const MISSING_SCALE = Object.freeze([0.8, 1.2]);
const POSITION_CONFIDENCE = Object.freeze([0.75, 0.95]);
const ROAD_START_MIN = Object.freeze([10, 15]);
const ROAD_DURATION_MIN = Object.freeze([10, 20]);
const EVENT_DELAY_MIN = Object.freeze([5, 10, 15]);
const OBSERVATION_DELAY_MIN = Object.freeze([5, 10]);
const CAPACITY_SERVICE_SCALE = Object.freeze({
  poi_capacity_scale: Object.freeze([0.9, 1.1]),
  poi_service_scale: Object.freeze([0.8, 1.2]),
  road_capacity_scale: Object.freeze([0.9, 1.1]),
  event_admission_scale: Object.freeze([0.9, 1.1]),
  event_release_scale: Object.freeze([0.8, 1.2])
});

module.exports = { VERSION, DIMENSIONS, CROWD_ARRIVAL, CALENDAR_SCALE,
  SPEED_RANGES, DWELL_RANGES, NOISE_SCALE, MISSING_SCALE, POSITION_CONFIDENCE,
  ROAD_START_MIN, ROAD_DURATION_MIN, EVENT_DELAY_MIN, OBSERVATION_DELAY_MIN,
  CAPACITY_SERVICE_SCALE };

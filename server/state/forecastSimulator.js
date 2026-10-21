const crypto = require('crypto');
const scenarios = require('../data/scenarios.json');
const { getScenicGraph } = require('./stateProvider');
const { parseTime, stamp } = require('./scenarioEngine');

const graph = getScenicGraph();
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const level = ratio => ratio >= .7 ? 'HIGH' : ratio >= .4 ? 'MEDIUM' : 'LOW';

function predictEnvironment(state, horizonMin = 60, stepMin = 10) {
  if (!Number.isInteger(horizonMin) || horizonMin < 0 || horizonMin > 1440) throw new RangeError('Invalid horizon');
  if (!Number.isInteger(stepMin) || stepMin < 1 || stepMin > 1440) throw new RangeError('Invalid step');
  const base = parseTime(state.timestamp, 'state timestamp');
  const events = state.scenario_events || [];
  const offsets = new Set([0, horizonMin]);
  for (let minute = stepMin; minute < horizonMin; minute += stepMin) offsets.add(minute);
  for (const event of events) for (const value of [event.timestamp, event.end_time]) {
    const offset = (parseTime(value, 'event timestamp') - base) / 60000;
    if (offset > 0 && offset < horizonMin) offsets.add(offset);
  }
  const minutes = [...offsets].sort((a, b) => a - b);
  const poi_predictions = {}, road_predictions = {};
  for (const node of graph.nodes.filter(n => n.poi_id)) {
    const id = node.poi_id, initial = state.poi_states[id];
    poi_predictions[id] = minutes.map(offset_min => {
      const at = base + offset_min * 60000;
      const spikes = events.filter(e => e.target_id === id && e.event_type === 'QUEUE_SPIKE');
      const isActive = (e, time) => parseTime(e.timestamp, 'event timestamp') <= time && time < parseTime(e.end_time, 'event end_time');
      const delta = spikes.reduce((sum, e) => sum + (Number(isActive(e, at)) - Number(isActive(e, base))) * e.multiplier, 0);
      const addedQueue = delta * scenarios.QUEUE_SPIKE.queue_increase_min;
      const addedCrowd = delta * scenarios.QUEUE_SPIKE.crowd_increase;
      const queue_min = round(Math.max(0, initial.queue_min + offset_min / 60 * scenarios.NORMAL.queue_drift_per_hour + addedQueue));
      const crowd_ratio = round(Math.min(.98, Math.max(0, initial.crowd_ratio + offset_min / 60 * scenarios.NORMAL.crowd_drift_per_hour + addedCrowd)), 3);
      return { offset_min, timestamp: stamp(at), queue_min, crowd_ratio, crowd_level: level(crowd_ratio), open: initial.open };
    });
  }
  for (const edge of graph.edges) {
    const id = edge.edge_id, initial = state.road_states[id];
    road_predictions[id] = minutes.map(offset_min => {
      const at = base + offset_min * 60000;
      const relevant = events.filter(e => e.target_id === id && parseTime(e.timestamp, 'event timestamp') <= at && at < parseTime(e.end_time, 'event end_time'));
      const closeEvents = events.filter(e => e.target_id === id && e.event_type === 'ROAD_CLOSE');
      const available = closeEvents.length ? !relevant.some(e => e.event_type === 'ROAD_CLOSE') && (initial.available || closeEvents.some(e => parseTime(e.timestamp, 'event timestamp') <= base)) : initial.available;
      const slowdowns = events.filter(e => e.target_id === id && e.event_type === 'ROAD_SLOWDOWN');
      const factorAt = slowdowns.filter(e => parseTime(e.timestamp, 'event timestamp') <= at && at < parseTime(e.end_time, 'event end_time')).reduce((factor, e) => factor * (1 + (scenarios.ROAD_SLOWDOWN.travel_time_multiplier - 1) * e.multiplier), 1);
      const factorBase = slowdowns.filter(e => parseTime(e.timestamp, 'event timestamp') <= base && base < parseTime(e.end_time, 'event end_time')).reduce((factor, e) => factor * (1 + (scenarios.ROAD_SLOWDOWN.travel_time_multiplier - 1) * e.multiplier), 1);
      const slowdown = factorAt / factorBase;
      const travel_time_min = round(initial.travel_time_min * (1 + offset_min / 60 * scenarios.NORMAL.road_delay_per_hour) * slowdown);
      return { offset_min, timestamp: stamp(at), travel_time_min, available };
    });
  }
  const identity = JSON.stringify({ state, horizonMin, stepMin, scenarios });
  const forecast_version = `forecast_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
  return { schema_version: '0.1', scenario_id: state.scenario_id, state_version: state.state_version, forecast_version, base_timestamp: state.timestamp, horizon_min: horizonMin, step_min: stepMin, poi_predictions, road_predictions };
}
module.exports = { predictEnvironment };

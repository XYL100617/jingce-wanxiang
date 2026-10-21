const { parseTime } = require('./scenarioEngine');

function locate(forecast, samples, time) {
  const at = parseTime(time, 'timestamp');
  const base = parseTime(forecast.base_timestamp, 'base timestamp');
  if (at < base || at > base + forecast.horizon_min * 60000) throw new RangeError('Timestamp exceeds forecast horizon');
  let i = 0;
  while (i + 1 < samples.length && parseTime(samples[i + 1].timestamp, 'prediction timestamp') <= at) i++;
  const left = samples[i], right = samples[Math.min(i + 1, samples.length - 1)];
  const leftAt = parseTime(left.timestamp, 'prediction timestamp'), rightAt = parseTime(right.timestamp, 'prediction timestamp');
  const fraction = rightAt === leftAt ? 0 : (at - leftAt) / (rightAt - leftAt);
  return { left, right, fraction };
}
const interpolate = (a, b, fraction) => Math.round((a + (b - a) * fraction) * 100) / 100;
function queryQueue(forecast, poiId, arrivalTime) {
  const samples = forecast.poi_predictions[poiId];
  if (!samples) throw new RangeError(`Unknown poi_id: ${poiId}`);
  const { left, right, fraction } = locate(forecast, samples, arrivalTime);
  return { poi_id: poiId, arrival_time: arrivalTime, queue_min: interpolate(left.queue_min, right.queue_min, fraction), crowd_ratio: interpolate(left.crowd_ratio, right.crowd_ratio, fraction), crowd_level: left.crowd_level, open: left.open, forecast_version: forecast.forecast_version };
}
function queryTravelTime(forecast, edgeId, enterTime) {
  const samples = forecast.road_predictions[edgeId];
  if (!samples) throw new RangeError(`Unknown edge_id: ${edgeId}`);
  const { left, right, fraction } = locate(forecast, samples, enterTime);
  return { edge_id: edgeId, enter_time: enterTime, travel_time_min: interpolate(left.travel_time_min, right.travel_time_min, fraction), available: left.available, forecast_version: forecast.forecast_version };
}
module.exports = { queryQueue, queryTravelTime };

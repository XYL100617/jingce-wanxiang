'use strict';

const { toMillis } = require('./time');

function sortedSeries(series = []) {
  return [...series]
    .filter(point => point && point.timestamp)
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
}

function bracket(series, timestamp) {
  const points = sortedSeries(series);
  if (!points.length) return null;
  const target = toMillis(timestamp);
  if (target <= toMillis(points[0].timestamp)) return { left: points[0], right: points[0], ratio: 0 };
  const last = points[points.length - 1];
  if (target >= toMillis(last.timestamp)) return { left: last, right: last, ratio: 0 };
  for (let i = 1; i < points.length; i += 1) {
    const rightTime = toMillis(points[i].timestamp);
    if (target <= rightTime) {
      const left = points[i - 1];
      const leftTime = toMillis(left.timestamp);
      return { left, right: points[i], ratio: (target - leftTime) / (rightTime - leftTime) };
    }
  }
  return { left: last, right: last, ratio: 0 };
}

function interpolate(series, timestamp, field, fallback = 0) {
  const hit = bracket(series, timestamp);
  if (!hit) return fallback;
  const a = Number(hit.left[field]);
  const b = Number(hit.right[field]);
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : fallback;
  if (!Number.isFinite(b) || hit.left === hit.right) return a;
  return a + (b - a) * hit.ratio;
}

function stepValue(series, timestamp, field, fallback) {
  const points = sortedSeries(series);
  if (!points.length) return fallback;
  const target = toMillis(timestamp);
  let chosen = points[0];
  for (const point of points) {
    if (toMillis(point.timestamp) > target) break;
    chosen = point;
  }
  return chosen[field] === undefined ? fallback : chosen[field];
}

function queryQueue(forecast, state, poiId, arrivalTime) {
  const series = forecast?.poi_predictions?.[poiId] || [];
  const fallback = Number(state?.poi_states?.[poiId]?.current_queue_min || 0);
  return Math.max(0, Math.round(interpolate(series, arrivalTime, 'queue_min', fallback) * 10) / 10);
}

function queryRoad(forecast, state, edge, enterTime) {
  const edgeId = edge.edge_id;
  const series = forecast?.road_predictions?.[edgeId] || [];
  const roadState = state?.road_states?.[edgeId] || {};
  const available = Boolean(roadState.available !== false && stepValue(series, enterTime, 'available', true) !== false);
  const fallback = Number(roadState.travel_time_min || edge.base_travel_time_min || 0);
  const travelTimeMin = Math.max(0, interpolate(series, enterTime, 'travel_time_min', fallback));
  return { available, travel_time_min: Math.round(travelTimeMin * 100) / 100 };
}

module.exports = { interpolate, stepValue, queryQueue, queryRoad };

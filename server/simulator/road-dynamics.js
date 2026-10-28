'use strict';

const { PARAMETERS } = require('./config/default-parameters');
const param = (parameters, name) => parameters[name] ?? PARAMETERS[name].value;

function weatherCategory(weather = {}) {
  const label = String(weather.category || weather.label || '').toUpperCase();
  if (label === 'RAIN' || label.includes('雨')) return 'RAIN';
  if (label === 'HOT' || label.includes('热') || label.includes('高温')) return 'HOT';
  return 'CLEAR'; // Includes the current DEMO label 晴间多云.
}

function weatherMultiplier(weather, parameters) {
  const category = weatherCategory(weather);
  return { category, multiplier: parameters.road_reference_capacity === undefined
    ? 1 : param(parameters, `weather_${category.toLowerCase()}_multiplier`) };
}

function congestionMultiplier(ratio, parameters) {
  // Direct legacy mobility helpers pass only travel parameters. The full
  // simulator resolves the registered P1-G parameters before transitions.
  if (parameters.road_reference_capacity === undefined) return 1;
  return Math.min(param(parameters, 'max_congestion_multiplier'),
    1 + param(parameters, 'congestion_alpha')
      * Math.max(0, ratio - param(parameters, 'free_flow_threshold')));
}

function estimateRoad(state, edgeId, parameters, occupancy = state.roads[edgeId]?.occupancy) {
  const road = state.roads[edgeId];
  if (!road) throw new Error(`unknown road: ${edgeId}`);
  if (!Number.isSafeInteger(occupancy) || occupancy < 0 || !(road.reference_capacity > 0)
    || !(road.base_travel_time_min > 0) || !(road.speed_factor > 0)) {
    throw new Error(`invalid road dynamics input: ${edgeId}`);
  }
  const occupancy_ratio = occupancy / road.reference_capacity;
  const congestion_multiplier = congestionMultiplier(occupancy_ratio, parameters);
  const weather = weatherMultiplier(state.environment.weather, parameters);
  const effective_travel_time_min = road.base_travel_time_min / road.speed_factor
    * parameters.travel_time_multiplier * congestion_multiplier * weather.multiplier;
  if (!(effective_travel_time_min > 0)) throw new Error(`nonpositive road time: ${edgeId}`);
  return { edge_id: edgeId, occupancy, reference_capacity: road.reference_capacity,
    occupancy_ratio, congestion_multiplier, weather_category: weather.category,
    weather_multiplier: weather.multiplier, effective_travel_time_min };
}

function updateRoadMetric(state, edgeId, parameters) {
  Object.assign(state.roads[edgeId], estimateRoad(state, edgeId, parameters));
}

function syncRoadOccupancy(state, parameters) {
  for (const road of Object.values(state.roads)) road.occupancy = 0;
  for (const group of state.mobility_ledger.transit_groups) {
    if (!group.current_edge_id) continue;
    if (!state.roads[group.current_edge_id]) throw new Error(`unknown occupied edge: ${group.current_edge_id}`);
    state.roads[group.current_edge_id].occupancy += group.count;
  }
  for (const edgeId of Object.keys(state.roads)) updateRoadMetric(state, edgeId, parameters);
}

function lockedTravelMin(effectiveMin, parameters) {
  if (parameters.road_reference_capacity !== undefined) {
    return Math.round(effectiveMin * 1000) / 1000;
  }
  const step = parameters.simulation_step_min;
  return Math.max(parameters.minimum_edge_travel_min, Math.ceil(effectiveMin / step) * step);
}

function enterEdge(state, group, edgeId, parameters) {
  const road = state.roads[edgeId];
  if (!road?.is_open) throw new Error(`attempt to enter closed edge: ${edgeId}`);
  const projected = estimateRoad(state, edgeId, parameters, road.occupancy + group.count);
  road.occupancy += group.count;
  updateRoadMetric(state, edgeId, parameters);
  group.locked_segment_travel_time_min = lockedTravelMin(projected.effective_travel_time_min, parameters);
  group.locked_effective_time_min = projected.effective_travel_time_min;
  group.locked_congestion_multiplier = projected.congestion_multiplier;
  group.locked_weather_multiplier = projected.weather_multiplier;
  group.remaining_edge_min = group.locked_segment_travel_time_min;
  return { ...projected, locked_segment_travel_time_min: group.locked_segment_travel_time_min };
}

function leaveEdge(state, group, edgeId, parameters) {
  const road = state.roads[edgeId];
  if (!road || road.occupancy < group.count) throw new Error(`edge occupancy underflow: ${edgeId}`);
  road.occupancy -= group.count;
  updateRoadMetric(state, edgeId, parameters);
  group.locked_segment_travel_time_min = null;
  group.locked_effective_time_min = null;
  group.locked_congestion_multiplier = null;
  group.locked_weather_multiplier = null;
}

function summarizeRoads(state) {
  const roads = Object.values(state.roads);
  return {
    total_transit_people_on_edges: roads.reduce((sum, road) => sum + road.occupancy, 0),
    occupied_edge_count: roads.filter(road => road.occupancy > 0).length,
    max_edge_occupancy: Math.max(0, ...roads.map(road => road.occupancy)),
    max_occupancy_ratio: Math.max(0, ...roads.map(road => road.occupancy_ratio)),
    max_effective_travel_time_min: Math.max(0, ...roads.map(road => road.effective_travel_time_min)),
    mean_congestion_multiplier: roads.reduce((sum, road) => sum + road.congestion_multiplier, 0) / roads.length
  };
}

function validateRoadDynamics(state, parameters) {
  const expected = Object.fromEntries(Object.keys(state.roads).map(id => [id, 0]));
  for (const group of state.mobility_ledger.transit_groups) {
    if (!group.current_edge_id) continue;
    expected[group.current_edge_id] += group.count;
    if (!(group.locked_segment_travel_time_min > 0)
      || !(group.locked_effective_time_min > 0)
      || !(group.locked_congestion_multiplier >= 1)
      || !(group.locked_weather_multiplier > 0)
      || group.remaining_edge_min > group.locked_segment_travel_time_min) {
      throw new Error(`invalid locked edge time: ${group.group_id}`);
    }
  }
  for (const [edgeId, road] of Object.entries(state.roads)) {
    const estimated = parameters ? estimateRoad(state, edgeId, parameters) : null;
    if (road.occupancy !== expected[edgeId]
      || !(road.reference_capacity > 0) || !(road.base_travel_time_min > 0)
      || !(road.congestion_multiplier >= 1) || !(road.weather_multiplier > 0)
      || !(road.effective_travel_time_min > 0)
      || road.occupancy_ratio !== road.occupancy / road.reference_capacity
      || (estimated && (road.congestion_multiplier !== estimated.congestion_multiplier
        || road.weather_multiplier !== estimated.weather_multiplier
        || road.effective_travel_time_min !== estimated.effective_travel_time_min))) {
      throw new Error(`road occupancy or metric invariant failed: ${edgeId}`);
    }
  }
  return 'PASS';
}

module.exports = { weatherCategory, weatherMultiplier, congestionMultiplier, estimateRoad,
  syncRoadOccupancy, enterEdge, leaveEdge, lockedTravelMin, summarizeRoads, validateRoadDynamics };

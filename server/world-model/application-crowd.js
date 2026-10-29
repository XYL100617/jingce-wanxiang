'use strict';

const crowdTrend = require('./crowd-trend');
const scenarios = require('../data/scenarios.json');
const HORIZONS = [5, 15, 30, 60];

function eventCrowdDelta(state, poiId, horizonMin) {
  const now = Date.parse(state.timestamp.replace(' ', 'T') + 'Z');
  const target = now + horizonMin * 60000;
  const activeAt = (event, time) => {
    const start = Date.parse(String(event.timestamp || '').replace(' ', 'T') + 'Z');
    const end = Date.parse(String(event.end_time || '').replace(' ', 'T') + 'Z');
    return Number.isFinite(start) && Number.isFinite(end) && start <= time && time < end;
  };
  return (state.scenario_events || []).filter(event => event.event_type === 'QUEUE_SPIKE' && event.target_id === poiId)
    .reduce((sum, event) => sum + (Number(activeAt(event, target)) - Number(activeAt(event, now)))
      * Number(event.multiplier || 1) * scenarios.QUEUE_SPIKE.crowd_increase, 0);
}

function toObservation(state, graph) {
  const weather = state.weather || {};
  const temperature = Number(weather.temp);
  return {
    timestamp: state.timestamp,
    source_tier: 'T4',
    synthetic: true,
    simulator_version: 'app-forecast-sim-v1',
    weather: { category: weather.rain >= 0.5 ? 'RAIN' : temperature >= 30 ? 'HOT' : 'MILD' },
    pois: Object.fromEntries(Object.entries(state.poi_states || {}).map(([id, poi]) => [id, {
      is_open: poi.open !== false,
      crowd_ratio: Number(poi.crowd_ratio)
      // A queue wait in minutes is not a queue count. Keep the trained
      // queue_count feature missing instead of inventing a conversion.
    }])),
    roads: Object.fromEntries(Object.entries(state.road_states || {}).map(([id, road]) => [id, {
      is_open: road.available !== false
    }])),
    events: Object.fromEntries(Object.entries(state.event_states || {}).map(([id, event]) => [id, {
      node_id: event.node_id,
      start_time: event.start_time,
      end_time: event.end_time,
      capacity: Number(event.capacity) || 0,
      cancelled: event.cancelled === true || event.status === 'cancelled'
    }]).concat((state.scenario_events || []).flatMap((event, index) => {
      if (event.event_type !== 'QUEUE_SPIKE') return [];
      const node = graph.nodes.find(item => item.poi_id === event.target_id);
      if (!node) return [];
      // This is a simulator-derived pressure proxy (ratio × POI capacity),
      // not an observed attendee or queue count.
      const pressureUnits = scenarios.QUEUE_SPIKE.crowd_increase
        * Number(node.capacity || 0) * Number(event.multiplier || 1);
      return [[`scenario:${event.event_id || index}`, {
        node_id: node.node_id,
        start_time: event.timestamp,
        end_time: event.end_time,
        capacity: pressureUnits,
        event_queue_count: pressureUnits,
        attending_count: 0,
        cancelled: false,
        synthetic_pressure_proxy: true
      }]];
    })))
  };
}

function predictApplicationCrowd(graph, state, baselineForecast = null) {
  const observation = toObservation(state, graph);
  const byHorizon = Object.fromEntries(HORIZONS.map(horizon => [horizon,
    crowdTrend.predict(graph, observation, { horizonMin: horizon, allowCompatibleSyntheticRuntime: true })]));
  const poiIds = [...new Set(HORIZONS.flatMap(horizon => Object.keys(byHorizon[horizon].poi_predictions)))];
  const distribution = poiIds.map(poiId => {
    const node = graph.nodes.find(item => item.poi_id === poiId);
    const currentCrowdRatio = Number(state.poi_states?.[poiId]?.crowd_ratio || 0);
    return {
      poi_id: poiId,
      node_id: node?.node_id || null,
      name: node?.name || poiId,
      area_id: node?.area_id || node?.zone_id || null,
      current_crowd_ratio: currentCrowdRatio,
      horizons: Object.fromEntries(HORIZONS.map(horizon => {
        const prediction = byHorizon[horizon].poi_predictions[poiId];
        if (!prediction || !baselineForecast) return [horizon, prediction || null];
        const points = baselineForecast.poi_predictions?.[poiId] || [];
        const baseline = points.find(point => Number(point.offset_min) === horizon)
          || points.reduce((best, point) => !best || Math.abs(Number(point.offset_min) - horizon) < Math.abs(Number(best.offset_min) - horizon) ? point : best, null);
        const eventDelta = eventCrowdDelta(state, poiId, horizon);
        return [horizon, baseline ? { ...prediction,
          raw_world_model_predicted_crowd_ratio: prediction.predicted_crowd_ratio,
          world_model_predicted_crowd_ratio: Math.max(0, Math.min(1, prediction.predicted_crowd_ratio + eventDelta)),
          world_model_upward_trend_probability: prediction.upward_trend_probability,
          predicted_crowd_ratio: Number(baseline.crowd_ratio),
          known_event_crowd_delta: eventDelta,
          upward_trend_probability: Number(baseline.crowd_ratio) - currentCrowdRatio >= 0.03
            ? 1 : prediction.upward_trend_probability,
          trend_risk_source: Number(baseline.crowd_ratio) - currentCrowdRatio >= 0.03
            ? 'known-simulator-event' : 'learned-model',
          calibration: 'application-rule-prior' } : prediction];
      }))
    };
  });
  return {
    model: {
      model_version: byHorizon[30].model_version,
      mode: 'synthetic_transfer_inference',
      training_simulator_version: byHorizon[30].training_simulator_version,
      input_simulator_version: 'app-forecast-sim-v1',
      source_tier: 'T4', synthetic: true, realtime: false,
      horizons_min: HORIZONS,
      calibration: baselineForecast ? 'rule-calibrated-density-plus-learned-trend-risk' : 'learned-estimate-only',
      limitation: baselineForecast
        ? `${byHorizon[30].limitation} 密度数值以项目可解释的场景规则作校准基线，学习模型的原始密度估值单独返回；趋势风险结合学习模型与已知模拟事件。`
        : byHorizon[30].limitation
    },
    timestamp: state.timestamp,
    distribution,
    route_scores: byHorizon[30].route_scores
  };
}

function blendCrowdIntoForecast(forecast, distribution) {
  const byPoi = new Map(distribution.map(item => [item.poi_id, item]));
  const poi_predictions = Object.fromEntries(Object.entries(forecast.poi_predictions || {}).map(([poiId, series]) => {
    const item = byPoi.get(poiId);
    if (!item) return [poiId, series];
    return [poiId, series.map(point => {
      const elapsed = Math.max(0, (Date.parse(point.timestamp.replace(' ', 'T') + 'Z')
        - Date.parse(forecast.base_timestamp.replace(' ', 'T') + 'Z')) / 60000);
      if (elapsed > 60) return point;
      const upper = HORIZONS.find(horizon => horizon >= elapsed) || 60;
      const lower = [...HORIZONS].reverse().find(horizon => horizon <= elapsed) || 5;
      const a = item.horizons[lower];
      const b = item.horizons[upper];
      if (!a || !b) return point;
      const fraction = upper === lower ? 0 : (elapsed - lower) / (upper - lower);
      const modelRatio = (a.world_model_predicted_crowd_ratio ?? a.predicted_crowd_ratio)
        + ((b.world_model_predicted_crowd_ratio ?? b.predicted_crowd_ratio)
          - (a.world_model_predicted_crowd_ratio ?? a.predicted_crowd_ratio)) * fraction;
      const rawModelRatio = (a.raw_world_model_predicted_crowd_ratio ?? a.predicted_crowd_ratio)
        + ((b.raw_world_model_predicted_crowd_ratio ?? b.predicted_crowd_ratio)
          - (a.raw_world_model_predicted_crowd_ratio ?? a.predicted_crowd_ratio)) * fraction;
      const ratio = a.calibration === 'application-rule-prior'
        ? Number(point.crowd_ratio) : a.predicted_crowd_ratio + (b.predicted_crowd_ratio - a.predicted_crowd_ratio) * fraction;
      const risk = a.upward_trend_probability + (b.upward_trend_probability - a.upward_trend_probability) * fraction;
      const modelRisk = (a.world_model_upward_trend_probability ?? a.upward_trend_probability)
        + ((b.world_model_upward_trend_probability ?? b.upward_trend_probability)
          - (a.world_model_upward_trend_probability ?? a.upward_trend_probability)) * fraction;
      return { ...point, crowd_ratio: Math.max(0, Math.min(1, ratio)),
        world_model_predicted_crowd_ratio: modelRatio,
        raw_world_model_predicted_crowd_ratio: rawModelRatio,
        world_model_upward_trend_probability: modelRisk,
        crowd_level: ratio >= .7 ? 'HIGH' : ratio >= .4 ? 'MEDIUM' : 'LOW',
        upward_trend_probability: risk, prediction_source: 'trained_synthetic_transfer' };
    })];
  }));
  return { ...forecast, poi_predictions, crowd_model: {
    mode: 'synthetic_transfer_inference', source_tier: 'T4', synthetic: true, realtime: false
  } };
}

module.exports = { HORIZONS, toObservation, predictApplicationCrowd, blendCrowdIntoForecast };

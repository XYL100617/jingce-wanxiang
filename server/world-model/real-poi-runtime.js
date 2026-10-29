'use strict';

const fs = require('node:fs');
const path = require('node:path');
const graph = require('../data/scenic_graph.json');
const { features, predict, HORIZONS, GRAPH_FINGERPRINT } = require('../../scripts/train-local-real-poi-model');

const defaultModelPath = path.join(__dirname, 'real-poi-model.json');
let cached = null;

function modelFrom(filePath = process.env.WORLD_MODEL_REAL_PATH || defaultModelPath) {
  if (!fs.existsSync(filePath)) return { error: 'REAL_MODEL_NOT_FOUND' };
  const stat = fs.statSync(filePath);
  if (cached?.filePath === filePath && cached.mtimeMs === stat.mtimeMs) return cached.model;
  let model;
  try { model = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return { error: 'REAL_MODEL_INVALID_JSON' }; }
  const expectedPois = graph.nodes.filter(node => node.poi_id).map(node => node.poi_id).sort();
  if (model.source_tier !== 'REAL' || model.synthetic !== false || model.eligible_for_planning !== true)
    return { error: 'REAL_MODEL_NOT_ELIGIBLE' };
  if (model.graph_fingerprint !== GRAPH_FINGERPRINT || model.graph_version !== '1.0' ||
      !Array.isArray(model.graph_contract?.poi_ids) || JSON.stringify([...model.graph_contract.poi_ids].sort()) !== JSON.stringify(expectedPois))
    return { error: 'REAL_MODEL_GRAPH_MISMATCH' };
  if (!HORIZONS.every(h => model.metrics?.queue_min?.[h]?.models && model.metrics?.crowd_ratio?.[h]?.models))
    return { error: 'REAL_MODEL_SCHEMA_MISMATCH' };
  cached = { filePath, mtimeMs: stat.mtimeMs, model };
  return model;
}

function applyRealModel(state, forecast, options = {}) {
  const enabled = options.enabled ?? process.env.WORLD_MODEL_REAL_ACTIVE === 'true';
  if (!enabled) return forecast;
  if (state?.source_tier !== 'REAL' || state?.synthetic !== false || state?.graph_fingerprint !== GRAPH_FINGERPRINT)
    return { ...forecast, learned_model: { mode: 'rule_fallback', reason: 'CURRENT_STATE_NOT_VERIFIED_REAL' } };
  const model = modelFrom(options.modelPath);
  if (model.error) return { ...forecast, learned_model: { mode: 'rule_fallback', reason: model.error } };

  const row = { timestamp: state.timestamp, poi_states: state.poi_states,
    events: state.events || state.scenario_events || [], weather: state.weather || {} };
  const horizons = HORIZONS.map(h => ({ h, values: Object.fromEntries(graph.nodes.filter(node => node.poi_id).map(node => {
    const poiId = node.poi_id, x = features(row, poiId, h);
    const queueModel = model.metrics.queue_min[h].models[poiId];
    const crowdModel = model.metrics.crowd_ratio[h].models[poiId];
    return [poiId, {
      available: Boolean(queueModel && crowdModel),
      queue_min: queueModel ? Math.max(0, predict(queueModel, x)) : null,
      crowd_ratio: crowdModel ? Math.max(0, Math.min(1, predict(crowdModel, x))) : null
    }];
  })) }));
  const points = [
    { offset: 0, before: 0, after: 0 }, { offset: 10, before: 10, after: 10 },
    { offset: 20, before: 20, after: 20 }, { offset: 30, before: 30, after: 30 },
    { offset: 40, before: 30, after: 60 }, { offset: 50, before: 30, after: 60 },
    { offset: 60, before: 60, after: 60 }
  ];
  const poi_predictions = structuredClone(forecast.poi_predictions);
  for (const [poiId, series] of Object.entries(poi_predictions)) for (const point of series) {
    if (point.offset_min === 0 || point.open === false) continue;
    const interval = points.find(item => item.offset === point.offset_min);
    if (!interval) continue;
    const low = horizons.find(item => item.h === interval.before)?.values[poiId];
    const high = horizons.find(item => item.h === interval.after)?.values[poiId];
    if (!low?.available || !high?.available) continue;
    const fraction = interval.after === interval.before ? 0 : (point.offset_min - interval.before) / (interval.after - interval.before);
    point.queue_min = Number((low.queue_min + (high.queue_min - low.queue_min) * fraction).toFixed(2));
    point.crowd_ratio = Number((low.crowd_ratio + (high.crowd_ratio - low.crowd_ratio) * fraction).toFixed(3));
    point.crowd_level = point.crowd_ratio >= 0.7 ? 'HIGH' : point.crowd_ratio >= 0.4 ? 'MEDIUM' : 'LOW';
  }
  return { ...forecast, poi_predictions,
    forecast_version: `${forecast.forecast_version}+${model.model_version}`,
    learned_model: { mode: 'real_observation_model', model_version: model.model_version,
      source_tier: model.source_tier, synthetic: false, graph_fingerprint: model.graph_fingerprint,
      fallback: 'rule_simulator_for_missing_or_closed_POIs' } };
}

module.exports = { applyRealModel, modelFrom, defaultModelPath };

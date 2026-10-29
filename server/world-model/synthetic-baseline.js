'use strict';

const model = require('./synthetic-baseline-v0.1.json');

function validateObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation))
    throw new TypeError('observation must be an object');
  if (observation.synthetic !== true || observation.source_tier !== 'T4')
    throw new TypeError('this experimental model only accepts explicitly marked T4 synthetic observations');
  if (!observation.pois || typeof observation.pois !== 'object' || Array.isArray(observation.pois))
    throw new TypeError('observation.pois must be an object keyed by poi_id');
  for (const [poiId, poi] of Object.entries(observation.pois)) {
    if (!poi || typeof poi !== 'object' || Array.isArray(poi))
      throw new TypeError(`observation.pois.${poiId} must be an object`);
    const value = poi.queue_count;
    if (value != null && (!Number.isFinite(value) || value < 0))
      throw new TypeError(`observation.pois.${poiId}.queue_count must be a non-negative number or null`);
  }
}

function describe() {
  return {
    model_version: model.model_version,
    dataset_version: model.dataset_version,
    graph_version: model.graph_version,
    simulator_version: model.simulator_version,
    source_tier: model.source_tier,
    synthetic: model.synthetic,
    target_definition: model.target_definition,
    mode: 'experimental_shadow',
    affects_planning: false,
    fallback: 'existing rule forecast and planner remain authoritative',
    metrics: Object.fromEntries(Object.entries(model.horizons).map(([horizon, result]) => [horizon, {
      test_mae: result.test.mae,
      test_rmse: result.test.rmse,
      persistence_test_mae: result.test.persistence_mae,
      validation_absolute_error_p90: result.interval.half_width,
      test_sample_count: result.test.n,
    }]))
  };
}

function predict(observation) {
  validateObservation(observation);
  const horizons = {};
  for (const [horizon, config] of Object.entries(model.horizons)) {
    const poi_predictions = {};
    for (const [poiId, coefficients] of Object.entries(config.poi_models)) {
      const queueCount = observation.pois[poiId]?.queue_count;
      if (!Number.isFinite(queueCount)) {
        poi_predictions[poiId] = { available: false, queue_count: null, reason: 'MISSING_OBSERVATION' };
        continue;
      }
      const estimate = Math.max(0, coefficients.intercept + coefficients.observed_queue_count * queueCount);
      const halfWidth = config.interval.half_width;
      poi_predictions[poiId] = {
        available: true,
        queue_count: Number(estimate.toFixed(4)),
        lower_bound: Number(Math.max(0, estimate - halfWidth).toFixed(4)),
        upper_bound: Number((estimate + halfWidth).toFixed(4)),
        interval_method: 'validation absolute-error P90; empirical, not calibrated coverage',
      };
    }
    horizons[horizon] = { poi_predictions };
  }
  return {
    ...describe(),
    generated_at: new Date().toISOString(),
    observation_timestamp: observation.timestamp || null,
    horizon_unit: 'minutes',
    horizons,
    warning: 'Synthetic-only experimental output. It does not estimate real visitor counts and is not used by routes or the production rule forecast.',
  };
}

module.exports = { describe, predict, validateObservation };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../server/data/scenic_graph.json');
const initialState = require('../server/data/current_state.json');
const { predictEnvironment } = require('../server/state/forecastSimulator');
const { predictApplicationCrowd, blendCrowdIntoForecast } = require('../server/world-model/application-crowd');

test('app crowd calibration preserves Map1 scenario forecasts and retains the learned estimate separately', () => {
  const state = structuredClone(initialState);
  const calibrationForecast = predictEnvironment(state, 60, 5);
  const result = predictApplicationCrowd(graph, state, calibrationForecast);
  assert.equal(result.distribution.length, 41);
  for (const poi of result.distribution) for (const horizon of [5, 15, 30, 60]) {
    const truth = calibrationForecast.poi_predictions[poi.poi_id].find(point => point.offset_min === horizon);
    const forecast = poi.horizons[horizon];
    assert.equal(forecast.predicted_crowd_ratio, truth.crowd_ratio);
    assert.ok(Number.isFinite(forecast.world_model_predicted_crowd_ratio));
    assert.ok(Number.isFinite(forecast.world_model_upward_trend_probability));
  }
});

test('known synthetic queue surge stays visible and raises the trend warning', () => {
  const state = structuredClone(initialState);
  const timestamp = Date.parse(state.timestamp.replace(' ', 'T') + 'Z');
  state.scenario_events = [{ event_id: 'test-surge', event_type: 'QUEUE_SPIKE', target_id: 'theater',
    timestamp: new Date(timestamp + 10 * 60000).toISOString().slice(0, 19).replace('T', ' '),
    end_time: new Date(timestamp + 50 * 60000).toISOString().slice(0, 19).replace('T', ' '), multiplier: 1 }];
  const calibration = predictEnvironment(state, 60, 5);
  const result = predictApplicationCrowd(graph, state, calibration);
  const forecast = blendCrowdIntoForecast(predictEnvironment(state, 60, 10), result.distribution);
  const theater = forecast.poi_predictions.theater.find(point => point.offset_min === 20);
  const expected = calibration.poi_predictions.theater.find(point => point.offset_min === 20);
  assert.equal(theater.crowd_ratio, expected.crowd_ratio);
  assert.equal(theater.upward_trend_probability, 1);
  assert.notEqual(theater.world_model_predicted_crowd_ratio, theater.crowd_ratio);
  assert.ok(Math.abs(theater.world_model_predicted_crowd_ratio - expected.crowd_ratio) < 0.02);
  assert.ok(theater.raw_world_model_predicted_crowd_ratio < theater.world_model_predicted_crowd_ratio);
  assert.equal(theater.world_model_upward_trend_probability < 0.1, true);
});

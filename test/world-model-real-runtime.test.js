'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRealModel } = require('../server/world-model/real-poi-runtime');
const { GRAPH_FINGERPRINT } = require('../scripts/train-local-real-poi-model');
const state = require('../server/data/current_state.json');

test('real world-model runtime is inactive by default and leaves rule forecast untouched', () => {
  const forecast = { forecast_version: 'rule-v1', poi_predictions: {}, road_predictions: {} };
  assert.equal(applyRealModel(state, forecast, { enabled: false }), forecast);
});

test('explicit activation without a verified local model reports rule fallback', () => {
  const forecast = { forecast_version: 'rule-v1', poi_predictions: {}, road_predictions: {} };
  const realState = { ...state, source_tier: 'REAL', synthetic: false, graph_fingerprint: GRAPH_FINGERPRINT };
  const result = applyRealModel(realState, forecast, { enabled: true, modelPath: 'D:/jingxing/no-such-real-model.json' });
  assert.equal(result.learned_model.mode, 'rule_fallback');
  assert.equal(result.learned_model.reason, 'REAL_MODEL_NOT_FOUND');
  assert.equal(result.forecast_version, 'rule-v1');
});

test('a synthetic/demo state cannot enter the learned runtime even with an explicit model path', () => {
  const forecast = { forecast_version: 'rule-v1', poi_predictions: {}, road_predictions: {} };
  const result = applyRealModel({ ...state, source_tier: 'REAL', synthetic: false }, forecast,
    { enabled: true, modelPath: 'D:/jingxing/no-such-real-model.json' });
  assert.equal(result.learned_model.mode, 'rule_fallback');
  assert.equal(result.learned_model.reason, 'CURRENT_STATE_NOT_VERIFIED_REAL');
});

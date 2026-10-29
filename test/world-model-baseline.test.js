'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const baseline = require('../server/world-model/synthetic-baseline');

test('experimental model describes its synthetic-only shadow mode and holdout metrics', () => {
  const status = baseline.describe();
  assert.equal(status.mode, 'experimental_shadow');
  assert.equal(status.affects_planning, false);
  assert.equal(status.synthetic, true);
  assert.ok(status.metrics.target_60.test_sample_count > 0);
});

test('prediction returns per-POI values and validation intervals for T4 observations', () => {
  const result = baseline.predict({ synthetic: true, source_tier: 'T4', timestamp: '2026-10-20 10:18:00',
    pois: { lake: { queue_count: 1 }, market: { queue_count: 2 } } });
  const lake = result.horizons.target_5.poi_predictions.lake;
  assert.equal(lake.available, true);
  assert.ok(lake.queue_count >= 0);
  assert.ok(lake.lower_bound <= lake.queue_count);
  assert.ok(lake.queue_count <= lake.upper_bound);
  assert.equal(result.horizons.target_5.poi_predictions.museum.reason, 'MISSING_OBSERVATION');
  assert.equal(result.affects_planning, false);
});

test('model rejects observations not marked synthetic T4', () => {
  assert.throws(() => baseline.predict({ source_tier: 'REAL', pois: {} }), /T4 synthetic/);
});

test('model rejects invalid queue count values', () => {
  assert.throws(() => baseline.predict({ synthetic: true, source_tier: 'T4', pois: { lake: { queue_count: -1 } } }), /non-negative/);
});

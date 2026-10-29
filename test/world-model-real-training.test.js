'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateObservation, dateBuckets, train, HORIZONS, GRAPH_VERSION, GRAPH_FINGERPRINT } = require('../scripts/train-local-real-poi-model');

function observation(timestamp, queue = 12) {
  return { timestamp, source_tier: 'REAL', synthetic: false, graph_version: GRAPH_VERSION, graph_fingerprint: GRAPH_FINGERPRINT,
    source_kind: 'manual_queue_measurement', source_id: 'field-log-1', authorized_for_modeling: true,
    poi_states: { lake: { queue_min: queue, crowd_ratio: Math.min(1, queue / 40), open: true } },
    events: [], weather: { temperature_c: 25, rain_mm: 0 } };
}

test('real observation contract requires real provenance and rejects synthetic samples', () => {
  validateObservation(observation('2026-10-01T08:00:00+08:00'));
  assert.throws(() => validateObservation({ ...observation('2026-10-01T08:00:00+08:00'), synthetic: true }), /synthetic=false/);
  assert.throws(() => validateObservation({ ...observation('2026-10-01T08:00:00+08:00'), source_id: '' }), /source_id/);
  assert.throws(() => validateObservation({ ...observation('2026-10-01T08:00:00+08:00'), authorized_for_modeling: false }), /authorized_for_modeling/);
  assert.throws(() => validateObservation({ ...observation('2026-10-01T08:00:00+08:00'), poi_states: { invented_poi: { queue_min: 2 } } }), /unknown POI/);
});

test('chronological date split holds whole dates for validation and test', () => {
  const rows = Array.from({ length: 20 }, (_, i) => observation(`2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`));
  const { dates, splitByDate } = dateBuckets(rows);
  assert.equal(dates.length, 20);
  const partitions = [...new Set(splitByDate.values())];
  assert.deepEqual(partitions, ['train', 'val', 'test']);
  const ordered = dates.map(date => splitByDate.get(date));
  assert.ok(ordered.indexOf('train') < ordered.indexOf('val'));
  assert.ok(ordered.indexOf('val') < ordered.indexOf('test'));
});

test('real forecaster trains from date-held-out snapshots and reports persistence comparison', async () => {
  const rows = [];
  const start = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 21 * 24 * 12; i++) {
    const at = new Date(start + i * 5 * 60000);
    const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
    const queue = Math.max(0, 18 + 8 * Math.sin(2 * Math.PI * hour / 24) + 0.04 * i / 12);
    rows.push(observation(at.toISOString(), queue));
  }
  const result = await train(rows);
  assert.equal(result.dates.length, 21);
  for (const horizon of HORIZONS) {
    assert.ok(result.output.queue_min[horizon].test.n > 0);
    assert.ok(Number.isFinite(result.output.queue_min[horizon].test.mae));
    assert.ok(result.output.queue_min[horizon].test.persistence_mae >= 0);
  }
  assert.equal(typeof result.eligible, 'boolean');
});

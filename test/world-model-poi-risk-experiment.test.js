'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../server/world-model/training-data-manifest-v0.4-stratified.json');
const report = require('../server/world-model/graph-temporal-report-v0.5-stratified.json');

test('stratified T4 POI risk experiment keeps program groups in every split and records zero baseline', () => {
  assert.deepEqual(manifest.group_counts, { train: 42, val: 9, test: 9 });
  assert.deepEqual(manifest.event_groups_per_split, { train: 5, val: 5, test: 5 });
  assert.equal(manifest.leakage_check.pass, true);
  for (const horizon of ['target_5', 'target_15', 'target_30', 'target_60']) {
    const risk = report.test_metrics.poi_nonzero_probability[horizon];
    const count = report.test_metrics.poi[horizon];
    assert.ok(risk.average_precision > risk.prevalence_baseline_average_precision);
    assert.ok(Number.isFinite(count.zero_baseline_mae));
    assert.ok(count.mae > count.zero_baseline_mae);
  }
  assert.equal(report.source_tier, 'T4');
  assert.equal(report.synthetic, true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../server/data/scenic_graph.json');
const model = require('../server/world-model/graph-temporal');

function observation(overrides = {}) {
  return { synthetic:true, source_tier:'T4', timestamp:'2026-10-20 10:18:00',
    pois:Object.fromEntries(graph.nodes.filter(node => node.poi_id).map(node => [node.poi_id,{queue_count:2}])),
    roads:Object.fromEntries(graph.edges.map(edge => [edge.edge_id,{travel_time_min:edge.base_travel_time_min,is_open:true}])),
    events:{}, weather:{category:'CLEAR'}, ...overrides };
}

test('graph temporal model only runs as a synthetic shadow prediction with route graph topology', () => {
  const input = observation({ events:{show_1:{node_id:'fortress',start_time:'2026-10-20 10:30:00',event_queue_count:12,attending_count:80}} });
  const result = model.predict(graph, input);
  assert.equal(result.model_version, 'synthetic-world-model-v0.3');
  assert.equal(result.affects_planning, false);
  assert.ok(result.horizons['15'].poi_predictions.fortress.upper_bound >= result.horizons['15'].poi_predictions.fortress.queue_count);
  assert.ok(result.horizons['15'].poi_predictions.fortress.nonzero_probability >= 0 && result.horizons['15'].poi_predictions.fortress.nonzero_probability <= 1);
  assert.ok(result.horizons['15'].road_predictions.edge_001.travel_time_min > 0);
});

test('road closures are passed through and never reopened by the model', () => {
  const input = observation();
  input.roads.edge_001.is_open = false;
  const output = model.predict(graph, input).horizons['5'].road_predictions.edge_001;
  assert.equal(output.is_open, false);
  assert.equal(output.travel_time_min, null);
  assert.equal(output.reason, 'CLOSED_ROAD_PASSTHROUGH');
});

test('model rejects real input and graph topology drift', () => {
  assert.throws(() => model.predict(graph, observation({ synthetic:false, source_tier:'REAL' })), /T4 synthetic/);
  const changed = structuredClone(graph); changed.edges[0].to_node_id = 'museum';
  assert.throws(() => model.predict(changed, observation()), /不一致/);
});

test('model rejects invalid observations and too much history', () => {
  const bad = observation(); bad.roads.edge_001.travel_time_min = -2;
  assert.throws(() => model.predict(graph, bad), /invalid road/);
  assert.throws(() => model.predict(graph, observation(), [observation(), observation(), observation()]), /at most two/);
});

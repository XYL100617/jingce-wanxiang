'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../server/data/scenic_graph.json');
const model = require('../server/world-model/crowd-trend');

function observation(overrides = {}) {
  return {
    source_tier: 'T4', synthetic: true, simulator_version: 'sim-dr-p1.1', timestamp: '2026-10-20 10:18:00',
    weather: { category: 'CLEAR' },
    pois: Object.fromEntries(graph.nodes.filter(node => node.poi_id).map(node =>
      [node.poi_id, { is_open: true, crowd_ratio: 0.42, queue_count: 2 }])),
    roads: Object.fromEntries(graph.edges.map(edge => [edge.edge_id,
      { travel_time_min: edge.base_travel_time_min, is_open: true }])),
    events: { show_test: { node_id: 'fortress', start_time: '2026-10-20 10:30:00',
      end_time: '2026-10-20 10:55:00', boarding_open_time: '2026-10-20 10:25:00',
      capacity: 180, event_queue_count: 12, attending_count: 80 } },
    ...overrides
  };
}

function pathBetween(from, to) {
  const adjacency = new Map(graph.nodes.map(node => [node.node_id, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.from_node_id).push(edge.to_node_id);
    adjacency.get(edge.to_node_id).push(edge.from_node_id);
  }
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (current.at(-1) === to) return current;
    for (const next of adjacency.get(current.at(-1)) || []) if (!seen.has(next)) {
      seen.add(next); queue.push([...current, next]);
    }
  }
  throw new Error(`no test path: ${from} -> ${to}`);
}

test('crowd trend model provides Map1 POI forecasts and comparative route scores in T4 shadow mode', () => {
  const routes = [
    { route_id: 'show-route', node_ids: pathBetween('gate', 'fortress') },
    { route_id: 'quiet-route', node_ids: pathBetween('gate', 'lake').concat(pathBetween('lake', 'market').slice(1)) }
  ];
  const result = model.predict(graph, observation(), { horizonMin: 30, routes });
  assert.equal(result.affects_planning, false);
  assert.equal(result.source_tier, 'T4');
  assert.equal(result.synthetic, true);
  assert.ok(result.poi_predictions.fortress.predicted_crowd_ratio >= 0
    && result.poi_predictions.fortress.predicted_crowd_ratio <= 1);
  assert.ok(result.poi_predictions.fortress.upward_trend_probability >= 0
    && result.poi_predictions.fortress.upward_trend_probability <= 1);
  assert.equal(result.route_scores.length, 2);
  assert.equal(result.route_scores[0].route_id, 'show-route');
  assert.equal(result.route_scores[0].feasible_by_observed_open_state, true);
  assert.equal(result.route_scores_are_comparative_only, true);
});

test('crowd trend model rejects REAL inputs, invalid horizons, and graph drift', () => {
  assert.throws(() => model.predict(graph, observation({ source_tier: 'REAL', synthetic: false })), /仅接受/);
  assert.throws(() => model.predict(graph, observation({ simulator_version: 'other-simulator' })), /simulator_version/);
  assert.throws(() => model.predict(graph, observation(), { horizonMin: 20 }), /horizonMin/);
  const changed = structuredClone(graph);
  changed.edges[0].to_node_id = 'museum';
  assert.throws(() => model.predict(changed, observation()), /拓扑/);
});

test('crowd trend model rejects unknown route nodes and overlong/non-synthetic history', () => {
  assert.throws(() => model.predict(graph, observation(), {
    routes: [{ route_id: 'bad', node_ids: ['no-such-node'] }]
  }), /未知地图1 node_id/);
  assert.throws(() => model.predict(graph, observation(), {
    routes: [{ route_id: 'disconnected', node_ids: ['gate', 'fortress'] }]
  }), /不是地图1连通路径/);
  assert.throws(() => model.predict(graph, observation(), {
    history: [observation(), observation(), observation()]
  }), /history/);
  assert.throws(() => model.predict(graph, observation(), {
    history: [{ ...observation(), source_tier: 'REAL', synthetic: false }]
  }), /history/);
});

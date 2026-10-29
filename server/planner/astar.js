'use strict';

const { addMinutes } = require('./time');
const { queryRoad } = require('./forecast');

function nodeId(node) { return node.node_id || node.id; }

const graphContexts = new WeakMap();

function graphContext(graph) {
  let context = graphContexts.get(graph);
  if (context) return context;
  const nodes = new Map((graph.nodes || []).map(node => [nodeId(node), node]));
  let minMinutesPerUnit = Infinity;
  for (const edge of graph.edges || []) {
    const a = nodes.get(edge.from_node_id), b = nodes.get(edge.to_node_id);
    if (!a || !b) continue;
    const distance = Math.hypot(Number(a.algorithm_x || 0) - Number(b.algorithm_x || 0),
      Number(a.algorithm_y || 0) - Number(b.algorithm_y || 0));
    if (distance > 0) minMinutesPerUnit = Math.min(minMinutesPerUnit,
      Number(edge.base_travel_time_min || 0) / distance);
  }
  context = { nodes, adjacency: buildAdjacency(graph), minMinutesPerUnit: Number.isFinite(minMinutesPerUnit) ? minMinutesPerUnit : 0,
    heuristics: new Map() };
  graphContexts.set(graph, context);
  return context;
}

function buildAdjacency(graph) {
  const adjacency = new Map((graph.nodes || []).map(n => [nodeId(n), []]));
  for (const edge of graph.edges || []) {
    const from = edge.from_node_id;
    const to = edge.to_node_id;
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from).push({ edge, next: to });
    if (edge.bidirectional !== false) adjacency.get(to).push({ edge, next: from });
  }
  return adjacency;
}

function heuristicFactory(graph, goalId) {
  const context = graphContext(graph);
  if (context.heuristics.has(goalId)) return context.heuristics.get(goalId);
  const goal = context.nodes.get(goalId);
  const heuristic = id => {
    const current = context.nodes.get(id);
    if (!current || !goal) return 0;
    return Math.hypot(Number(current.algorithm_x || 0) - Number(goal.algorithm_x || 0), Number(current.algorithm_y || 0) - Number(goal.algorithm_y || 0)) * context.minMinutesPerUnit;
  };
  context.heuristics.set(goalId, heuristic);
  return heuristic;
}

function findPath({ graph, state, forecast, startNodeId, goalNodeId, departureTime }) {
  if (startNodeId === goalNodeId) {
    return { reachable: true, node_sequence: [startNodeId], edge_sequence: [], total_distance_m: 0, travel_time_min: 0 };
  }
  const adjacency = graphContext(graph).adjacency;
  if (!adjacency.has(startNodeId) || !adjacency.has(goalNodeId)) {
    return { reachable: false, node_sequence: [], edge_sequence: [], total_distance_m: 0, travel_time_min: 0, reason: '起点或终点不在景区路网中' };
  }
  const heuristic = heuristicFactory(graph, goalNodeId);
  const open = new Set([startNodeId]);
  const best = new Map([[startNodeId, { g: 0, distance: 0, previous: null, via: null }]]);

  while (open.size) {
    let current = null;
    let currentScore = Infinity;
    for (const id of open) {
      const score = best.get(id).g + heuristic(id);
      if (score < currentScore) { current = id; currentScore = score; }
    }
    open.delete(current);
    if (current === goalNodeId) break;
    const currentBest = best.get(current);
    for (const { edge, next } of adjacency.get(current) || []) {
      const road = queryRoad(forecast, state, edge, addMinutes(departureTime, currentBest.g));
      if (!road.available) continue;
      const candidate = currentBest.g + road.travel_time_min;
      if (!best.has(next) || candidate < best.get(next).g) {
        best.set(next, {
          g: candidate,
          distance: currentBest.distance + Number(edge.distance_m || 0),
          previous: current,
          via: edge.edge_id
        });
        open.add(next);
      }
    }
  }

  if (!best.has(goalNodeId)) {
    return { reachable: false, node_sequence: [], edge_sequence: [], total_distance_m: 0, travel_time_min: 0, reason: '受道路关闭或路网拓扑限制，目标不可达' };
  }
  const nodes = [];
  const edges = [];
  let cursor = goalNodeId;
  while (cursor) {
    nodes.push(cursor);
    const item = best.get(cursor);
    if (item?.via) edges.push(item.via);
    cursor = item?.previous;
  }
  const result = best.get(goalNodeId);
  return {
    reachable: true,
    node_sequence: nodes.reverse(),
    edge_sequence: edges.reverse(),
    total_distance_m: result.distance,
    travel_time_min: Math.round(result.g * 100) / 100
  };
}

module.exports = { buildAdjacency, findPath };

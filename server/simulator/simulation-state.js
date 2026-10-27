'use strict';

const { parseTime } = require('../state/scenarioEngine');
const { VERSION } = require('./parameter-registry');

const GRAPH_VERSION = '1.0';
const clone = value => JSON.parse(JSON.stringify(value));

function nonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be nonnegative and finite`);
  return value;
}

function createSimulationState(sourceGraph, sourceState, scenario, parameters) {
  const graph = clone(sourceGraph);
  const initial = clone(sourceState);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !initial.visitor || !initial.timestamp) {
    throw new TypeError('A graph and current state snapshot are required');
  }
  parseTime(initial.timestamp, 'initial state timestamp');
  const nodeIds = new Set(graph.nodes.map(node => node.node_id));
  const edgeIds = new Set(graph.edges.map(edge => edge.edge_id));
  if (nodeIds.size !== graph.nodes.length || edgeIds.size !== graph.edges.length) throw new Error('A graph has duplicate IDs');
  if (!nodeIds.has(initial.visitor.current_node_id)) throw new Error('visitor node is absent from A graph');
  const pois = {};
  for (const node of graph.nodes.filter(node => node.poi_id)) {
    if (!initial.poi_states?.[node.poi_id]) throw new Error(`missing A POI state: ${node.poi_id}`);
    const current = initial.poi_states[node.poi_id];
    const serviceRate = nonnegative(parameters.default_service_rate, 'default_service_rate');
    pois[node.poi_id] = {
      queue: Math.max(0, Math.round(nonnegative(current.queue_min, `queue_min ${node.poi_id}`) * serviceRate)),
      capacity: nonnegative(parameters.default_poi_capacity, 'default_poi_capacity'),
      service_rate: serviceRate,
      is_open: current.open !== false,
      crowd_ratio: Number(current.crowd_ratio || 0)
    };
  }
  const roads = {};
  for (const edge of graph.edges) {
    if (!initial.road_states?.[edge.edge_id]) throw new Error(`missing A road state: ${edge.edge_id}`);
    roads[edge.edge_id] = {
      is_open: initial.road_states[edge.edge_id].available !== false,
      base_travel_time_min: nonnegative(Number(edge.base_travel_time_min), `base travel time ${edge.edge_id}`),
      speed_factor: 1
    };
  }
  const events = Object.fromEntries(Object.entries(initial.event_states || {}).map(([id, event]) => [id, {
    event_id: event.event_id || id,
    node_id: event.node_id,
    start_time: event.start_time || null,
    latest_entry_time: event.latest_entry_time || null,
    end_time: event.end_time || null,
    status: event.status || 'UNKNOWN',
    cancelled: event.cancelled === true
  }]));
  const state = {
    graph_version: GRAPH_VERSION,
    schema_version: initial.schema_version || graph.schema_version || '0.1',
    scenario_id: scenario.scenario_id,
    parameter_version: VERSION,
    simulation_time: initial.timestamp,
    step_count: 0,
    environment: {
      park_population: Math.round(nonnegative(parameters.initial_park_population, 'initial_park_population')),
      arrivals_total: 0, departures_total: 0, weather: clone(initial.weather || {})
    },
    pois, roads, events,
    visitor: {
      visitor_id: initial.visitor.visitor_id,
      current_node_id: initial.visitor.current_node_id,
      remaining_time_min: nonnegative(initial.visitor.remaining_time_min, 'visitor remaining_time_min'),
      walking_speed: nonnegative(parameters.visitor_speed_range, 'walking_speed'),
      fatigue: nonnegative(initial.visitor.fatigue, 'visitor fatigue'),
      visited_poi_ids: clone(initial.visitor.visited_poi_ids || []),
      attended_event_ids: [], visited_facility_ids: [], preference: clone(initial.visitor.preference ?? null)
    }
  };
  return { graph, state };
}

module.exports = { GRAPH_VERSION, clone, createSimulationState };

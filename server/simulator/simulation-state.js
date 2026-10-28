'use strict';

const { parseTime } = require('../state/scenarioEngine');
const { addMinutes } = require('../planner/time');
const { VERSION } = require('./parameter-registry');

const GRAPH_VERSION = '1.0';
const clone = value => JSON.parse(JSON.stringify(value));

function nonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be nonnegative and finite`);
  return value;
}

function allocateQueueBudget(pois, budget) {
  const entries = Object.entries(pois);
  const rawTotal = entries.reduce((sum, [, poi]) => sum + poi.queue_count, 0);
  const target = Math.min(rawTotal, budget);
  if (!rawTotal) {
    for (const poi of Object.values(pois)) poi.queue = 0;
    return;
  }
  const ratio = target / rawTotal;
  const remainders = [];
  let assigned = 0;
  for (const [id, poi] of entries) {
    const exact = poi.queue_count * ratio;
    const base = Math.floor(exact);
    remainders.push({ id, fraction: exact - base, original: poi.queue_count });
    poi.queue_count = base;
    assigned += base;
  }
  remainders.sort((a, b) => b.fraction - a.fraction || (a.id < b.id ? -1 : 1));
  for (const item of remainders) {
    if (assigned >= target) break;
    if (pois[item.id].queue_count < item.original) {
      pois[item.id].queue_count += 1;
      assigned += 1;
    }
  }
  for (const poi of Object.values(pois)) poi.queue = poi.queue_count; // P0 read compatibility.
}

function allocateInsideBudget(pois, budget) {
  const ordered = Object.keys(pois).sort((a, b) => pois[b].crowd_ratio - pois[a].crowd_ratio || (a < b ? -1 : 1));
  let remaining = budget;
  while (remaining > 0) {
    let assigned = 0;
    for (const id of ordered) {
      if (!remaining) break;
      if (pois[id].inside_count < pois[id].capacity) {
        pois[id].inside_count += 1;
        remaining -= 1;
        assigned += 1;
      }
    }
    if (!assigned) break;
  }
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
  const entranceNodes = graph.nodes.filter(node => (node.access_roles || []).includes('PARK_ENTRANCE')).map(node => node.node_id);
  const exitNodes = graph.nodes.filter(node => (node.access_roles || []).includes('PARK_EXIT')).map(node => node.node_id);
  if (!entranceNodes.length || !exitNodes.length) throw new Error('A graph lacks a DEMO entrance or exit node');
  const entryNodeId = entranceNodes.includes(initial.visitor.current_node_id) ? initial.visitor.current_node_id : entranceNodes[0];
  const poiNodeMap = {};
  for (const node of graph.nodes.filter(node => node.poi_id)) {
    if (poiNodeMap[node.poi_id]) throw new Error(`duplicate POI node mapping: ${node.poi_id}`);
    poiNodeMap[node.poi_id] = node.node_id;
  }
  const pois = {};
  for (const node of graph.nodes.filter(node => node.poi_id)) {
    if (!initial.poi_states?.[node.poi_id]) throw new Error(`missing A POI state: ${node.poi_id}`);
    const current = initial.poi_states[node.poi_id];
    const serviceRate = nonnegative(parameters.default_service_rate, 'default_service_rate');
    pois[node.poi_id] = {
      queue_count: Math.max(0, Math.round(nonnegative(current.queue_min, `queue_min ${node.poi_id}`) * serviceRate)),
      inside_count: 0,
      capacity: nonnegative(parameters.default_poi_capacity, 'default_poi_capacity'),
      service_rate: serviceRate,
      admission_rate: nonnegative(parameters.default_admission_rate, 'default_admission_rate'),
      visit_duration_min: nonnegative(node.type === 'view' ? parameters.view_visit_duration_min
        : node.type === 'show' ? parameters.show_visit_duration_min : parameters.default_visit_duration_min,
      `visit_duration_min ${node.poi_id}`),
      inside_groups: [],
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
      speed_factor: 1,
      closed_at: initial.road_states[edge.edge_id].available === false ? initial.timestamp : null
    };
  }
  const showNodeIds = new Set(graph.nodes.filter(node => node.type === 'show').map(node => node.node_id));
  const events = Object.fromEntries(Object.entries(initial.event_states || {}).map(([id, event]) => {
    const isShow = showNodeIds.has(event.node_id) && event.status !== 'forecast'
      && event.cancelled !== true && !!event.start_time;
    const start = event.start_time || null;
    const latest = event.latest_entry_time || (isShow
      ? addMinutes(start, -parameters.default_latest_entry_offset_min) : start);
    const end = event.end_time || (isShow ? addMinutes(start, parameters.default_event_duration_min) : null);
    if (isShow && (parseTime(latest, `latest entry ${id}`) > parseTime(end, `show end ${id}`)
      || parseTime(start, `show start ${id}`) >= parseTime(end, `show end ${id}`))) {
      throw new RangeError(`invalid DEMO show time window: ${id}`);
    }
    const boardingOpen = isShow ? addMinutes(start, -parameters.event_boarding_lead_min) : null;
    const now = parseTime(initial.timestamp, 'initial timestamp');
    const phase = !isShow ? null : now >= parseTime(end, 'show end') ? 'FINISHED'
      : now >= parseTime(start, 'show start') ? 'RUNNING'
        : now >= parseTime(boardingOpen, 'boarding open') ? 'BOARDING' : 'BEFORE_ENTRY';
    return [id, {
      event_id: event.event_id || id, node_id: event.node_id,
      start_time: start, latest_entry_time: latest, end_time: end,
      end_time_basis: event.end_time ? 'BUSINESS_DEMO' : isShow ? 'DERIVED_T4' : null,
      boarding_open_time: boardingOpen,
      time_sources: isShow ? {
        boarding_start: { type: 'DERIVED_T4', parameter: 'event_boarding_lead_min' },
        latest_entry_time: event.latest_entry_time
          ? { type: 'BUSINESS_DEMO' }
          : { type: 'DERIVED_T4', parameter: 'default_latest_entry_offset_min' },
        start_time: { type: 'BUSINESS_DEMO' },
        end_time: event.end_time ? { type: 'BUSINESS_DEMO' }
          : { type: 'DERIVED_T4', parameter: 'default_event_duration_min' }
      } : null,
      status: event.status || 'UNKNOWN', cancelled: event.cancelled === true,
      is_show_event: isShow, phase,
      capacity: isShow ? nonnegative(Number(event.capacity ?? parameters.default_event_capacity), `event capacity ${id}`) : null,
      event_queue_count: isShow ? 0 : null, attending_count: isShow ? 0 : null,
      intent_created_total: 0, queue_arrivals_total: 0, admitted_total: 0,
      missed_count: 0, released_count: 0
    }];
  }));
  const initialPopulation = Math.round(nonnegative(parameters.initial_park_population, 'initial_park_population'));
  const queueFraction = nonnegative(parameters.initial_queue_fraction, 'initial_queue_fraction');
  const insideFraction = nonnegative(parameters.initial_inside_fraction, 'initial_inside_fraction');
  if (queueFraction + insideFraction > 1) throw new RangeError('initial POI fractions exceed park population');
  // A provides DEMO queue minutes, not measured people counts. Scale their relative
  // weights to a T4 population budget so the initial snapshot is conserved.
  allocateQueueBudget(pois, Math.floor(initialPopulation * queueFraction));
  allocateInsideBudget(pois, Math.floor(initialPopulation * insideFraction));
  for (const [poiId, poi] of Object.entries(pois)) {
    if (poi.inside_count) poi.inside_groups.push({ count: poi.inside_count, poi_id: poiId,
      entered_at: initial.timestamp, leave_at: addMinutes(initial.timestamp, poi.visit_duration_min) });
  }
  const queueing = Object.values(pois).reduce((sum, poi) => sum + poi.queue_count, 0);
  const insidePoi = Object.values(pois).reduce((sum, poi) => sum + poi.inside_count, 0);
  for (const poiId of Object.keys(pois)) if (!nodeIds.has(poiNodeMap[poiId])) throw new Error(`POI has no valid graph node: ${poiId}`);
  const initialWalking = initialPopulation - queueing - insidePoi;
  const state = {
    graph_version: GRAPH_VERSION,
    schema_version: initial.schema_version || graph.schema_version || '0.1',
    scenario_id: scenario.scenario_id,
    parameter_version: VERSION,
    simulation_time: initial.timestamp,
    step_count: 0,
    environment: {
      park_population: initialPopulation,
      initial_population: initialPopulation,
      arrivals_total: 0, departures_total: 0, weather: clone(initial.weather || {})
    },
    population_ledger: {
      outside: 0, walking: initialWalking,
      queueing, inside_poi: insidePoi, resting: 0, attending_event: 0, exited_total: 0
    },
    mobility_ledger: {
      entry_node_id: entryNodeId,
      exit_node_ids: exitNodes,
      poi_node_map: poiNodeMap,
      node_walkers: Object.fromEntries(graph.nodes.map(node => [node.node_id, node.node_id === entryNodeId ? initialWalking : 0])),
      pending_exit_intent: Object.fromEntries(graph.nodes.map(node => [node.node_id, 0])),
      blocked_exit_intent: Object.fromEntries(graph.nodes.map(node => [node.node_id, 0])),
      transit_groups: [], next_group_id: 1,
      exit_intent_created_total: 0, exit_completed_total: 0,
      exit_arrivals_completed_total: 0, exit_blocked_attempts_total: 0
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

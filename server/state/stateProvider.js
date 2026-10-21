const graph = require('../data/scenic_graph.json');
const initialState = require('../data/current_state.json');

const cloneState = value => JSON.parse(JSON.stringify(value));
let current = cloneState(initialState);
let revision = Number(current.state_version.split('_').pop()) || 1;
const nodeIds = new Set(graph.nodes.map(n => n.node_id));
const poiIds = new Set(graph.nodes.map(n => n.poi_id).filter(Boolean));
const edgeIds = new Set(graph.edges.map(e => e.edge_id));

function validateState(state) {
  if (!nodeIds.has(state.visitor.current_node_id)) throw new Error('Unknown visitor current_node_id');
  for (const id of poiIds) if (!state.poi_states[id]) throw new Error(`Missing poi_id: ${id}`);
  for (const id of edgeIds) if (!state.road_states[id]) throw new Error(`Missing edge_id: ${id}`);
  for (const id of state.visitor.visited_poi_ids) if (!poiIds.has(id)) throw new Error(`Unknown visited poi_id: ${id}`);
  for (const id of Object.keys(state.poi_states)) if (!poiIds.has(id)) throw new Error(`Unknown poi_id: ${id}`);
  for (const id of Object.keys(state.road_states)) if (!edgeIds.has(id)) throw new Error(`Unknown edge_id: ${id}`);
  for (const event of Object.values(state.event_states)) {
    if (!nodeIds.has(event.node_id)) throw new Error(`Unknown event node_id: ${event.node_id}`);
  }
}

function getScenicGraph() { return cloneState(graph); }
function getState(timestamp, visitorId) {
  const parse = value => Date.parse(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'));
  if (timestamp !== undefined && (typeof timestamp !== 'string' || Number.isNaN(parse(timestamp)) || parse(timestamp) !== parse(current.timestamp))) throw new RangeError('Historical state timestamp is unavailable');
  if (visitorId !== undefined && visitorId !== current.visitor.visitor_id) throw new RangeError(`Unknown visitor_id: ${visitorId}`);
  return cloneState(current);
}
function setState(next) {
  const copy = cloneState(next);
  validateState(copy);
  copy.schema_version = current.schema_version;
  copy.scenario_id = current.scenario_id;
  copy.state_version = `state_${String(++revision).padStart(4, '0')}`;
  current = copy;
  return getState();
}

function getLegacyGraph() {
  return {
    nodes: graph.nodes.map(n => ({ id: n.id, name: n.name, type: n.type, x: n.algorithm_x, y: n.algorithm_y, capacity: n.capacity, shade: n.shade, tags: cloneState(n.tags) })),
    edges: graph.edges.map(e => [e.from_node_id, e.to_node_id, e.distance_m, e.base_travel_time_min, e.shade])
  };
}
function getLegacyState() {
  const s = getState();
  const minute = new Date(s.timestamp.replace(' ', 'T') + 'Z').getUTCHours() * 60 + new Date(s.timestamp.replace(' ', 'T') + 'Z').getUTCMinutes();
  const crowd = { ...s.legacy_crowd }, queues = { ...s.legacy_queues };
  for (const [id, poi] of Object.entries(s.poi_states)) { crowd[id] = poi.crowd_ratio; queues[id] = poi.queue_min; }
  const events = Object.values(s.event_states).map(e => ({ id: e.event_id, title: e.title || e.event_type || '景区事件', at: e.start_time ? e.start_time.slice(11, 16) : '刚刚', node: e.node_id, status: e.status, capacity: e.capacity }));
  return { minute, weather: s.weather, crowd, queues, events, user: { location: s.visitor.current_node_id, remainingMinutes: s.visitor.remaining_time_min, visited: s.visitor.visited_poi_ids, walked: s.visitor.walked_distance_m, load: s.visitor.fatigue, preference: s.visitor.preference }, feedback: s.feedback || [] };
}
function setLegacyState(legacy) {
  const next = getState();
  const day = next.timestamp.slice(0, 10);
  next.timestamp = `${day} ${String(Math.floor(legacy.minute / 60) % 24).padStart(2, '0')}:${String(legacy.minute % 60).padStart(2, '0')}:00`;
  next.weather = cloneState(legacy.weather);
  next.legacy_crowd = Object.fromEntries(Object.entries(legacy.crowd).filter(([id]) => !poiIds.has(id)));
  next.legacy_queues = Object.fromEntries(Object.entries(legacy.queues).filter(([id]) => !poiIds.has(id)));
  for (const [id, poi] of Object.entries(next.poi_states)) {
    poi.queue_min = legacy.queues[id] || 0;
    poi.crowd_ratio = legacy.crowd[id] || 0;
    poi.crowd_level = poi.crowd_ratio >= .7 ? 'HIGH' : poi.crowd_ratio >= .4 ? 'MEDIUM' : 'LOW';
  }
  Object.assign(next.visitor, { current_node_id: legacy.user.location, remaining_time_min: legacy.user.remainingMinutes, visited_poi_ids: cloneState(legacy.user.visited), walked_distance_m: legacy.user.walked, fatigue: legacy.user.load, preference: cloneState(legacy.user.preference) });
  next.feedback = cloneState(legacy.feedback);
  return setState(next);
}
module.exports = { getScenicGraph, getState, getLegacyGraph, getLegacyState, setState, setLegacyState, cloneState };

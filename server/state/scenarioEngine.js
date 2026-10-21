const scenarios = require('../data/scenarios.json');
const { getScenicGraph, cloneState } = require('./stateProvider');
const graph = getScenicGraph();
const pois = new Set(graph.nodes.map(n => n.poi_id).filter(Boolean));
const edges = new Set(graph.edges.map(e => e.edge_id));

function parseTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{3}Z|Z)?$/.test(value)) throw new TypeError(`Invalid ${label}`);
  const normalized = value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z');
  const time = Date.parse(normalized);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 19) !== normalized.slice(0, 19)) throw new TypeError(`Invalid ${label}`);
  return time;
}
const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function applyScenarioEvent(state, event) {
  if (!event || !scenarios[event.event_type] || event.event_type === 'NORMAL') throw new TypeError('Unsupported event_type');
  const type = event.event_type, config = scenarios[type];
  const target = event.target_id || config.target_id;
  if ((type === 'QUEUE_SPIKE' || type === 'POI_CLOSE') && !pois.has(target)) throw new RangeError(`Unknown poi_id: ${target}`);
  if (type.startsWith('ROAD_') && !edges.has(target)) throw new RangeError(`Unknown edge_id: ${target}`);
  const next = cloneState(state);
  const base = parseTime(next.timestamp, 'state timestamp');
  const start = event.timestamp ? parseTime(event.timestamp, 'timestamp') : base + (config.start_offset_min || 0) * 60000;
  const duration = event.duration_min === undefined ? config.duration_min : Number(event.duration_min);
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Invalid duration_min');
  const end = event.end_time ? parseTime(event.end_time, 'end_time') : start + duration * 60000;
  if (end < start) throw new RangeError('end_time precedes timestamp');
  const severity = event.severity || 'high';
  const multiplier = severity === 'low' ? .5 : severity === 'medium' ? .75 : 1;
  const records = next.scenario_events || [];
  const record = { event_id: `scenario_${String(records.length + 1).padStart(4, '0')}`, event_type: type, target_id: target, timestamp: stamp(start), end_time: stamp(end), severity, multiplier };
  records.push(record);
  next.scenario_events = records;
  if (start <= base && base < end) {
    if (type === 'QUEUE_SPIKE') {
      const poi = next.poi_states[target];
      poi.queue_min = Math.round((poi.queue_min + config.queue_increase_min * multiplier) * 100) / 100;
      poi.crowd_ratio = Math.min(.98, poi.crowd_ratio + config.crowd_increase * multiplier);
      poi.crowd_level = poi.crowd_ratio >= .7 ? 'HIGH' : poi.crowd_ratio >= .4 ? 'MEDIUM' : 'LOW';
    }
    if (type === 'ROAD_CLOSE') next.road_states[target].available = false;
    if (type === 'ROAD_SLOWDOWN') next.road_states[target].travel_time_min *= config.travel_time_multiplier;
  }
  return next;
}
module.exports = { applyScenarioEvent, parseTime, stamp };

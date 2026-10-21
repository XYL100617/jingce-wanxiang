'use strict';

function timestampFromMinute(minute, offset = 0) {
  const total = Number(minute || 0) + Number(offset || 0);
  const hour = Math.floor(total / 60) % 24;
  const min = total % 60;
  return `2026-10-20 ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

function eventTimestamp(clock, fallbackMinute) {
  if (!/^\d{2}:\d{2}$/.test(clock || '')) return timestampFromMinute(fallbackMinute);
  return `2026-10-20 ${clock}:00`;
}

function preferredCategories(preference = {}) {
  return [
    ['历史文化', Number(preference.culture || 0)],
    ['自然', Number(preference.freedom || 0)],
    ['演出', Number(preference.performance || preference.interest || 0)],
    ['美食', Number(preference.food || 0)],
    ['舒适', Number(preference.comfort || 0)]
  ].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
}

function buildLivePlannerScenario(sourceGraph, sourceState) {
  const schema_version = '0.1';
  const scenario_id = 'live_demo_001';
  const now = timestampFromMinute(sourceState.minute);
  const showNodeIds = new Set(sourceGraph.nodes.filter(node => node.type === 'show').map(node => node.id));
  const activeEvents = (sourceState.events || []).filter(event => event.status !== 'forecast' && showNodeIds.has(event.node));
  const eventNodeIds = new Set(activeEvents.map(event => event.node));
  const nodes = sourceGraph.nodes.map(node => ({ node_id: node.id, node_type: node.type, algorithm_x: node.x, algorithm_y: node.y }));
  const edges = sourceGraph.edges.map(([from, to, distance, minutes], index) => ({
    edge_id: `edge_${index}_${from}_${to}`,
    from_node_id: from,
    to_node_id: to,
    distance_m: distance,
    base_travel_time_min: minutes,
    bidirectional: true
  }));
  const pois = sourceGraph.nodes
    .filter(node => !['gate', 'service'].includes(node.type) && !eventNodeIds.has(node.id))
    .map(node => ({
      poi_id: node.id,
      node_id: node.id,
      category: (node.tags || []).includes('美食') || (node.tags || []).includes('市集') ? '美食' : node.type === 'culture' ? '历史文化' : node.type === 'scenery' || node.type === 'view' ? '自然' : node.type === 'show' ? '演出' : '综合',
      tags: node.tags || [],
      open_time: '2026-10-20 09:00:00',
      close_time: '2026-10-20 18:00:00',
      visit_duration_min: node.type === 'view' ? 15 : node.type === 'show' ? 30 : 22,
      base_utility: node.type === 'culture' ? 27 : node.type === 'show' ? 32 : node.type === 'view' ? 24 : 22,
      comfort_score: Number(node.shade || .5),
      shade_score: Number(node.shade || .5)
    }));
  const events = activeEvents.map(event => {
    const parsedStart = /^\d{2}:\d{2}$/.test(event.at || '')
      ? Number(event.at.slice(0, 2)) * 60 + Number(event.at.slice(3, 5))
      : sourceState.minute + 60;
    return {
      event_id: event.id,
      node_id: event.node,
      category: '演出',
      tags: ['演出', '预约'],
      start_time: eventTimestamp(event.at, parsedStart),
      latest_entry_time: timestampFromMinute(parsedStart - 5),
      end_time: timestampFromMinute(parsedStart + 30),
      duration_min: 30,
      base_utility: 38
    };
  });
  const facilities = sourceGraph.nodes.filter(node => node.type === 'service').map(node => ({
    facility_id: node.id, node_id: node.id, facility_type: 'rest', rest_duration_min: 15, min_fatigue: 0.38, base_utility: 7
  }));
  const exits = sourceGraph.nodes.filter(node => node.type === 'gate').map(node => ({ exit_id: `exit_${node.id}`, node_id: node.id }));
  const graph = { schema_version, scenario_id, nodes, edges, pois, events, facilities, exits };
  const state = {
    schema_version,
    scenario_id,
    state_version: `state_${sourceState.minute}_${sourceState.events.length}`,
    timestamp: now,
    visitor: {
      visitor_id: 'visitor_001',
      current_node_id: sourceState.user.location,
      remaining_time_min: sourceState.user.remainingMinutes,
      fatigue: sourceState.user.load,
      visited_poi_ids: sourceState.user.visited || [],
      attended_event_ids: [],
      visited_facility_ids: [],
      preferred_categories: preferredCategories(sourceState.user.preference || {}),
      preference_weights: sourceState.user.preference || {},
      preference_profile: sourceState.user.preferenceProfile || null,
      current_plan_next_target: sourceState.user.currentPlanNextTarget || null,
      require_rest: sourceState.user.preferenceProfile?.constraints?.require_rest === true
    },
    poi_states: Object.fromEntries(pois.map(poi => [poi.poi_id, {
      is_open: !(sourceState.closedPois || []).includes(poi.poi_id),
      current_queue_min: Number(sourceState.queues[poi.poi_id] || 0),
      crowd_level: Math.ceil(Number(sourceState.crowd[poi.poi_id] || 0) * 4)
    }])),
    road_states: Object.fromEntries(edges.map(edge => [edge.edge_id, { available: !(sourceState.closedRoads || []).includes(edge.edge_id), travel_time_min: edge.base_travel_time_min }])),
    event_states: Object.fromEntries(events.map(event => [event.event_id, { is_open: true, cancelled: (sourceState.cancelledEvents || []).includes(event.event_id) }]))
  };
  const offsets = [0, 15, 30, 60];
  const forecast = {
    schema_version,
    scenario_id,
    forecast_version: `forecast_${sourceState.minute}_${sourceState.events.length}`,
    base_timestamp: now,
    horizon_min: 60,
    step_min: 15,
    poi_predictions: Object.fromEntries(pois.map(poi => {
      const baseQueue = Number(sourceState.queues[poi.poi_id] || 0);
      const crowd = Number(sourceState.crowd[poi.poi_id] || 0);
      const hasLiveEvent = (sourceState.events || []).some(event => event.node === poi.poi_id && event.status === 'live');
      return [poi.poi_id, offsets.map(offset => ({
        timestamp: timestampFromMinute(sourceState.minute, offset),
        queue_min: Math.round((baseQueue + crowd * offset / 7 + (hasLiveEvent ? offset / 3 : 0)) * 10) / 10,
        crowd_level: Math.min(4, Math.ceil((crowd + offset / 500) * 4))
      }))];
    })),
    road_predictions: Object.fromEntries(edges.map(edge => {
      const crowd = (Number(sourceState.crowd[edge.from_node_id] || 0) + Number(sourceState.crowd[edge.to_node_id] || 0)) / 2;
      return [edge.edge_id, offsets.map(offset => ({
        timestamp: timestampFromMinute(sourceState.minute, offset),
        travel_time_min: Math.round(edge.base_travel_time_min * (1 + crowd * 0.22 + offset / 1200) * 10) / 10,
        available: !(sourceState.closedRoads || []).includes(edge.edge_id)
      }))];
    }))
  };
  return { graph, state, forecast };
}

module.exports = { buildLivePlannerScenario };

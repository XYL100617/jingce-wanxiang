'use strict';

const { addMinutes } = require('./time');

function preferredCategories(preference = {}) {
  return [
    ['历史文化', Number(preference.culture || 0)],
    ['自然', Number(preference.nature || preference.freedom || 0)],
    ['演出', Number(preference.performance || preference.interest || 0)],
    ['美食', Number(preference.food || 0)],
    ['舒适', Number(preference.comfort || 0)]
  ].sort((a, b) => b[1] - a[1]).slice(0, 2).map(item => item[0]);
}

function buildLivePlannerScenario(sourceGraph, sourceState, runtimeUser = {}, sourceForecast = null) {
  const schema_version = sourceState.schema_version || sourceGraph.schema_version || '0.1';
  const scenario_id = sourceState.scenario_id || sourceGraph.scenario_id || 'live_demo';
  const nodesById = new Map((sourceGraph.nodes || []).map(node => [node.node_id || node.id, node]));
  const eventEntries = Object.entries(sourceState.event_states || {});
  const activeEvents = eventEntries
    .map(([id, event]) => ({ ...event, event_id: event.event_id || id }))
    .filter(event => event.status !== 'forecast' && event.cancelled !== true && nodesById.get(event.node_id)?.type === 'show');
  const eventNodeIds = new Set(activeEvents.map(event => event.node_id));
  const nodes = (sourceGraph.nodes || []).map(node => ({
    node_id: node.node_id || node.id,
    node_type: node.type,
    algorithm_x: node.algorithm_x ?? node.x ?? 0,
    algorithm_y: node.algorithm_y ?? node.y ?? 0
  }));
  const edges = (sourceGraph.edges || []).map(edge => ({
    edge_id: edge.edge_id,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    distance_m: edge.distance_m,
    base_travel_time_min: edge.base_travel_time_min,
    shade: edge.shade,
    bidirectional: edge.direction === 'BIDIRECTIONAL' || edge.bidirectional === true
  }));
  const pois = (sourceGraph.nodes || [])
    .filter(node => node.poi_id && node.type !== 'service' && !eventNodeIds.has(node.node_id || node.id))
    .map(node => {
      const poiId = node.poi_id;
      const startTime = sourceState.timestamp.slice(0, 10) + ' 09:00:00';
      const closeTime = sourceState.timestamp.slice(0, 10) + ' 18:00:00';
      return {
        poi_id: poiId,
        node_id: node.node_id || node.id,
        category: (node.tags || []).some(tag => ['美食', '市集'].includes(tag)) ? '美食'
          : node.type === 'culture' ? '历史文化'
            : node.type === 'scenery' || node.type === 'view' ? '自然'
              : node.type === 'show' ? '演出' : '综合',
        tags: node.tags || [],
        open_time: startTime,
        close_time: closeTime,
        visit_duration_min: node.type === 'view' ? 15 : node.type === 'show' ? 30 : 22,
        base_utility: node.type === 'culture' ? 27 : node.type === 'show' ? 32 : node.type === 'view' ? 24 : 22,
        comfort_score: Number(node.shade || 0.5),
        shade_score: Number(node.shade || 0.5)
      };
    });
  const events = activeEvents.map(event => {
    const start = event.start_time || sourceState.timestamp;
    const latestEntry = event.latest_entry_time || addMinutes(start, -5);
    return {
      event_id: event.event_id,
      node_id: event.node_id,
      category: '演出',
      tags: ['演出', '预约'],
      start_time: start,
      latest_entry_time: latestEntry,
      end_time: event.end_time || addMinutes(start, 30),
      duration_min: Math.max(1, Number(event.duration_min || 30)),
      base_utility: 38
    };
  });
  const facilities = (sourceGraph.nodes || []).filter(node => node.type === 'service').map(node => ({
    facility_id: node.poi_id || node.node_id || node.id,
    node_id: node.node_id || node.id,
    facility_type: 'rest',
    rest_duration_min: 15,
    min_fatigue: 0.38,
    base_utility: 7
  }));
  const exits = (sourceGraph.nodes || [])
    .filter(node => (node.access_roles || []).includes('PARK_EXIT') || node.type === 'gate')
    .map(node => ({ exit_id: `exit_${node.node_id || node.id}`, node_id: node.node_id || node.id }));
  const graph = { schema_version, scenario_id, nodes, edges, pois, events, facilities, exits };
  const profile = runtimeUser.preferenceProfile || null;
  const weights = profile?.weights || sourceState.visitor.preference || {};
  const state = {
    schema_version,
    scenario_id,
    state_version: sourceState.state_version,
    timestamp: sourceState.timestamp,
    visitor: {
      visitor_id: sourceState.visitor.visitor_id,
      current_node_id: sourceState.visitor.current_node_id,
      remaining_time_min: sourceState.visitor.remaining_time_min,
      fatigue: sourceState.visitor.fatigue,
      visited_poi_ids: sourceState.visitor.visited_poi_ids || [],
      attended_event_ids: [],
      visited_facility_ids: [],
      preferred_categories: preferredCategories(weights),
      preference_weights: weights,
      preference_profile: profile,
      current_plan_next_target: runtimeUser.currentPlanNextTarget || null,
      require_rest: profile?.constraints?.require_rest === true
    },
    poi_states: Object.fromEntries(pois.map(poi => {
      const current = sourceState.poi_states?.[poi.poi_id] || {};
      return [poi.poi_id, {
        is_open: current.open !== false,
        current_queue_min: Number(current.queue_min || 0),
        crowd_level: Math.max(0, Math.min(4, Math.ceil(Number(current.crowd_ratio || 0) * 4)))
      }];
    })),
    road_states: Object.fromEntries(edges.map(edge => {
      const current = sourceState.road_states?.[edge.edge_id] || {};
      return [edge.edge_id, { available: current.available !== false, travel_time_min: Number(current.travel_time_min || edge.base_travel_time_min) }];
    })),
    event_states: Object.fromEntries(events.map(event => {
      const original = sourceState.event_states?.[event.event_id] || {};
      return [event.event_id, { is_open: original.status !== 'cancelled', cancelled: original.cancelled === true || original.status === 'cancelled' }];
    }))
  };
  const forecast = sourceForecast || {
    schema_version,
    scenario_id,
    forecast_version: `forecast_${sourceState.state_version}`,
    base_timestamp: sourceState.timestamp,
    horizon_min: 60,
    step_min: 15,
    poi_predictions: {},
    road_predictions: {}
  };
  const plannerForecast = {
    ...forecast,
    poi_predictions: Object.fromEntries(pois.map(poi => [poi.poi_id, (forecast.poi_predictions?.[poi.poi_id] || []).map(point => ({
      timestamp: point.timestamp,
      queue_min: point.queue_min,
      crowd_level: Math.max(0, Math.min(4, Math.ceil(Number(point.crowd_ratio || 0) * 4)))
    }))])),
    road_predictions: Object.fromEntries(edges.map(edge => [edge.edge_id, (forecast.road_predictions?.[edge.edge_id] || []).map(point => ({
      timestamp: point.timestamp,
      travel_time_min: point.travel_time_min,
      available: point.available
    }))]))
  };
  return { graph, state, forecast: plannerForecast };
}

module.exports = { buildLivePlannerScenario };

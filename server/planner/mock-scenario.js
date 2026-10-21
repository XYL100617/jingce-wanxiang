'use strict';

function createMockScenario(variant = 'normal') {
  const schema_version = '0.1';
  const scenario_id = `b_${variant}_001`;
  const graph = {
    schema_version, scenario_id,
    nodes: [
      { node_id: 'node_gate', node_type: 'entrance', algorithm_x: 0, algorithm_y: 0 },
      { node_id: 'node_history', node_type: 'poi', algorithm_x: 8, algorithm_y: 0 },
      { node_id: 'node_garden', node_type: 'poi', algorithm_x: 4, algorithm_y: 5 },
      { node_id: 'node_theater', node_type: 'event', algorithm_x: 10, algorithm_y: 6 },
      { node_id: 'node_rest', node_type: 'facility', algorithm_x: 6, algorithm_y: 3 },
      { node_id: 'node_exit', node_type: 'exit', algorithm_x: 0, algorithm_y: 2 }
    ],
    edges: [
      { edge_id: 'edge_gate_history', from_node_id: 'node_gate', to_node_id: 'node_history', distance_m: 500, base_travel_time_min: 8, bidirectional: true },
      { edge_id: 'edge_gate_garden', from_node_id: 'node_gate', to_node_id: 'node_garden', distance_m: 380, base_travel_time_min: 6, bidirectional: true },
      { edge_id: 'edge_history_garden', from_node_id: 'node_history', to_node_id: 'node_garden', distance_m: 300, base_travel_time_min: 5, bidirectional: true },
      { edge_id: 'edge_garden_theater', from_node_id: 'node_garden', to_node_id: 'node_theater', distance_m: 420, base_travel_time_min: 7, bidirectional: true },
      { edge_id: 'edge_history_rest', from_node_id: 'node_history', to_node_id: 'node_rest', distance_m: 250, base_travel_time_min: 4, bidirectional: true },
      { edge_id: 'edge_rest_theater', from_node_id: 'node_rest', to_node_id: 'node_theater', distance_m: 300, base_travel_time_min: 5, bidirectional: true },
      { edge_id: 'edge_gate_exit', from_node_id: 'node_gate', to_node_id: 'node_exit', distance_m: 120, base_travel_time_min: 2, bidirectional: true },
      { edge_id: 'edge_garden_exit', from_node_id: 'node_garden', to_node_id: 'node_exit', distance_m: 420, base_travel_time_min: 7, bidirectional: true },
      { edge_id: 'edge_rest_exit', from_node_id: 'node_rest', to_node_id: 'node_exit', distance_m: 360, base_travel_time_min: 6, bidirectional: true }
    ],
    pois: [
      { poi_id: 'poi_history', node_id: 'node_history', category: '历史文化', tags: ['室内'], open_time: '2026-10-20 09:00:00', close_time: '2026-10-20 17:30:00', visit_duration_min: 24, base_utility: 31 },
      { poi_id: 'poi_garden', node_id: 'node_garden', category: '自然', tags: ['拍照'], open_time: '2026-10-20 09:00:00', close_time: '2026-10-20 18:00:00', visit_duration_min: 20, base_utility: 24 }
    ],
    events: [
      { event_id: 'event_show', node_id: 'node_theater', category: '演出', tags: ['预约'], start_time: '2026-10-20 11:10:00', latest_entry_time: '2026-10-20 11:05:00', end_time: '2026-10-20 11:40:00', duration_min: 30, base_utility: 36 }
    ],
    facilities: [{ facility_id: 'facility_rest', node_id: 'node_rest', facility_type: 'rest', rest_duration_min: 15, base_utility: 6 }],
    exits: [{ exit_id: 'exit_main', node_id: 'node_exit' }]
  };
  const state = {
    schema_version, scenario_id, state_version: 'state_0001', timestamp: '2026-10-20 10:00:00',
    visitor: {
      visitor_id: 'visitor_001', current_node_id: 'node_gate', remaining_time_min: 150, fatigue: 0.18,
      visited_poi_ids: [], attended_event_ids: [], visited_facility_ids: [], preferred_categories: ['历史文化', '演出'],
      cumulative_walk_min: 0, cumulative_queue_min: 0
    },
    poi_states: {
      poi_history: { is_open: true, current_queue_min: 2, crowd_level: 1 },
      poi_garden: { is_open: true, current_queue_min: 4, crowd_level: 2 }
    },
    road_states: Object.fromEntries(graph.edges.map(edge => [edge.edge_id, { available: true, travel_time_min: edge.base_travel_time_min }])),
    event_states: { event_show: { is_open: true, cancelled: false } }
  };
  const at = (minutes, values) => ({ timestamp: `2026-10-20 10:${String(minutes).padStart(2, '0')}:00`, ...values });
  const historyQueues = variant === 'queue_surge'
    ? [at(0, { queue_min: 2 }), at(10, { queue_min: 48 }), at(20, { queue_min: 55 }), at(40, { queue_min: 60 })]
    : [at(0, { queue_min: 2 }), at(10, { queue_min: 3 }), at(20, { queue_min: 4 }), at(40, { queue_min: 5 })];
  const forecast = {
    schema_version, scenario_id, forecast_version: `forecast_${variant}_0001`, base_timestamp: state.timestamp, horizon_min: 90, step_min: 10,
    poi_predictions: {
      poi_history: historyQueues,
      poi_garden: [at(0, { queue_min: 5 }), at(10, { queue_min: 5 }), at(20, { queue_min: 6 }), at(40, { queue_min: 8 })]
    },
    road_predictions: Object.fromEntries(graph.edges.map(edge => [edge.edge_id, [
      at(0, { travel_time_min: edge.base_travel_time_min, available: true }),
      at(40, { travel_time_min: edge.base_travel_time_min, available: true })
    ]]))
  };
  if (variant === 'road_closure') {
    state.road_states.edge_gate_garden.available = false;
    forecast.road_predictions.edge_gate_garden = [at(0, { travel_time_min: 6, available: false }), at(40, { travel_time_min: 6, available: false })];
  }
  return { graph, state, forecast };
}

module.exports = { createMockScenario };

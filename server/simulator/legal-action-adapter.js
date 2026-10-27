'use strict';

const { buildLivePlannerScenario } = require('../planner/live-adapter');
const { getLegalActions } = require('../planner/rules');

function toVisibleState(simulationState) {
  const poi_states = Object.fromEntries(Object.entries(simulationState.pois).map(([id, poi]) => [id, {
    open: poi.is_open,
    queue_min: poi.service_rate > 0 ? Math.round(poi.queue / poi.service_rate * 10) / 10 : 0,
    crowd_ratio: poi.crowd_ratio
  }]));
  const road_states = Object.fromEntries(Object.entries(simulationState.roads).map(([id, road]) => [id, {
    available: road.is_open,
    travel_time_min: Math.round(road.base_travel_time_min / road.speed_factor * 100) / 100
  }]));
  const event_states = Object.fromEntries(Object.entries(simulationState.events).map(([id, event]) => [id, { ...event }]));
  return {
    schema_version: simulationState.schema_version,
    scenario_id: simulationState.scenario_id,
    state_version: `simulation_p0_${simulationState.step_count}`,
    timestamp: simulationState.simulation_time,
    visitor: {
      visitor_id: simulationState.visitor.visitor_id,
      current_node_id: simulationState.visitor.current_node_id,
      remaining_time_min: simulationState.visitor.remaining_time_min,
      fatigue: simulationState.visitor.fatigue,
      visited_poi_ids: [...simulationState.visitor.visited_poi_ids],
      attended_event_ids: [...simulationState.visitor.attended_event_ids],
      visited_facility_ids: [...simulationState.visitor.visited_facility_ids],
      preference: simulationState.visitor.preference
    },
    poi_states, road_states, event_states
  };
}

function evaluateLegalActions(graph, simulationState, rules = {}) {
  // P0 observation is the current visible projection, with no noise or missingness.
  // Population, RNG state, future events and latent queues in people never enter C.
  const observed = toVisibleState(simulationState);
  const planner = buildLivePlannerScenario(graph, observed, {}, null);
  const result = getLegalActions({ graph: planner.graph, state: planner.state, forecast: planner.forecast, rules });
  return { ...result, planner_graph: planner.graph, observation: observed, adapter_defaults: 'server/planner/live-adapter.js DEMO/T4' };
}

module.exports = { toVisibleState, evaluateLegalActions };

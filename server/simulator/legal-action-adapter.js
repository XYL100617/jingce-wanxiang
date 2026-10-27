'use strict';

const { buildLivePlannerScenario } = require('../planner/live-adapter');
const { getLegalActions } = require('../planner/rules');
const { resolveObservationParameters } = require('./parameter-registry');

function toVisibleState(simulationState) {
  // Used only by B's internal movement router with authoritative road state.
  // Planner-facing legal actions use buildPlannerView(observation) below.
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

function buildPlannerView(graph, observation, parameters = resolveObservationParameters()) {
  if (!observation || observation.synthetic !== true || !observation.pois || !observation.roads) {
    throw new TypeError('available observation is required for planner view');
  }
  const fallbacks = { unknown_poi_queue_ids: [], unknown_poi_crowd_ids: [],
    unknown_road_travel_time_ids: [], source_tier: 'T4', parameter_basis: 'ASSUMPTION' };
  const poi_states = Object.fromEntries(Object.entries(observation.pois).map(([id, poi]) => {
    if (poi.queue_time_min === null) fallbacks.unknown_poi_queue_ids.push(id);
    if (poi.crowd_ratio === null) fallbacks.unknown_poi_crowd_ids.push(id);
    return [id, { open: poi.is_open,
      queue_min: poi.queue_time_min ?? parameters.unknown_queue_fallback_min,
      crowd_ratio: poi.crowd_ratio ?? parameters.unknown_crowd_fallback_ratio }];
  }));
  const graphEdges = new Map(graph.edges.map(edge => [edge.edge_id, edge]));
  const road_states = Object.fromEntries(Object.entries(observation.roads).map(([id, road]) => {
    const edge = graphEdges.get(id);
    if (!edge) throw new Error(`observation road is absent from graph: ${id}`);
    if (road.travel_time_min === null) fallbacks.unknown_road_travel_time_ids.push(id);
    const graphTravelTime = Number(edge.base_travel_time_min);
    if (!Number.isFinite(graphTravelTime) || graphTravelTime < 0) {
      throw new Error(`invalid DEMO road fallback: ${id}`);
    }
    return [id, { available: road.is_open,
      travel_time_min: road.travel_time_min ?? graphTravelTime }];
  }));
  return { view: {
    schema_version: observation.schema_version,
    scenario_id: observation.scenario_id,
    state_version: `observation_${observation.observation_version}_${observation.timestamp}`,
    timestamp: observation.timestamp,
    visitor: observation.visitor,
    poi_states, road_states, event_states: observation.events
  }, fallbacks };
}

function evaluateLegalActions(graph, observation, rules = {}, parameters = resolveObservationParameters()) {
  const { view, fallbacks } = buildPlannerView(graph, observation, parameters);
  const planner = buildLivePlannerScenario(graph, view, {}, null);
  const result = getLegalActions({ graph: planner.graph, state: planner.state, forecast: planner.forecast, rules });
  return { ...result, planner_graph: planner.graph, observation,
    planner_view_fallbacks: fallbacks, adapter_defaults: 'server/planner/live-adapter.js DEMO/T4' };
}

module.exports = { toVisibleState, buildPlannerView, evaluateLegalActions };

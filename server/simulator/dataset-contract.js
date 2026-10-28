'use strict';

const { toMillis } = require('../planner/time');
const { VISITOR_STATE_FIELDS } = require('./episode-writer');

const DATASET_SCHEMA_VERSION = 'dataset-p1.1';
const HORIZONS = Object.freeze({ target_5: 1, target_15: 3, target_30: 6, target_60: 12 });
const clone = value => JSON.parse(JSON.stringify(value));
const check = (condition, message) => {
  if (!condition) throw new Error(`INVALID_DATASET: ${message}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const FUTURE_KEYS = new Set(['reward', 'latent_target', 'transition_audit', 'actual_route',
  'completion_event', 'missed_event', 'future_event', 'next_observation',
  'next_visitor_state']);
const LATENT_KEYS = new Set(['environment_state', 'population_ledger', 'mobility_ledger',
  'park_population', 'occupancy', 'congestion_multiplier', 'actual_route']);
function rejectFutureKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    check(!FUTURE_KEYS.has(key), `future field in model input: ${key}`);
    rejectFutureKeys(child);
  }
}

function projectDecisionRoles(sample) {
  const { observation, visitor_state, legal_actions, chosen_action, delta_t_min } = sample.input;
  return clone({ POLICY_INPUT: { observation, visitor_state, legal_actions },
    ACTION_LABEL: { chosen_action },
    TRANSITION_MODEL_INPUT: { observation, visitor_state, chosen_action, delta_t_min },
    TARGET: sample.target, AUDIT: sample.audit, METADATA: sample.metadata });
}

function projectEnvironmentRoles(sample) {
  return clone({ OBSERVED_INPUT: sample.observed_input,
    LATENT_CURRENT: sample.latent_current, FUTURE_TARGET: sample.future_target,
    AUDIT: sample.audit, METADATA: sample.metadata });
}

function projectEnvironment(state) {
  return clone({ timestamp: state.simulation_time,
    pois: Object.fromEntries(Object.entries(state.pois).map(([id, poi]) => [id,
      { queue_count: poi.queue_count, crowd_ratio: poi.crowd_ratio, is_open: poi.is_open }])),
    roads: Object.fromEntries(Object.entries(state.roads).map(([id, road]) => [id,
      { travel_time_min: road.effective_travel_time_min,
        congestion_multiplier: road.congestion_multiplier, occupancy: road.occupancy,
        reference_capacity: road.reference_capacity, is_open: road.is_open }])),
    events: Object.fromEntries(Object.entries(state.events).filter(([, event]) => event.is_show_event)
      .map(([id, event]) => [id, { phase: event.phase, status: event.status,
        event_queue_count: event.event_queue_count, attending_count: event.attending_count }])),
    population: { park_population: state.environment.park_population,
      initial_population: state.environment.initial_population,
      arrivals_total: state.environment.arrivals_total,
      departures_total: state.environment.departures_total,
      ledger: state.population_ledger },
    weather: state.environment.weather });
}

function occupancyAudit(state) {
  const expected = Object.fromEntries(Object.keys(state.roads).map(id => [id, 0]));
  for (const group of state.mobility_ledger.transit_groups) {
    if (group.current_edge_id) expected[group.current_edge_id] += group.count;
  }
  return expected;
}

function checkFinite(value) {
  if (typeof value === 'number') check(Number.isFinite(value), 'NaN or Infinity');
  else if (value && typeof value === 'object') for (const child of Object.values(value)) checkFinite(child);
}

function validateEnvironmentState(state, expectedOccupancy) {
  check(state && state.population && state.pois && state.roads, 'environment state fields');
  const p = state.population;
  check(Number.isSafeInteger(p.park_population) && p.park_population >= 0
    && p.initial_population + p.arrivals_total - p.departures_total === p.park_population,
  'population conservation');
  check(['walking', 'queueing', 'inside_poi', 'resting', 'attending_event']
    .reduce((sum, key) => sum + p.ledger[key], 0) === p.park_population,
  'population ledger conservation');
  for (const poi of Object.values(state.pois)) check(Number.isSafeInteger(poi.queue_count)
    && poi.queue_count >= 0 && Number.isFinite(poi.crowd_ratio), 'POI queue/crowd');
  for (const event of Object.values(state.events)) check(Number.isSafeInteger(event.event_queue_count)
    && event.event_queue_count >= 0 && Number.isSafeInteger(event.attending_count)
    && event.attending_count >= 0, 'event counts');
  for (const [id, road] of Object.entries(state.roads)) {
    check(Number.isSafeInteger(road.occupancy) && road.occupancy >= 0
      && road.reference_capacity > 0 && road.travel_time_min > 0
      && road.congestion_multiplier >= 1, 'road metrics');
    if (expectedOccupancy) check(road.occupancy === expectedOccupancy[id],
      `edge occupancy conservation: ${id}`);
  }
}

function validateMetadata(metadata) {
  check(metadata && metadata.source_tier === 'T4' && metadata.synthetic === true,
    'T4 synthetic provenance');
  for (const key of ['scenario_instance_id', 'seed', 'graph_version', 'simulator_version',
    'parameter_version', 'scenario_parameter_version', 'observation_version',
    'reward_version', 'episode_schema_version', 'visitor_profile_version']) {
    check(metadata[key] !== null && metadata[key] !== undefined, `missing provenance: ${key}`);
  }
}

function validateDecisionDataset(dataset) {
  check(dataset?.dataset_type === 'DECISION_TRANSITION'
    && dataset.schema_version === DATASET_SCHEMA_VERSION
    && Array.isArray(dataset.samples), 'decision dataset schema');
  checkFinite(dataset);
  const previousByEpisode = new Map();
  for (const sample of dataset.samples) {
    validateMetadata(sample.metadata);
    check(typeof sample.metadata.episode_id === 'string'
      && Number.isInteger(sample.metadata.step_index)
      && typeof sample.metadata.visitor_profile_id === 'string',
    'decision episode/profile metadata');
    check(sample.input && sample.target && sample.audit, 'decision roles');
    const input = sample.input;
    check(Object.keys(input).sort().join(',') ===
      ['observation', 'visitor_state', 'legal_actions', 'chosen_action', 'delta_t_min'].sort().join(','),
    'decision model input whitelist');
    rejectFutureKeys(input);
    check(input.observation && !Object.hasOwn(input.observation, 'latent_target')
      && !Object.hasOwn(input.observation, 'reward')
      && !Object.hasOwn(input, 'transition_audit') && !Object.hasOwn(input, 'latent_target'),
    'future leakage into model input');
    check(same(Object.keys(input.visitor_state), VISITOR_STATE_FIELDS), 'visitor input whitelist');
    check(input.legal_actions.some(item => same(item.action, input.chosen_action)),
      'chosen action not legal');
    check(Number.isFinite(input.delta_t_min) && input.delta_t_min > 0,
      'decision elapsed time');
    check(sample.target.reward && Number.isFinite(sample.target.reward.total)
      && sample.target.next_observation && sample.target.latent_target
      && typeof sample.target.done === 'boolean', 'decision target');
    check(sample.target.reward.reward_version === sample.metadata.reward_version,
      'reward version');
    for (const poi of Object.values(sample.target.latent_target.pois || {}))
      check(Number.isSafeInteger(poi.queue_count) && poi.queue_count >= 0, 'target queue');
    check(sample.target.latent_target.environment_summary.park_population >= 0,
      'target population');
    check(sample.audit.transition_audit?.status !== 'IN_PROGRESS'
      && sample.audit.policy_audit
      && sample.audit.invariant_summary?.population === 'PASS'
      && sample.audit.invariant_summary?.road_occupancy === 'PASS', 'decision audits/conservation');
    check(sample.audit.transition_audit.action_type === input.chosen_action.action_type,
      'action/audit mismatch');
    check(toMillis(input.observation.timestamp) <= toMillis(sample.audit.transition_audit.started_at)
      && toMillis(sample.audit.transition_audit.ended_at)
        <= toMillis(sample.target.next_observation.timestamp), 'decision time order');
    check(Math.abs(input.delta_t_min - (toMillis(sample.audit.transition_audit.ended_at)
      - toMillis(sample.audit.transition_audit.started_at)) / 60000) <= 0.000001,
    'decision elapsed time mismatch');
    const previous = previousByEpisode.get(sample.metadata.episode_id);
    if (previous) check(sample.metadata.step_index === previous.metadata.step_index + 1
      && toMillis(input.observation.timestamp)
        >= toMillis(previous.target.next_observation.timestamp), 'decision chronology');
    previousByEpisode.set(sample.metadata.episode_id, sample);
  }
  return true;
}

function validateEnvironmentRollout(dataset) {
  check(dataset?.dataset_type === 'FIXED_5_MIN_ENVIRONMENT'
    && dataset.schema_version === DATASET_SCHEMA_VERSION
    && dataset.step_min === 5 && Array.isArray(dataset.samples), 'environment dataset schema');
  checkFinite(dataset);
  const byTrajectoryStep = new Map(dataset.samples.map(sample =>
    [`${sample.metadata?.trajectory_id}:${sample.metadata?.step_index}`, sample]));
  const previousByTrajectory = new Map();
  for (const sample of dataset.samples) {
    validateMetadata(sample.metadata);
    check(typeof sample.metadata.trajectory_id === 'string'
      && Number.isInteger(sample.metadata.step_index), 'environment trajectory metadata');
    check(!Object.hasOwn(sample, 'input') && sample.latent_current?.environment_state
      && sample.observed_input?.observation
      && sample.future_target && sample.audit?.expected_edge_occupancy,
    'environment sample roles');
    check(Object.keys(sample.observed_input).join(',') === 'observation'
      && sample.observed_input.observation.timestamp === sample.latent_current.environment_state.timestamp,
    'environment input leakage/time');
    rejectFutureKeys(sample.observed_input);
    const rejectLatent = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        check(!LATENT_KEYS.has(key), `latent field in observed input: ${key}`);
        rejectLatent(child);
      }
    };
    rejectLatent(sample.observed_input);
    validateEnvironmentState(sample.latent_current.environment_state, sample.audit.expected_edge_occupancy);
    for (const [key, offset] of Object.entries(HORIZONS)) {
      const target = sample.future_target[key];
      check(target === null || (target.step_index === sample.metadata.step_index + offset
        && toMillis(target.environment.timestamp) - toMillis(sample.latent_current.environment_state.timestamp)
          === offset * 5 * 60000), `${key} horizon alignment`);
      if (target) validateEnvironmentState(target.environment);
      const recorded = byTrajectoryStep.get(`${sample.metadata.trajectory_id}:${sample.metadata.step_index + offset}`);
      if (recorded) check(target && same(target.environment, recorded.latent_current.environment_state),
        `${key} differs from recorded future state`);
      check(sample.target_available[key] === (target !== null), `${key} availability`);
    }
    const previous = previousByTrajectory.get(sample.metadata.trajectory_id);
    if (previous) check(sample.metadata.step_index === previous.metadata.step_index + 1
      && toMillis(sample.latent_current.environment_state.timestamp)
        - toMillis(previous.latent_current.environment_state.timestamp) === 5 * 60000,
    'fixed 5-minute chronology');
    previousByTrajectory.set(sample.metadata.trajectory_id, sample);
  }
  const byScenario = new Map();
  for (const sample of dataset.samples) {
    const id = sample.metadata.scenario_instance_id;
    if (!byScenario.has(id)) byScenario.set(id, []);
    byScenario.get(id).push(sample.observed_input);
  }
  if (byScenario.size > 1) {
    check(new Set([...byScenario.values()].map(rows => JSON.stringify(rows))).size > 1,
      'scenario trajectories are indistinguishable');
  }
  return true;
}

module.exports = { DATASET_SCHEMA_VERSION, HORIZONS, projectEnvironment, occupancyAudit,
  projectDecisionRoles, projectEnvironmentRoles,
  validateDecisionDataset, validateEnvironmentRollout };

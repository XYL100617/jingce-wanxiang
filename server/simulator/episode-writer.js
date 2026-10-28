'use strict';

const { toMillis } = require('../planner/time');

const EPISODE_SCHEMA_VERSION = 'episode-p1.1';
const VISITOR_STATE_FIELDS = Object.freeze(['timestamp', 'visitor_id', 'current_node_id',
  'fatigue', 'remaining_time_min', 'shadow_in_park', 'visited_poi_ids',
  'attended_event_ids', 'visited_facility_ids']);
const EPISODE_FIELD_ROLES = Object.freeze({
  MODEL_INPUT: Object.freeze(['observation', 'visitor_state', 'legal_actions', 'chosen_action', 'delta_t_min']),
  TRAINING_TARGET: Object.freeze(['reward', 'next_observation', 'next_visitor_state',
    'latent_target', 'done', 'termination_reason']),
  AUDIT_ONLY: Object.freeze(['transition_audit']),
  METADATA: Object.freeze(['episode_id', 'step_index', 'timestamp', 'provenance',
    'episode_schema_version'])
});
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (condition, message) => { if (!condition) throw new Error(`INVALID_EPISODE: ${message}`); };
const forbiddenObservationKeys = new Set([
  'latent_target', 'environment', 'population_ledger', 'mobility_ledger', 'park_population',
  'occupancy', 'occupancy_ratio', 'congestion_multiplier', 'effective_travel_time_min',
  'rng', 'reward', 'transition_audit', 'actual_route', 'future_event', 'completion_event', 'missed_event'
]);

function validateObservation(value) {
  assert(value && typeof value === 'object', 'missing observation');
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert(!forbiddenObservationKeys.has(key), `latent or result field in observation: ${key}`);
      walk(child);
    }
  };
  walk(value);
  assert(value.source_tier === 'T4' && value.synthetic === true, 'observation provenance');
  assert(value.timestamp && value.observation_version, 'observation timestamp/version');
  if (value.available_at) assert(toMillis(value.available_at) <= toMillis(value.timestamp), 'future observation');
  if (value.observed_at) assert(toMillis(value.observed_at) <= toMillis(value.timestamp), 'future observation capture');
}

function visitorSnapshot(state) {
  const visitor = state.visitor;
  const snapshot = { timestamp: state.simulation_time, visitor_id: visitor.visitor_id,
    current_node_id: visitor.current_node_id, fatigue: visitor.fatigue,
    remaining_time_min: visitor.remaining_time_min, shadow_in_park: visitor.shadow_in_park,
    visited_poi_ids: visitor.visited_poi_ids, attended_event_ids: visitor.attended_event_ids,
    visited_facility_ids: visitor.visited_facility_ids };
  assert(same(Object.keys(snapshot), VISITOR_STATE_FIELDS), 'visitor snapshot whitelist drift');
  return clone(snapshot);
}

function validateVisitorSnapshot(snapshot) {
  assert(snapshot && same(Object.keys(snapshot), VISITOR_STATE_FIELDS), 'visitor state whitelist');
  assert(typeof snapshot.visitor_id === 'string' && typeof snapshot.current_node_id === 'string'
    && Number.isFinite(snapshot.fatigue) && Number.isFinite(snapshot.remaining_time_min)
    && typeof snapshot.shadow_in_park === 'boolean', 'visitor state types');
  for (const key of ['visited_poi_ids', 'attended_event_ids', 'visited_facility_ids']) {
    assert(Array.isArray(snapshot[key]), `visitor ${key}`);
  }
  toMillis(snapshot.timestamp);
}

function environmentTarget(state) {
  return clone({ timestamp: state.simulation_time,
    pois: Object.fromEntries(Object.entries(state.pois).map(([id, poi]) => [id, {
      queue_count: poi.queue_count, crowd_ratio: poi.crowd_ratio, is_open: poi.is_open
    }])),
    roads: Object.fromEntries(Object.entries(state.roads).map(([id, road]) => [id, {
      effective_travel_time_min: road.effective_travel_time_min,
      congestion_multiplier: road.congestion_multiplier, is_open: road.is_open
    }])),
    events: Object.fromEntries(Object.entries(state.events).filter(([, event]) => event.is_show_event)
      .map(([id, event]) => [id, { phase: event.phase, status: event.status,
        cancelled: event.cancelled, event_queue_count: event.event_queue_count,
        attending_count: event.attending_count }])),
    environment_summary: { park_population: state.environment.park_population,
      weather: state.environment.weather }
  });
}

function createEpisode(simulator, { runIndex = 1 } = {}) {
  assert(Number.isInteger(runIndex) && runIndex >= 0, 'runIndex');
  assert(!simulator.getActiveDecisionTransition(), 'episode cannot start during active transition');
  const metadata = simulator.getMetadata();
  const state = simulator.getState();
  assert(metadata.visitor_mode === 'SHADOW_VISITOR' && state.visitor.shadow_in_park,
    'episode must begin with an active shadow visitor');
  assert(simulator.getLegalActions().legal.length > 0, 'no first legal action');
  assert(metadata.source_tier === 'T4' && metadata.synthetic === true, 'episode must be T4 synthetic');
  const provenance = { graph_version: metadata.graph_version, scenario_id: metadata.scenario_id,
    seed: metadata.seed, source_tier: metadata.source_tier, synthetic: metadata.synthetic,
    simulator_version: metadata.simulator_version, parameter_version: metadata.parameter_version,
    observation_version: metadata.observation_version, reward_version: metadata.reward_version,
    episode_schema_version: EPISODE_SCHEMA_VERSION, visitor_mode: metadata.visitor_mode,
    observation_scenario_id: metadata.observation_scenario_id,
    ...(metadata.scenario_instance_id
      ? { scenario_instance_id: metadata.scenario_instance_id,
        scenario_parameter_version: metadata.scenario_parameter_version } : {}),
    ...(metadata.visitor_profile_version
      ? { visitor_profile_version: metadata.visitor_profile_version } : {}) };
  for (const key of ['graph_version', 'scenario_id', 'seed', 'simulator_version',
    'parameter_version', 'observation_version', 'reward_version']) {
    assert(provenance[key] !== null && provenance[key] !== undefined, `missing ${key}`);
  }
  const scenario = String(metadata.scenario_id).replace(/[^A-Za-z0-9_-]/g, '_');
  return { episode_id: `ep_${scenario}_seed${metadata.seed}_${String(runIndex).padStart(6, '0')}`,
    episode_schema_version: EPISODE_SCHEMA_VERSION, provenance,
    visitor_mode: 'SHADOW_VISITOR', started_at: state.simulation_time, ended_at: null,
    steps: [], done: false, termination_reason: null };
}

function captureDecisionInput(simulator) {
  assert(!simulator.getActiveDecisionTransition(), 'cannot capture during active transition');
  const state = simulator.getState();
  const observation = simulator.getObservation();
  const legal = simulator.getLegalActions();
  assert(same(observation, legal.observation), 'legal actions and observation differ');
  validateObservation(observation);
  return clone({ timestamp: state.simulation_time, observation,
    visitor_state: visitorSnapshot(state), legal_actions: legal.legal });
}

function appendTransition(episode, { input, chosen_action, terminal, terminal_step_timestamp, simulator }) {
  assert(!episode.done && episode.ended_at === null, 'episode already ended');
  assert(input && terminal && simulator, 'incomplete transition input');
  assert(!simulator.getActiveDecisionTransition(), 'transition remains in progress');
  assert(terminal.audit && terminal.audit.status !== 'IN_PROGRESS' && terminal.reward,
    'only terminal transition with reward can be appended');
  assert(simulator.getCompletedDecisionTransitions().some(item => same(item, terminal)),
    'terminal is not a simulator result');
  const state = simulator.getState();
  assert(terminal_step_timestamp === state.simulation_time, 'terminal step is not current simulator state');
  const next_observation = simulator.getObservation();
  validateObservation(input.observation);
  validateObservation(next_observation);
  assert(input.legal_actions.some(item => same(item.action, chosen_action)),
    'chosen action absent from captured legal actions');
  assert(terminal.audit.action.action_type === chosen_action.action_type
    && terminal.audit.action.target_id === chosen_action.target_id
    && terminal.audit.action.target_node_id === chosen_action.target_node_id,
  'audit action differs from chosen action');
  assert(input.timestamp === terminal.audit.started_at
    && input.visitor_state.visitor_id === terminal.audit.visitor_id,
  'action start differs from captured visitor state');
  assert(terminal.reward.reward_version === episode.provenance.reward_version, 'reward version mismatch');
  assert(input.observation.observation_version === episode.provenance.observation_version
    && next_observation.observation_version === episode.provenance.observation_version,
  'observation version mismatch');
  const done = terminal.audit.action_type === 'EXIT' && terminal.audit.status === 'COMPLETED'
    || state.visitor.remaining_time_min <= 0;
  const termination_reason = terminal.audit.action_type === 'EXIT' && terminal.audit.status === 'COMPLETED'
    ? 'EXITED' : done ? 'TIME_EXHAUSTED' : null;
  const delta_t_min = Math.round((toMillis(terminal.audit.ended_at)
    - toMillis(terminal.audit.started_at)) / 60000 * 1e6) / 1e6;
  const record = { episode_id: episode.episode_id, step_index: episode.steps.length,
    timestamp: input.timestamp, delta_t_min, observation: clone(input.observation),
    visitor_state: clone(input.visitor_state), legal_actions: clone(input.legal_actions),
    chosen_action: clone(chosen_action), transition_audit: clone(terminal.audit),
    reward: clone(terminal.reward), next_observation: clone(next_observation),
    next_visitor_state: visitorSnapshot(state), latent_target: environmentTarget(state),
    done, termination_reason, provenance: clone(episode.provenance) };
  const candidate = { ...episode, steps: [...episode.steps, record] };
  if (done) {
    candidate.done = true;
    candidate.termination_reason = termination_reason;
    candidate.ended_at = state.simulation_time;
  }
  validateEpisode(candidate);
  episode.steps.push(record);
  if (done) {
    episode.done = true;
    episode.termination_reason = termination_reason;
    episode.ended_at = state.simulation_time;
  }
  return clone(record);
}

function validateEpisode(episode) {
  assert(episode.episode_schema_version === EPISODE_SCHEMA_VERSION, 'schema version');
  assert(episode.provenance.source_tier === 'T4' && episode.provenance.synthetic === true,
    'provenance source tier');
  assert(episode.visitor_mode === 'SHADOW_VISITOR', 'visitor mode');
  assert(Array.isArray(episode.steps), 'steps');
  for (let index = 0; index < episode.steps.length; index += 1) {
    const row = episode.steps[index];
    assert(row.episode_id === episode.episode_id && row.step_index === index, 'step order');
    assert(same(row.provenance, episode.provenance), 'step provenance');
    validateObservation(row.observation);
    validateObservation(row.next_observation);
    validateVisitorSnapshot(row.visitor_state);
    validateVisitorSnapshot(row.next_visitor_state);
    assert(row.legal_actions.some(item => same(item.action, row.chosen_action)), 'illegal chosen action');
    assert(row.transition_audit.status !== 'IN_PROGRESS' && row.reward &&
      row.transition_audit.ended_at, 'nonterminal step or missing reward');
    assert(row.transition_audit.action_type === row.chosen_action.action_type &&
      row.transition_audit.target_id === row.chosen_action.target_id &&
      row.transition_audit.action.target_node_id === row.chosen_action.target_node_id,
    'audit action mismatch');
    assert(toMillis(row.observation.timestamp) <= toMillis(row.transition_audit.started_at)
      && toMillis(row.transition_audit.started_at) <= toMillis(row.transition_audit.ended_at)
      && toMillis(row.transition_audit.ended_at) <= toMillis(row.next_observation.timestamp),
    'transition time order');
    const elapsed = (toMillis(row.transition_audit.ended_at)
      - toMillis(row.transition_audit.started_at)) / 60000;
    assert(Number.isFinite(row.delta_t_min) && row.delta_t_min >= 0
      && elapsed > 0 && Math.abs(row.delta_t_min - elapsed) <= 0.000001,
    'actual transition elapsed minutes');
    assert(toMillis(row.timestamp) === toMillis(row.observation.timestamp), 'input timestamp');
    assert(toMillis(row.visitor_state.timestamp) === toMillis(row.timestamp)
      && toMillis(row.transition_audit.started_at) === toMillis(row.timestamp),
    'decision start snapshot time');
    assert(row.visitor_state.visitor_id === row.transition_audit.visitor_id,
      'audit visitor mismatch');
    assert(toMillis(row.next_observation.timestamp) === toMillis(row.next_visitor_state.timestamp)
      && toMillis(row.latent_target.timestamp) === toMillis(row.next_visitor_state.timestamp),
    'post-action snapshot time');
    assert(row.reward.reward_version === row.provenance.reward_version, 'reward provenance');
    assert(row.observation.observation_version === row.provenance.observation_version
      && row.next_observation.observation_version === row.provenance.observation_version,
    'observation provenance');
    assert(row.visitor_state.visitor_id === row.next_visitor_state.visitor_id, 'visitor identity');
    if (index > 0) {
      const previous = episode.steps[index - 1];
      for (const key of ['current_node_id', 'shadow_in_park', 'remaining_time_min'])
        assert(same(previous.next_visitor_state[key], row.visitor_state[key]),
          `visitor continuity: ${key}`);
      assert(Math.abs(previous.next_visitor_state.fatigue - row.visitor_state.fatigue) <= 0.000001,
        'visitor continuity: fatigue');
      assert(toMillis(previous.next_visitor_state.timestamp) <= toMillis(row.visitor_state.timestamp),
        'visitor continuity: time');
      assert(toMillis(previous.next_observation.timestamp) <= toMillis(row.observation.timestamp),
        'observation time regression');
      assert(!previous.done, 'step after termination');
    }
    assert(row.done === (row.termination_reason !== null), 'termination pair');
    if (row.termination_reason === 'EXITED') {
      assert(row.chosen_action.action_type === 'EXIT' && row.transition_audit.status === 'COMPLETED'
        && row.next_visitor_state.shadow_in_park === false, 'invalid EXITED termination');
    }
    if (row.termination_reason === 'TIME_EXHAUSTED') {
      assert(row.next_visitor_state.remaining_time_min <= 0, 'invalid time exhaustion');
    }
  }
  if (episode.done) {
    assert(episode.steps.length > 0 && episode.steps.at(-1).done, 'missing terminal step');
    assert(episode.termination_reason === episode.steps.at(-1).termination_reason, 'termination mismatch');
    assert(episode.ended_at === episode.steps.at(-1).next_visitor_state.timestamp, 'end time mismatch');
  }
  return true;
}

function finalizeEpisode(episode) {
  validateEpisode(episode);
  assert(episode.done, 'episode has no terminal condition');
  return clone(episode);
}

function serializeEpisode(episode) {
  validateEpisode(episode);
  return JSON.stringify(episode);
}

module.exports = { EPISODE_SCHEMA_VERSION, VISITOR_STATE_FIELDS, EPISODE_FIELD_ROLES,
  createEpisode, captureDecisionInput, appendTransition, finalizeEpisode,
  validateEpisode, serializeEpisode };

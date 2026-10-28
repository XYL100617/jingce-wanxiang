'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { createSimulator } = require('../server/simulator/simulator');
const { EPISODE_SCHEMA_VERSION, VISITOR_STATE_FIELDS, EPISODE_FIELD_ROLES,
  createEpisode, captureDecisionInput,
  appendTransition, finalizeEpisode, validateEpisode, serializeEpisode
} = require('../server/simulator/episode-writer');
const { toMillis } = require('../server/planner/time');

function choose(input, type, target) {
  const action = input.legal_actions.find(item => item.action.action_type === type
    && (!target || item.action.target_id === target))?.action;
  assert.ok(action, `legal action ${type}:${target || '*'}`);
  return action;
}

function runAction(sim, episode, type, target) {
  const input = captureDecisionInput(sim);
  const chosen_action = choose(input, type, target);
  const before = structuredClone(sim.getState());
  assert.deepEqual(sim.getState(), before, 'capture may not mutate environment');
  sim.startDecisionTransition(chosen_action);
  let terminal;
  let terminal_step_timestamp;
  let internalSteps = 0;
  const beforeStepCount = episode.steps.length;
  for (let index = 0; index < 60; index += 1) {
    const step = sim.step();
    const result = step.decision_transition;
    internalSteps += 1;
    assert.equal(episode.steps.length, beforeStepCount, 'no interim write');
    if (result?.audit.status !== 'IN_PROGRESS' && result) {
      terminal = result;
      terminal_step_timestamp = step.timestamp;
      break;
    }
  }
  assert.ok(terminal, 'terminal transition');
  const afterSimulation = structuredClone(sim.getState());
  const row = appendTransition(episode, { input, chosen_action, terminal,
    terminal_step_timestamp, simulator: sim });
  assert.deepEqual(sim.getState(), afterSimulation, 'writer must not mutate environment');
  return { row, terminal, internalSteps };
}

function makeSingle(type, target, configure = x => x) {
  const options = configure({ seed: 42 });
  const sim = createSimulator(options);
  const episode = createEpisode(sim);
  const { row, terminal, internalSteps } = runAction(sim, episode, type, target);
  return { sim, episode, row, terminal, internalSteps };
}

function makeFull(seed = 42) {
  const sim = createSimulator({ seed });
  const episode = createEpisode(sim);
  const first = runAction(sim, episode, 'VISIT_POI', 'market');
  const legal = captureDecisionInput(sim).legal_actions;
  const second = (legal.find(item => item.action.action_type === 'VISIT_POI'
    && item.action.target_id === 'museum')
    || legal.find(item => item.action.action_type === 'REST')
    || legal.find(item => item.action.action_type === 'WAIT')
    || legal.find(item => item.action.action_type === 'ATTEND_EVENT'))?.action;
  assert.ok(second, 'second non-exit action');
  const middle = runAction(sim, episode, second.action_type, second.target_id);
  const final = runAction(sim, episode, 'EXIT', 'exit_southgate');
  return { sim, episode: finalizeEpisode(episode), first, middle, final };
}

const visit = makeSingle('VISIT_POI', 'market');
const event = makeSingle('ATTEND_EVENT', 'show-1');
// A separate late start produces the missed-event evidence without changing the writer.
const missedSim = createSimulator({ seed: 42 });
missedSim.runSteps(11);
const missedEpisode = createEpisode(missedSim);
const missedRow = runAction(missedSim, missedEpisode, 'ATTEND_EVENT', 'show-1').row;
const rest = makeSingle('REST', 'rest', options => {
  options.initialState = provider.getState();
  options.initialState.visitor.fatigue = 0.7;
  return options;
});
const wait = makeSingle('WAIT', 'wait', options => {
  const graph = provider.getScenicGraph();
  graph.nodes = graph.nodes.filter(node => ['gate', 'southgate'].includes(node.node_id));
  graph.edges = graph.edges.filter(edge => edge.edge_id === 'edge_001');
  options.initialGraph = graph;
  return options;
});
const exit = makeSingle('EXIT', 'exit_southgate');
const full = makeFull();

test('EP1 episode ID is deterministic from scenario, seed and run index', () => {
  assert.equal(createEpisode(createSimulator({ seed: 42 })).episode_id, full.episode.episode_id);
  assert.notEqual(createEpisode(createSimulator({ seed: 42 }), { runIndex: 2 }).episode_id,
    full.episode.episode_id);
});
test('EP2 schema version exists', () => assert.equal(full.episode.episode_schema_version, EPISODE_SCHEMA_VERSION));
test('EP3 provenance includes all required fields', () => {
  for (const key of ['graph_version', 'scenario_id', 'seed', 'source_tier', 'synthetic',
    'simulator_version', 'parameter_version', 'observation_version', 'reward_version',
    'episode_schema_version']) assert.notEqual(full.episode.provenance[key], undefined);
});
test('EP4 episode source tier is T4', () => assert.equal(full.episode.provenance.source_tier, 'T4'));
test('EP5 episode is synthetic', () => assert.equal(full.episode.provenance.synthetic, true));
test('EP6 step indexes follow decisions', () => assert.deepEqual(full.episode.steps.map(row => row.step_index), [0, 1, 2]));
test('EP7 chosen action is a captured legal action', () => {
  for (const row of full.episode.steps) assert.ok(row.legal_actions.some(item =>
    JSON.stringify(item.action) === JSON.stringify(row.chosen_action)));
});
test('EP8 observation excludes latent-only fields', () => {
  for (const row of full.episode.steps) {
    assert.equal(row.observation.environment, undefined);
    assert.equal(row.observation.reward, undefined);
    assert.equal(row.observation.latent_target, undefined);
  }
  assert.equal(validateEpisode(full.episode), true);
});
test('EP9 compact latent target stays separate from observation', () => {
  const row = visit.row;
  assert.ok(row.latent_target.pois.market);
  assert.ok(row.latent_target.roads.edge_001);
  assert.ok(row.latent_target.environment_summary);
  assert.equal(row.observation.environment_summary, undefined);
  assert.equal(row.latent_target.population_ledger, undefined);
});
test('EP10 reward is the terminal automatic reward', () => assert.deepEqual(visit.row.reward, visit.terminal.reward));
test('EP11 in-progress steps do not append decision records', () => {
  const sim = createSimulator({ seed: 42 });
  const episode = createEpisode(sim);
  const input = captureDecisionInput(sim);
  const action = choose(input, 'VISIT_POI', 'market');
  sim.startDecisionTransition(action);
  const interim = sim.step().decision_transition;
  assert.equal(interim.audit.status, 'IN_PROGRESS');
  assert.equal(interim.reward, null);
  assert.throws(() => appendTransition(episode, { input, chosen_action: action,
    terminal: interim, simulator: sim }), /INVALID_EPISODE/);
  assert.equal(episode.steps.length, 0);
});
test('EP12 VISIT_POI completes', () => {
  assert.equal(visit.row.transition_audit.status, 'COMPLETED');
  assert.ok(visit.row.next_visitor_state.visited_poi_ids.includes('market'));
  assert.equal(visit.row.done, false);
});
test('EP13 ATTEND_EVENT completes', () => {
  assert.equal(event.row.transition_audit.status, 'COMPLETED');
  assert.ok(event.row.next_visitor_state.attended_event_ids.includes('show-1'));
});
test('EP14 missed event retains penalty and does not terminate', () => {
  assert.equal(missedRow.transition_audit.status, 'MISSED');
  assert.ok(missedRow.transition_audit.missed_event);
  assert.equal(missedRow.reward.components.missed_event_penalty, -1);
  assert.equal(missedRow.done, false);
});
test('EP15 REST completes', () => {
  assert.equal(rest.row.transition_audit.status, 'COMPLETED');
  assert.ok(rest.row.next_visitor_state.visited_facility_ids.includes('rest'));
});
test('EP16 WAIT completes', () => {
  assert.equal(wait.row.transition_audit.status, 'COMPLETED');
  assert.ok(wait.row.transition_audit.actual_wait_time_min > 0);
});
test('EP17 EXIT completes and ends episode', () => {
  assert.equal(exit.row.transition_audit.status, 'COMPLETED');
  assert.equal(exit.row.done, true);
  assert.equal(exit.row.termination_reason, 'EXITED');
});
test('EP18 EXIT does not decrement aggregate population', () => {
  const baseline = createSimulator({ seed: 42 });
  baseline.runSteps(exit.internalSteps);
  assert.equal(exit.row.transition_audit.aggregate_population_delta, 0);
  assert.equal(exit.row.next_visitor_state.shadow_in_park, false);
  assert.equal(exit.row.latent_target.environment_summary.park_population,
    baseline.getState().environment.park_population);
});
test('EP19 visitor fields continue across high-level steps', () => {
  for (let index = 1; index < full.episode.steps.length; index += 1) {
    const previous = full.episode.steps[index - 1].next_visitor_state;
    const current = full.episode.steps[index].visitor_state;
    for (const key of ['timestamp', 'current_node_id', 'fatigue', 'shadow_in_park',
      'remaining_time_min']) assert.deepEqual(previous[key], current[key]);
  }
});
test('EP20 observation time is monotonic', () => {
  for (const row of full.episode.steps) assert.ok(toMillis(row.observation.timestamp)
    <= toMillis(row.next_observation.timestamp));
});
test('EP21 audit start and end follow available observation time', () => {
  for (const row of full.episode.steps) assert.ok(toMillis(row.observation.timestamp)
    <= toMillis(row.transition_audit.started_at)
    && toMillis(row.transition_audit.started_at) <= toMillis(row.transition_audit.ended_at)
    && toMillis(row.transition_audit.ended_at) <= toMillis(row.next_observation.timestamp));
});
test('EP22 reward version matches provenance', () => {
  for (const row of full.episode.steps) assert.equal(row.reward.reward_version, row.provenance.reward_version);
});
test('EP23 observation version matches provenance', () => {
  for (const row of full.episode.steps) assert.equal(row.observation.observation_version,
    row.provenance.observation_version);
});
test('EP24 graph version matches simulator metadata', () => assert.equal(full.episode.provenance.graph_version,
  full.sim.getMetadata().graph_version));
test('EP25 scenario and seed match simulator metadata', () => {
  assert.equal(full.episode.provenance.scenario_id, full.sim.getMetadata().scenario_id);
  assert.equal(full.episode.provenance.seed, full.sim.getMetadata().seed);
});
test('EP26 same seed and action sequence replay identically', () => assert.deepEqual(makeFull(42).episode, full.episode));
test('EP27 different seed can change environment trajectory', () => {
  const other = makeFull(43).episode;
  assert.notDeepEqual(other.steps.map(row => row.latent_target),
    full.episode.steps.map(row => row.latent_target));
});
test('EP28 three-decision episode finalizes and serializes', () => {
  assert.equal(full.episode.steps.length, 3);
  assert.deepEqual(JSON.parse(serializeEpisode(full.episode)), full.episode);
});
test('EP29 termination reason is EXITED', () => {
  assert.equal(full.episode.done, true);
  assert.equal(full.episode.termination_reason, 'EXITED');
});
test('EP30 writer leaves simulator state unchanged', () => {
  const sim = createSimulator({ seed: 42 });
  const before = sim.getState();
  const episode = createEpisode(sim);
  captureDecisionInput(sim);
  validateEpisode(episode);
  assert.deepEqual(sim.getState(), before);
});

test('tampered observation, action, time and continuity are rejected', () => {
  const tamper = mutator => {
    const copy = structuredClone(full.episode);
    mutator(copy);
    assert.throws(() => validateEpisode(copy), /INVALID_EPISODE/);
  };
  tamper(copy => { copy.steps[0].observation.park_population = 999; });
  tamper(copy => { copy.steps[0].chosen_action.target_id = 'unknown'; });
  tamper(copy => { copy.steps[0].next_observation.timestamp = '2000-01-01 00:00:00'; });
  tamper(copy => { copy.steps[1].visitor_state.fatigue = 0.99; });
  tamper(copy => { copy.steps[0].reward = null; });
});

test('delayed available observation keeps event outcome outside action input', () => {
  const sim = createSimulator({ seed: 42, observationScenario: 'P1D_DELAYED' });
  const episode = createEpisode(sim);
  const input = captureDecisionInput(sim);
  assert.equal(input.observation.available_at, null);
  const result = runAction(sim, episode, 'VISIT_POI', 'market');
  assert.ok(result.row.next_observation.observed_at);
  assert.ok(toMillis(result.row.next_observation.available_at)
    <= toMillis(result.row.next_observation.timestamp));
  assert.equal(result.row.observation.completion_event, undefined);
});

test('latent target is the actual post-action environment, and invalid append is atomic', () => {
  assert.equal(visit.row.latent_target.pois.market.queue_count,
    visit.sim.getState().pois.market.queue_count);
  assert.equal(visit.row.latent_target.roads.edge_001.effective_travel_time_min,
    visit.sim.getState().roads.edge_001.effective_travel_time_min);
  const sim = createSimulator({ seed: 42 });
  const episode = createEpisode(sim);
  const input = captureDecisionInput(sim);
  const chosen_action = choose(input, 'EXIT', 'exit_southgate');
  sim.startDecisionTransition(chosen_action);
  let terminal;
  let terminal_step_timestamp;
  for (let index = 0; index < 60; index += 1) {
    const step = sim.step();
    if (step.decision_transition?.audit.status === 'COMPLETED') {
      terminal = step.decision_transition;
      terminal_step_timestamp = step.timestamp;
      break;
    }
  }
  assert.ok(terminal);
  assert.throws(() => appendTransition(episode, { input, chosen_action, terminal,
    terminal_step_timestamp: '2000-01-01 00:00:00', simulator: sim }), /INVALID_EPISODE/);
  assert.equal(episode.steps.length, 0);
  assert.equal(episode.done, false);
  appendTransition(episode, { input, chosen_action, terminal, terminal_step_timestamp, simulator: sim });
  assert.equal(episode.steps.length, 1);
});

test('EP34 delta_t_min exists and is positive on terminal actions', () => {
  for (const row of full.episode.steps) assert.ok(row.delta_t_min > 0);
});
test('EP35 delta_t_min equals actual audit elapsed time', () => {
  for (const row of full.episode.steps) assert.ok(Math.abs(row.delta_t_min
    - (toMillis(row.transition_audit.ended_at) - toMillis(row.transition_audit.started_at)) / 60000)
    <= 0.000001);
});
test('EP36 action durations are not fixed five-minute steps', () => {
  assert.notEqual(visit.row.delta_t_min, exit.row.delta_t_min);
  assert.ok(visit.row.delta_t_min > 5);
});
test('EP37 visitor_state contains only explicit fields', () => {
  for (const row of full.episode.steps) assert.deepEqual(Object.keys(row.visitor_state), VISITOR_STATE_FIELDS);
});
test('EP38 visitor_state excludes terminal and future fields', () => {
  for (const key of ['reward', 'outcome', 'actual_route', 'actual_travel_time_min',
    'completion_event', 'missed_event', 'fatigue_after', 'next_node'])
    assert.equal(Object.hasOwn(full.episode.steps[0].visitor_state, key), false);
});
test('EP39 next_visitor_state uses the same whitelist', () => {
  for (const row of full.episode.steps) assert.deepEqual(Object.keys(row.next_visitor_state), VISITOR_STATE_FIELDS);
});
test('EP40 consecutive visitor states agree within float tolerance', () => {
  for (let index = 1; index < full.episode.steps.length; index += 1) {
    const before = full.episode.steps[index - 1].next_visitor_state;
    const after = full.episode.steps[index].visitor_state;
    assert.equal(before.current_node_id, after.current_node_id);
    assert.equal(before.shadow_in_park, after.shadow_in_park);
    assert.ok(Math.abs(before.fatigue - after.fatigue) <= 0.000001);
    assert.ok(toMillis(before.timestamp) <= toMillis(after.timestamp));
  }
});
test('EP41 transition audit is AUDIT_ONLY', () => {
  assert.ok(EPISODE_FIELD_ROLES.AUDIT_ONLY.includes('transition_audit'));
  assert.equal(EPISODE_FIELD_ROLES.MODEL_INPUT.includes('transition_audit'), false);
});
test('EP42 latent target is TRAINING_TARGET', () => {
  assert.ok(EPISODE_FIELD_ROLES.TRAINING_TARGET.includes('latent_target'));
  assert.equal(EPISODE_FIELD_ROLES.MODEL_INPUT.includes('latent_target'), false);
});
test('EP43 model input fields exclude terminal results', () => {
  for (const key of ['reward', 'next_observation', 'next_visitor_state', 'done',
    'termination_reason', 'transition_audit'])
    assert.equal(EPISODE_FIELD_ROLES.MODEL_INPUT.includes(key), false);
  const copy = structuredClone(full.episode);
  copy.steps[0].visitor_state.actual_travel_time_min = 10;
  assert.throws(() => validateEpisode(copy), /INVALID_EPISODE/);
});

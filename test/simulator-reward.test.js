'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSimulator } = require('../server/simulator/simulator');
const { computeReward, COMPONENTS, COMPLETION_KINDS } = require('../server/simulator/reward-engine');
const { PARAMETERS, REWARD_VERSION, PARAMETER_VERSION } = require('../server/simulator/config/reward-parameters');

const targets = { VISIT_POI: 'market', ATTEND_EVENT: 'show-1', REST: 'rest-facility',
  WAIT: 'wait', EXIT: 'exit_southgate' };
function context(type = 'VISIT_POI', overrides = {}) {
  const target = targets[type];
  const audit = {
    visitor_id: 'decision-visitor', action_type: type, target_id: target,
    actual_travel_time_min: type === 'REST' || type === 'WAIT' ? null : 10,
    actual_queue_time_min: ['VISIT_POI', 'ATTEND_EVENT'].includes(type) ? 5 : null,
    actual_wait_time_min: type === 'WAIT' ? 5 : null,
    fatigue_before: 0.2, fatigue_after: type === 'REST' ? 0.1 : 0.3,
    legal_action_confirmed: true, safety_violation: false,
    outcome: 'COMPLETED',
    completion_event: { kind: COMPLETION_KINDS[type], visitor_id: 'decision-visitor', target_id: target },
    ...overrides
  };
  if (audit.outcome !== 'COMPLETED' && overrides.completion_event === undefined) delete audit.completion_event;
  if (audit.outcome === 'MISSED' && overrides.missed_event === undefined) {
    audit.missed_event = { kind: 'EVENT_MISSED', visitor_id: 'decision-visitor', target_id: target };
  }
  return {
    action: { action_type: type, target_id: target },
    beforeState: { visitor: { visitor_id: 'decision-visitor', fatigue: audit.fatigue_before ?? 0.2 } },
    afterState: { visitor: { visitor_id: 'decision-visitor', fatigue: audit.fatigue_after ?? 0.3 } },
    transitionAudit: audit,
    observationBefore: { marker: 'available-before-action', roads: { edge_002: { travel_time_min: 99 } } }
  };
}
const score = (type, overrides) => computeReward(context(type, overrides));
const weight = name => PARAMETERS[`weight_${name}`].value;

test('R1 reward calculation does not mutate state or audit inputs', () => {
  const input = context();
  const original = structuredClone(input);
  computeReward(input);
  assert.deepEqual(input, original);
});
test('R2 identical attributed transition inputs produce identical reward', () => {
  assert.deepEqual(computeReward(context()), computeReward(context()));
});
test('R3 reward calculation does not call Math.random', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('random used'); };
  try { assert.ok(Number.isFinite(score('VISIT_POI').total)); }
  finally { Math.random = original; }
});
test('R4 longer attributed travel cannot raise efficiency', () => {
  assert.ok(score('EXIT', { actual_travel_time_min: 40 }).components.efficiency
    < score('EXIT', { actual_travel_time_min: 5 }).components.efficiency);
});
test('R5 longer attributed travel gives a larger travel penalty', () => {
  assert.ok(score('EXIT', { actual_travel_time_min: 40 }).components.travel_penalty
    < score('EXIT', { actual_travel_time_min: 5 }).components.travel_penalty);
});
test('R6 longer attributed queue gives a larger queue penalty', () => {
  assert.ok(score('VISIT_POI', { actual_queue_time_min: 40 }).components.queue_penalty
    < score('VISIT_POI', { actual_queue_time_min: 5 }).components.queue_penalty);
});
test('R7 increased decision-visitor fatigue gives a larger penalty', () => {
  assert.ok(score('VISIT_POI', { fatigue_after: 0.6 }).components.fatigue_penalty
    < score('VISIT_POI', { fatigue_after: 0.25 }).components.fatigue_penalty);
});
test('R8 completion requires an attributed completion event', () => {
  assert.equal(score('VISIT_POI').components.completion, 1);
  assert.equal(score('VISIT_POI', { outcome: 'IN_PROGRESS' }).components.completion, null);
  assert.throws(() => score('VISIT_POI', { completion_event: null }), /completion_event/);
});
test('R9 an event miss penalizes only a matching attendance action', () => {
  assert.equal(score('ATTEND_EVENT', { outcome: 'MISSED' }).components.missed_event_penalty, -1);
  assert.equal(score('VISIT_POI').components.missed_event_penalty, null);
  assert.throws(() => score('ATTEND_EVENT', { outcome: 'MISSED',
    missed_event: { kind: 'EVENT_MISSED', visitor_id: 'decision-visitor', target_id: 'other-show' } }), /missed_event/);
});
test('R10 confirmed legal and safe transition has safety score one', () => {
  assert.equal(score('VISIT_POI').components.safety, 1);
});
test('R11 attributed safety violation lowers safety score without a fake closed-road traversal', () => {
  assert.equal(score('VISIT_POI', { safety_violation: true }).components.safety, 0);
});
test('R12 successful rest recovery does not receive a negative fatigue penalty', () => {
  const reward = score('REST');
  assert.equal(reward.components.fatigue_penalty, 0);
  assert.equal(reward.components.completion, 1);
});
test('R13 completed POI visit has explainable attributed components and raw metrics', () => {
  const reward = score('VISIT_POI');
  assert.equal(reward.raw_metrics.action_completed, true);
  assert.equal(reward.raw_metrics.actual_queue_time_min, 5);
  assert.ok(reward.components.efficiency > 0);
  assert.equal(reward.components.experience, null);
});
test('R14 completed event attendance has matching completion evidence', () => {
  const reward = score('ATTEND_EVENT');
  assert.equal(reward.raw_metrics.completion_event, 'EVENT_ATTENDANCE_COMPLETED');
  assert.equal(reward.components.completion, 1);
  assert.equal(reward.components.missed_event_penalty, 0);
});
test('R15 missed attendance has no completion and does have a missed-event penalty', () => {
  const reward = score('ATTEND_EVENT', { outcome: 'MISSED' });
  assert.equal(reward.components.completion, 0);
  assert.equal(reward.components.missed_event_penalty, -1);
  assert.equal(reward.raw_metrics.event_missed, true);
});
test('R16 EXIT completes only with an attributed exit-completed event', () => {
  assert.equal(score('EXIT', { outcome: 'IN_PROGRESS' }).components.completion, null);
  assert.throws(() => score('EXIT', { completion_event: { kind: 'POI_VISIT_COMPLETED',
    visitor_id: 'decision-visitor', target_id: targets.EXIT } }), /completion_event/);
  assert.equal(score('EXIT').components.completion, 1);
});
test('R17 WAIT never receives POI or event completion evidence', () => {
  const reward = score('WAIT');
  assert.equal(reward.raw_metrics.completion_event, 'WAIT_COMPLETED');
  assert.equal(reward.components.travel_penalty, null);
  assert.equal(reward.components.queue_penalty, null);
});
test('R18 not-applicable components stay null and contribute nothing', () => {
  const input = context('REST', { outcome: 'IN_PROGRESS', fatigue_before: null,
    fatigue_after: null, legal_action_confirmed: undefined, safety_violation: undefined });
  const reward = computeReward(input);
  assert.ok(COMPONENTS.every(name => reward.components[name] === null
    && reward.applicability[name].applicable === false));
  assert.equal(reward.total, 0);
});
test('R19 total is exactly the weighted sum of applicable components', () => {
  const reward = score('ATTEND_EVENT', { outcome: 'MISSED' });
  const sum = COMPONENTS.reduce((total, name) => total
    + (reward.components[name] === null ? 0 : reward.weights[name] * reward.components[name]), 0);
  assert.equal(reward.total, Math.round(sum * 1e6) / 1e6);
});
test('R20 all components and total stay within their declared bounds', () => {
  for (const type of Object.keys(targets)) {
    const reward = score(type, { actual_travel_time_min: 1000,
      actual_queue_time_min: 1000, actual_wait_time_min: 1000, fatigue_after: 1 });
    for (const [name, component] of Object.entries(reward.components)) {
      if (component === null) continue;
      assert.ok(component >= (name.endsWith('_penalty') ? -1 : 0));
      assert.ok(component <= (name.endsWith('_penalty') ? 0 : 1));
    }
    assert.ok(reward.total >= reward.total_bounds.min && reward.total <= reward.total_bounds.max);
  }
});
test('R21 every reward parameter and weight is versioned T4/ASSUMPTION', () => {
  assert.equal(REWARD_VERSION, 'reward-p1.1');
  assert.equal(PARAMETER_VERSION, 'reward-params-p1.1');
  assert.ok(Object.values(PARAMETERS).every(item => item.source_tier === 'T4'
    && item.parameter_basis === 'ASSUMPTION' && item.version === PARAMETER_VERSION));
  assert.equal(COMPONENTS.reduce((sum, name) => sum + weight(name), 0), 1);
});
test('R22 result retains raw attributed metrics and parameter versions', () => {
  const reward = score('VISIT_POI');
  assert.equal(reward.raw_metrics.actual_travel_time_min, 10);
  assert.equal(reward.raw_metrics.fatigue_before, 0.2);
  assert.equal(reward.reward_version, REWARD_VERSION);
  assert.equal(reward.parameter_version, PARAMETER_VERSION);
});
test('R23 reward calculation does not change the before-action observation', () => {
  const input = context();
  const before = structuredClone(input.observationBefore);
  computeReward(input);
  assert.deepEqual(input.observationBefore, before);
});
test('R24 standalone reward cannot feed next latent information into current action selection', () => {
  const simulator = createSimulator({ seed: 42 });
  const legalBefore = simulator.getLegalActions();
  const observedBefore = simulator.getObservation();
  const action = legalBefore.legal[0].action;
  const state = simulator.getState();
  const reward = computeReward({ action, beforeState: state, afterState: state,
    observationBefore: observedBefore,
    transitionAudit: { visitor_id: state.visitor.visitor_id,
      action_type: action.action_type, target_id: action.target_id } });
  assert.equal(reward.total, 0);
  assert.deepEqual(simulator.getLegalActions(), legalBefore);
  assert.deepEqual(simulator.getObservation(), observedBefore);
  assert.equal(Object.hasOwn(observedBefore, 'reward'), false);
});
test('R25 reward has no side effects on P0-P1-G simulator invariants', () => {
  const simulator = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const before = simulator.getState();
  const action = simulator.getLegalActions().legal[0].action;
  const step = simulator.step();
  const after = simulator.getState();
  const reward = computeReward({ action, beforeState: before, afterState: after,
    transitionAudit: { visitor_id: before.visitor.visitor_id,
      action_type: action.action_type, target_id: action.target_id } });
  assert.equal(reward.total, 0); // Aggregate step has no attributed decision outcome.
  assert.equal(step.invariant_summary.population, 'PASS');
  assert.equal(step.invariant_summary.road_occupancy, 'PASS');
  assert.deepEqual(simulator.getState(), after);
});
test('R26 time cost deliberately affects efficiency and explicit travel/queue penalties', () => {
  const short = score('VISIT_POI', { actual_travel_time_min: 5, actual_queue_time_min: 5 });
  const long = score('VISIT_POI', { actual_travel_time_min: 10, actual_queue_time_min: 10 });
  assert.ok(long.components.efficiency < short.components.efficiency);
  assert.ok(long.components.travel_penalty < short.components.travel_penalty);
  assert.ok(long.components.queue_penalty < short.components.queue_penalty);
  assert.ok(long.total < short.total);
});
test('R27 completed REST does not outrank a clearly better completed POI transition', () => {
  const rest = score('REST');
  const excellentVisit = score('VISIT_POI', { actual_travel_time_min: 0,
    actual_queue_time_min: 0, fatigue_after: 0.2 });
  assert.ok(rest.total < excellentVisit.total);
});
test('R28 a long WAIT has low total under its action-specific completion weight', () => {
  const short = score('WAIT', { actual_wait_time_min: 5 });
  const long = score('WAIT', { actual_wait_time_min: 60 });
  assert.ok(long.total < short.total);
  assert.ok(long.total < score('VISIT_POI').total);
  assert.equal(long.weights.completion, PARAMETERS.weight_completion_wait.value);
});
test('R29 experience remains inapplicable and its reserved weight contributes nothing', () => {
  const reward = score('VISIT_POI');
  assert.equal(reward.components.experience, null);
  assert.equal(reward.applicability.experience.applicable, false);
  assert.equal(reward.applicability.experience.reason, 'NO_DISTINCT_ATTRIBUTED_QUALITY_METRIC');
  assert.equal(reward.total, Math.round(COMPONENTS.reduce((sum, name) =>
    sum + (reward.components[name] === null ? 0 : reward.components[name] * reward.weights[name]), 0) * 1e6) / 1e6);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/state/stateProvider');
const { createSimulator } = require('../server/simulator/simulator');
const { computeReward } = require('../server/simulator/reward-engine');
const { toMillis } = require('../server/planner/time');

const choose = (sim, type, target) => {
  const item = sim.getLegalActions().legal.find(row => row.action.action_type === type
    && (!target || row.action.target_id === target));
  assert.ok(item, `legal ${type}:${target || '*'}`);
  return item.action;
};
function untilTerminal(sim, maxSteps = 40) {
  const steps = [];
  for (let index = 0; index < maxSteps; index += 1) {
    const step = sim.step();
    steps.push(step);
    if (step.decision_transition?.audit.status !== 'IN_PROGRESS') {
      assert.ok(step.decision_transition, 'transition result');
      return { result: step.decision_transition, steps };
    }
  }
  throw new Error(`transition did not finish in ${maxSteps} steps`);
}
function queuedVisit() {
  const initial = provider.getState();
  for (const id of Object.keys(initial.poi_states)) {
    initial.poi_states[id].queue_min = ['market', 'museum'].includes(id) ? 20 : 0;
  }
  const sim = createSimulator({ initialState: initial, seed: 42 });
  sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
  return { sim, ...untilTerminal(sim) };
}
function completedEvent() {
  const sim = createSimulator({ seed: 42 });
  sim.startDecisionTransition(choose(sim, 'ATTEND_EVENT', 'show-1'));
  return { sim, ...untilTerminal(sim) };
}
function missedEvent() {
  const sim = createSimulator({ seed: 42 });
  sim.runSteps(11);
  sim.startDecisionTransition(choose(sim, 'ATTEND_EVENT', 'show-1'));
  return { sim, ...untilTerminal(sim) };
}
function completedRest() {
  const initial = provider.getState();
  initial.visitor.fatigue = 0.7;
  const sim = createSimulator({ initialState: initial, seed: 42 });
  sim.startDecisionTransition(choose(sim, 'REST', 'rest'));
  return { sim, ...untilTerminal(sim) };
}
function completedExit() {
  const sim = createSimulator({ seed: 42 });
  sim.startDecisionTransition(choose(sim, 'EXIT', 'exit_southgate'));
  return { sim, ...untilTerminal(sim) };
}
function completedWait() {
  const graph = provider.getScenicGraph();
  graph.nodes = graph.nodes.filter(node => ['gate', 'southgate'].includes(node.node_id));
  graph.edges = graph.edges.filter(edge => edge.edge_id === 'edge_001');
  const sim = createSimulator({ initialGraph: graph, seed: 42 });
  sim.startDecisionTransition(choose(sim, 'WAIT', 'wait'));
  return { sim, ...untilTerminal(sim) };
}

test('T1 a legal chosen action creates one active transition', () => {
  const sim = createSimulator({ seed: 42 });
  const started = sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
  assert.equal(started.audit.transition_id, 'transition_000001');
  assert.equal(started.audit.status, 'IN_PROGRESS');
  assert.equal(sim.getActiveDecisionTransition().audit.action.target_id, 'market');
});
test('T2 illegal action is rejected without creating a transition', () => {
  const sim = createSimulator({ seed: 42 });
  assert.throws(() => sim.startDecisionTransition({ action_type: 'VISIT_POI',
    target_id: 'unknown', target_node_id: 'gate' }), error => error.code === 'INVALID_ACTION');
  assert.equal(sim.getActiveDecisionTransition(), null);
});
test('T3 deterministic transition IDs increment only for accepted starts', () => {
  const sequence = () => {
    const sim = createSimulator({ seed: 42 });
    assert.throws(() => sim.startDecisionTransition({ action_type: 'WAIT', target_id: 'wait' }), /INVALID_ACTION/);
    const first = sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market')).audit.transition_id;
    untilTerminal(sim);
    const second = sim.startDecisionTransition(choose(sim, 'EXIT', 'exit_southgate')).audit.transition_id;
    return [first, second];
  };
  assert.deepEqual(sequence(), ['transition_000001', 'transition_000002']);
  assert.deepEqual(sequence(), sequence());
});
test('T4 one action retains its transition ID across multiple simulator steps', () => {
  const sim = createSimulator({ seed: 42 });
  const id = sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market')).audit.transition_id;
  const first = sim.step();
  assert.equal(first.decision_transition.audit.status, 'IN_PROGRESS');
  assert.equal(sim.getActiveDecisionTransition().audit.transition_id, id);
  assert.equal(untilTerminal(sim).result.audit.transition_id, id);
});
test('T5 VISIT travel is accumulated from traversed dynamic edges', () => {
  const { result } = queuedVisit();
  const audit = result.audit;
  assert.ok(audit.actual_travel_time_min > 0);
  assert.equal(audit.actual_route.edges.length, 1);
  assert.equal(audit.actual_travel_time_min, audit.actual_route.edges[0].locked_travel_time_min);
  assert.ok(toMillis(audit.timeline.travel_ended_at) > toMillis(audit.timeline.travel_started_at));
});
test('T6 VISIT queue time is accumulated from its own simulated queue residence', () => {
  const { result } = queuedVisit();
  assert.ok(result.audit.actual_queue_time_min > 5);
  assert.ok(toMillis(result.audit.timeline.queue_ended_at) > toMillis(result.audit.timeline.queue_started_at));
  assert.ok(Math.abs((toMillis(result.audit.timeline.queue_ended_at)
    - toMillis(result.audit.timeline.queue_started_at)) / 60000
    - result.audit.actual_queue_time_min) < 0.001);
});
test('T7 arrival and admission precede POI completion', () => {
  const { result, steps } = queuedVisit();
  assert.ok(steps.some(step => step.decision_transition.audit.phase === 'INSIDE'
    && step.decision_transition.reward === null));
  assert.equal(result.audit.status, 'COMPLETED');
  assert.ok(toMillis(result.audit.timeline.inside_ended_at) > toMillis(result.audit.timeline.inside_started_at));
  assert.equal(result.audit.completion_event.kind, 'POI_VISIT_COMPLETED');
});
test('T8 successful EVENT creates attendance-completion evidence automatically', () => {
  const { result } = completedEvent();
  assert.equal(result.audit.status, 'COMPLETED');
  assert.equal(result.audit.completion_event.kind, 'EVENT_ATTENDANCE_COMPLETED');
  assert.ok(toMillis(result.audit.timeline.attending_ended_at)
    > toMillis(result.audit.timeline.attending_started_at));
});
test('T9 late EVENT creates matching missed evidence automatically', () => {
  const { result } = missedEvent();
  assert.equal(result.audit.status, 'MISSED');
  assert.equal(result.audit.missed_event.kind, 'EVENT_MISSED');
  assert.equal(result.reward.components.missed_event_penalty, -1);
});
test('T10 REST records actual decision-visitor fatigue recovery', () => {
  const { result } = completedRest();
  assert.equal(result.audit.status, 'COMPLETED');
  assert.ok(result.audit.fatigue_after < result.audit.fatigue_before);
  assert.ok(toMillis(result.audit.timeline.rest_ended_at)
    - toMillis(result.audit.timeline.rest_started_at) >= 15 * 60000);
});
test('T11 EXIT completes after reaching the exit and shadow departure', () => {
  const sim = createSimulator({ seed: 42 });
  const baseline = createSimulator({ seed: 42 });
  sim.startDecisionTransition(choose(sim, 'EXIT', 'exit_southgate'));
  assert.equal(sim.getState().visitor.shadow_in_park, true);
  assert.equal(sim.step().decision_transition.audit.status, 'IN_PROGRESS');
  const { result } = untilTerminal(sim);
  assert.equal(result.audit.completion_event.kind, 'EXIT_COMPLETED');
  assert.equal(result.audit.timeline.departure_at, result.audit.ended_at);
  assert.equal(sim.getState().visitor.shadow_in_park, false);
  assert.equal(sim.getLegalActions().legal.length, 0);
  baseline.runSteps(2);
  assert.equal(result.audit.aggregate_population_delta, 0);
  assert.equal(sim.getState().environment.park_population,
    baseline.getState().environment.park_population);
});
test('T12 WAIT lasts its actual simulated duration', () => {
  const { result } = completedWait();
  assert.equal(result.audit.actual_wait_time_min, 10);
  assert.equal(toMillis(result.audit.timeline.wait_ended_at)
    - toMillis(result.audit.timeline.wait_started_at), 10 * 60000);
});
test('T13 in-progress action has no final reward', () => {
  const sim = createSimulator({ seed: 42 });
  assert.equal(sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market')).reward, null);
  assert.equal(sim.step().decision_transition.reward, null);
});
test('T14 terminal action automatically calls the Reward Engine once', () => {
  const { sim, result } = queuedVisit();
  assert.ok(Number.isFinite(result.reward.total));
  assert.equal(sim.getCompletedDecisionTransitions().length, 1);
  assert.deepEqual(sim.getCompletedDecisionTransitions()[0], result);
});
test('T15 Reward raw metrics equal the completed audit facts', () => {
  const { result } = queuedVisit();
  assert.equal(result.reward.raw_metrics.actual_travel_time_min, result.audit.actual_travel_time_min);
  assert.equal(result.reward.raw_metrics.actual_queue_time_min, result.audit.actual_queue_time_min);
  assert.equal(result.reward.raw_metrics.fatigue_after, result.audit.fatigue_after);
});
test('T16 shadow visitor does not add a person to aggregate population', () => {
  const sim = createSimulator({ seed: 42 });
  const baseline = createSimulator({ seed: 42 });
  const initialPopulation = sim.getState().environment.park_population;
  sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
  assert.equal(sim.getState().environment.park_population, initialPopulation);
  for (let i = 0; i < 7; i += 1) {
    sim.step(); baseline.step();
    assert.equal(sim.getState().environment.park_population,
      baseline.getState().environment.park_population);
  }
});
test('T17 transition tracking preserves every population ledger invariant', () => {
  assert.ok(queuedVisit().steps.every(step => step.invariant_summary.population === 'PASS'
    && step.invariant_summary.ledger === 'PASS'));
});
test('T18 transition tracking preserves road occupancy conservation', () => {
  assert.ok(completedEvent().steps.every(step => step.invariant_summary.road_occupancy === 'PASS'));
});
test('T19 starting an action does not mutate the captured observation', () => {
  const sim = createSimulator({ seed: 42 });
  const before = sim.getObservation();
  sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
  assert.deepEqual(sim.getObservation(), before);
});
test('T20 starting audit contains no future outcome, travel, or reward', () => {
  const sim = createSimulator({ seed: 42 });
  const started = sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
  assert.equal(started.audit.ended_at, null);
  assert.equal(started.audit.completion_event, null);
  assert.equal(started.audit.fatigue_after, null);
  assert.equal(started.audit.actual_travel_time_min, 0);
  assert.equal(started.reward, null);
});
test('T21 identical seed and action sequence reproduce complete audit and reward', () => {
  const trace = () => {
    const sim = createSimulator({ seed: 42 });
    sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'market'));
    untilTerminal(sim);
    sim.startDecisionTransition(choose(sim, 'EXIT', 'exit_southgate'));
    untilTerminal(sim);
    return sim.getCompletedDecisionTransitions();
  };
  assert.deepEqual(trace(), trace());
});
test('T22 distinct legal actions produce distinct attributed audits', () => {
  const visit = queuedVisit().result.audit;
  const exit = completedExit().result.audit;
  assert.notEqual(visit.action.action_type, exit.action.action_type);
  assert.notDeepEqual(visit.actual_route.edges, exit.actual_route.edges);
});
test('T23 safety audit is derived from legal action and actual edge entry checks', () => {
  const sim = createSimulator({ seed: 42, events: [
    { event_id: 'close_route', event_type: 'ROAD_CLOSE',
      target_id: 'edge_008', timestamp: '2026-10-20 10:19:00' }
  ] });
  sim.startDecisionTransition(choose(sim, 'VISIT_POI', 'summit'));
  const { result } = untilTerminal(sim);
  assert.equal(result.audit.safety_audit.originally_legal, true);
  assert.equal(result.audit.safety_audit.entered_closed_road, false);
  assert.equal(result.audit.safety_audit.blocked_edge_attempts, 1);
  assert.ok(result.audit.actual_route.edges.length > 0);
  assert.ok(result.audit.actual_route.edges.every(edge => edge.edge_id !== 'edge_008'));
  assert.equal(result.reward.components.safety, 1);
});
test('T24 getState and getObservation remain copy and information boundaries', () => {
  const { sim, result } = completedExit();
  const snapshot = sim.getState();
  snapshot.visitor.fatigue = -1;
  assert.notEqual(sim.getState().visitor.fatigue, -1);
  const observation = sim.getObservation();
  assert.equal(Object.hasOwn(observation, 'reward'), false);
  assert.equal(Object.hasOwn(observation, 'decision_transition'), false);
  assert.equal(Object.hasOwn(observation.visitor, 'shadow_in_park'), false);
  assert.ok(result.reward);
});
test('T25 standalone manual Reward API still works independently of simulator', () => {
  const beforeState = { visitor: { visitor_id: 'manual', fatigue: 0.2 } };
  const afterState = { visitor: { visitor_id: 'manual', fatigue: 0.2 } };
  const action = { action_type: 'WAIT', target_id: 'wait' };
  const transitionAudit = { visitor_id: 'manual', action_type: 'WAIT', target_id: 'wait',
    actual_wait_time_min: 10, fatigue_before: 0.2, fatigue_after: 0.2,
    legal_action_confirmed: true, safety_violation: false, outcome: 'COMPLETED',
    completion_event: { kind: 'WAIT_COMPLETED', visitor_id: 'manual', target_id: 'wait' } };
  const reward = computeReward({ action, beforeState, afterState, transitionAudit });
  assert.equal(reward.raw_metrics.actual_wait_time_min, 10);
  assert.equal(reward.components.completion, 1);
});
test('T26 shadow visitor mode and all episode-relevant versions are traceable', () => {
  const sim = createSimulator({ scenario: 'P0_HIGH', seed: 42 });
  const metadata = sim.getMetadata();
  assert.equal(metadata.visitor_mode, 'SHADOW_VISITOR');
  assert.equal(metadata.seed, 42);
  assert.ok(['graph_version', 'scenario_id', 'simulator_version', 'parameter_version',
    'observation_version', 'reward_version'].every(key => typeof metadata[key] === 'string'));
  assert.equal(metadata.source_tier, 'T4');
  assert.equal(metadata.synthetic, true);
});
test('T27 shadow VISIT does not add a person to the aggregate POI queue', () => {
  const initial = provider.getState();
  for (const id of Object.keys(initial.poi_states)) {
    initial.poi_states[id].queue_min = ['market', 'museum'].includes(id) ? 20 : 0;
  }
  const shadow = createSimulator({ initialState: initial, seed: 42 });
  const baseline = createSimulator({ initialState: initial, seed: 42 });
  shadow.startDecisionTransition(choose(shadow, 'VISIT_POI', 'market'));
  for (let i = 0; i < 8; i += 1) {
    shadow.step(); baseline.step();
    assert.equal(shadow.getState().pois.market.queue_count,
      baseline.getState().pois.market.queue_count);
  }
  assert.ok(shadow.getCompletedDecisionTransitions()[0].audit.actual_queue_time_min > 0);
});
test('T28 shadow transit does not add to aggregate road occupancy', () => {
  const shadow = createSimulator({ seed: 42 });
  const baseline = createSimulator({ seed: 42 });
  shadow.startDecisionTransition(choose(shadow, 'EXIT', 'exit_southgate'));
  for (let i = 0; i < 2; i += 1) {
    shadow.step(); baseline.step();
    assert.deepEqual(Object.fromEntries(Object.entries(shadow.getState().roads)
      .map(([id, road]) => [id, road.occupancy])),
    Object.fromEntries(Object.entries(baseline.getState().roads)
      .map(([id, road]) => [id, road.occupancy])));
  }
  assert.ok(shadow.getCompletedDecisionTransitions()[0].audit.actual_travel_time_min > 0);
});

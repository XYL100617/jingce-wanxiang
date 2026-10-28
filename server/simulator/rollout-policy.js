'use strict';

const { SeededRNG } = require('./seeded-rng');
const { validateVisitorProfile, samplePlanAcceptance, sampleDeviation,
  earlyExitPropensity } = require('./visitor-profile');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => JSON.parse(JSON.stringify(value));

function actionWeight(item, profile, nodeTypes) {
  const type = item.action.action_type;
  if (type === 'EXIT') return 0.25;
  if (type === 'WAIT') return 0.15;
  if (type === 'REST') return 0.5;
  return profile.preference_weights[nodeTypes[item.action.target_node_id]] ?? 1;
}

function selectRolloutAction({ legalActions, recommendedAction, observation, visitorState,
  profile, nodeTypes = {}, seed, decisionIndex, forceExit = false }) {
  validateVisitorProfile(profile);
  if (!Array.isArray(legalActions) || !legalActions.length
    || !Number.isInteger(decisionIndex) || decisionIndex < 0) {
    throw new TypeError('rollout policy requires legal actions and a decision index');
  }
  new SeededRNG(seed);
  const recommended = legalActions.find(item => same(item.action, recommendedAction));
  if (!recommended) throw new Error('recommended action is not legal');
  const exit = legalActions.find(item => item.action.action_type === 'EXIT'
    && item.action.target_node_id !== visitorState.current_node_id)
    || legalActions.find(item => item.action.action_type === 'EXIT');
  const acceptance = samplePlanAcceptance(profile, decisionIndex);
  const deviation = decisionIndex > 0 ? sampleDeviation(profile, decisionIndex)
    : { deviate_at_next_decision: false, draw: null, probability: profile.deviation_rate };
  const earlyExitProbability = earlyExitPropensity(profile, {
    fatigue: visitorState.fatigue, remaining_time_min: visitorState.remaining_time_min,
    weather: observation.weather, completed_visit_count: visitorState.visited_poi_ids.length
  });
  const rng = new SeededRNG((seed ^ Math.imul(decisionIndex + 1, 0x9e3779b9)
    ^ Math.imul(profile.profile_index + 1, 0x85ebca6b) ^ 0x5ac3e4b1) >>> 0);
  const earlyExitDraw = rng.next();
  let chosen = recommended;
  let reason = 'PLAN_ACCEPTED';
  if (forceExit && exit) {
    chosen = exit; reason = 'DECISION_BUDGET_EXIT';
  } else if (exit && earlyExitDraw < earlyExitProbability) {
    chosen = exit; reason = 'EARLY_EXIT';
  } else if (!acceptance.accepted || deviation.deviate_at_next_decision) {
    const alternatives = legalActions.filter(item => !same(item.action, recommended.action)
      && !(item.action.action_type === 'EXIT' && exit
        && item.action.target_node_id === visitorState.current_node_id
        && exit.action.target_node_id !== visitorState.current_node_id));
    if (alternatives.length) {
      const ranked = alternatives.map(item => ({ item,
        weight: actionWeight(item, profile, nodeTypes) }));
      const best = Math.max(...ranked.map(row => row.weight));
      const tied = ranked.filter(row => row.weight === best);
      chosen = rng.choice(tied).item;
      reason = !acceptance.accepted ? 'PLAN_REJECTED' : 'PLAN_DEVIATION';
    }
  }
  const audit = {
    recommended_action: clone(recommended.action), chosen_reason: reason,
    plan_acceptance_draw: acceptance.draw,
    plan_acceptance_probability: acceptance.probability,
    plan_accepted: reason === 'PLAN_ACCEPTED',
    deviation_draw: deviation.draw, deviation_probability: deviation.probability,
    deviation_occurred: reason === 'PLAN_DEVIATION',
    early_exit_draw: earlyExitDraw, early_exit_probability: earlyExitProbability,
    early_exit_occurred: reason === 'EARLY_EXIT',
    preference_weight: actionWeight(chosen, profile, nodeTypes),
    forced_by_decision_budget: reason === 'DECISION_BUDGET_EXIT'
  };
  return { chosen_action: clone(chosen.action), policy_audit: audit };
}

module.exports = { selectRolloutAction };

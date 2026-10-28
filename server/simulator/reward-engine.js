'use strict';

const { REWARD_VERSION, PARAMETER_VERSION, PARAMETERS } = require('./config/reward-parameters');

const ACTION_TYPES = new Set(['VISIT_POI', 'ATTEND_EVENT', 'REST', 'WAIT', 'EXIT']);
const OUTCOMES = new Set(['IN_PROGRESS', 'COMPLETED', 'MISSED', 'FAILED']);
const COMPLETION_KINDS = Object.freeze({ VISIT_POI: 'POI_VISIT_COMPLETED',
  ATTEND_EVENT: 'EVENT_ATTENDANCE_COMPLETED', REST: 'REST_COMPLETED',
  WAIT: 'WAIT_COMPLETED', EXIT: 'EXIT_COMPLETED' });
const COMPONENTS = Object.freeze(['efficiency', 'experience', 'safety', 'completion',
  'travel_penalty', 'queue_penalty', 'fatigue_penalty', 'missed_event_penalty']);
const value = name => PARAMETERS[name].value;
const clamp01 = number => Math.max(0, Math.min(1, number));
const round6 = number => Math.round(number * 1e6) / 1e6 || 0;
const hasNumber = number => typeof number === 'number' && Number.isFinite(number);

function metric(audit, name, max = Infinity) {
  const number = audit[name];
  if (number === undefined || number === null) return null;
  if (!hasNumber(number) || number < 0 || number > max) throw new RangeError(`invalid attributed ${name}`);
  return number;
}

function checkEvidence(evidence, action, visitorId, kind, field) {
  if (!evidence || evidence.visitor_id !== visitorId
    || evidence.target_id !== action.target_id || evidence.kind !== kind) {
    throw new Error(`${field} must identify this visitor, action target, and outcome`);
  }
}

function validateContext(context) {
  if (!context || typeof context !== 'object') throw new TypeError('reward transition context is required');
  const { action, beforeState, afterState, transitionAudit: audit } = context;
  if (!action || !ACTION_TYPES.has(action.action_type) || typeof action.target_id !== 'string') {
    throw new TypeError('supported decision action is required');
  }
  const visitorId = beforeState?.visitor?.visitor_id;
  if (!visitorId || afterState?.visitor?.visitor_id !== visitorId || !audit
    || audit.visitor_id !== visitorId || audit.action_type !== action.action_type
    || audit.target_id !== action.target_id) {
    throw new Error('decision visitor and attributed transition audit must match');
  }
  const outcome = audit.outcome ?? 'IN_PROGRESS';
  if (!OUTCOMES.has(outcome) || (outcome === 'MISSED' && action.action_type !== 'ATTEND_EVENT')) {
    throw new RangeError('invalid attributed action outcome');
  }
  if (outcome === 'COMPLETED') {
    checkEvidence(audit.completion_event, action, visitorId,
      COMPLETION_KINDS[action.action_type], 'completion_event');
  } else if (audit.completion_event !== undefined && audit.completion_event !== null) {
    throw new Error('completion evidence conflicts with an unfinished action');
  }
  if (outcome === 'MISSED') {
    checkEvidence(audit.missed_event, action, visitorId, 'EVENT_MISSED', 'missed_event');
  } else if (audit.missed_event !== undefined && audit.missed_event !== null) {
    throw new Error('missed-event evidence conflicts with action outcome');
  }
  if (audit.legal_action_confirmed !== undefined && typeof audit.legal_action_confirmed !== 'boolean') {
    throw new TypeError('legal_action_confirmed must be boolean');
  }
  if (audit.safety_violation !== undefined && typeof audit.safety_violation !== 'boolean') {
    throw new TypeError('safety_violation must be boolean');
  }
  const fatigueBefore = metric(audit, 'fatigue_before', 1);
  const fatigueAfter = metric(audit, 'fatigue_after', 1);
  if ((fatigueBefore === null) !== (fatigueAfter === null)) {
    throw new Error('fatigue_before and fatigue_after must be supplied together');
  }
  if (fatigueBefore !== null && (beforeState.visitor.fatigue !== fatigueBefore
    || afterState.visitor.fatigue !== fatigueAfter)) {
    throw new Error('attributed fatigue values must match the decision visitor states');
  }
  return { action, audit, visitorId, outcome,
    actual_travel_time_min: metric(audit, 'actual_travel_time_min'),
    actual_queue_time_min: metric(audit, 'actual_queue_time_min'),
    actual_wait_time_min: metric(audit, 'actual_wait_time_min'),
    fatigue_before: fatigueBefore, fatigue_after: fatigueAfter };
}

function computeReward(context) {
  // No aggregate simulator step, forecast, or observation is used as an outcome.
  const input = validateContext(context);
  const { action, audit, visitorId, outcome } = input;
  const components = Object.fromEntries(COMPONENTS.map(name => [name, null]));
  const applicability = Object.fromEntries(COMPONENTS.map(name => [name,
    { applicable: false, reason: 'NO_ATTRIBUTED_INPUT' }]));
  const set = (name, score) => {
    components[name] = round6(score);
    applicability[name] = { applicable: true, reason: null };
  };
  const travel = input.actual_travel_time_min;
  const queue = input.actual_queue_time_min;
  const wait = input.actual_wait_time_min;
  const actionType = action.action_type;
  const travelAction = ['VISIT_POI', 'ATTEND_EVENT', 'EXIT'].includes(actionType);
  const queueAction = ['VISIT_POI', 'ATTEND_EVENT'].includes(actionType);
  let timeCost = null;
  if (queueAction && travel !== null && queue !== null) timeCost = travel + queue;
  if (actionType === 'EXIT' && travel !== null) timeCost = travel;
  if (actionType === 'WAIT' && wait !== null) timeCost = wait;
  if (timeCost !== null) set('efficiency', 1 - clamp01(timeCost / value('efficiency_time_scale_min')));
  if (travelAction && travel !== null) set('travel_penalty', -clamp01(travel / value('travel_penalty_scale_min')));
  if (queueAction && queue !== null) set('queue_penalty', -clamp01(queue / value('queue_penalty_scale_min')));
  if (input.fatigue_before !== null) {
    set('fatigue_penalty', -clamp01(Math.max(0, input.fatigue_after - input.fatigue_before)
      / value('fatigue_delta_scale')));
  }
  if (audit.safety_violation === true || audit.legal_action_confirmed === false) set('safety', 0);
  else if (audit.safety_violation === false && audit.legal_action_confirmed === true) set('safety', 1);
  if (outcome === 'COMPLETED') set('completion', 1);
  else if (outcome === 'MISSED' || outcome === 'FAILED') set('completion', 0);
  if (actionType === 'ATTEND_EVENT' && outcome === 'MISSED') set('missed_event_penalty', -1);
  else if (actionType === 'ATTEND_EVENT' && outcome === 'COMPLETED') set('missed_event_penalty', 0);
  applicability.experience = { applicable: false, reason: 'NO_DISTINCT_ATTRIBUTED_QUALITY_METRIC' };

  const weights = Object.fromEntries(COMPONENTS.map(name => [name, value(`weight_${name}`)]));
  if (actionType === 'WAIT') weights.completion = value('weight_completion_wait');
  const total = round6(COMPONENTS.reduce((sum, name) =>
    sum + (components[name] === null ? 0 : weights[name] * components[name]), 0));
  return {
    reward_version: REWARD_VERSION, parameter_version: PARAMETER_VERSION,
    action_type: actionType, target_id: action.target_id, visitor_id: visitorId,
    components, applicability,
    raw_metrics: {
      attribution: 'DECISION_VISITOR_TRANSITION', source_tier: 'T4',
      actual_travel_time_min: travel, actual_queue_time_min: queue,
      actual_wait_time_min: wait, raw_time_cost_min: timeCost,
      fatigue_before: input.fatigue_before, fatigue_after: input.fatigue_after,
      outcome, action_completed: outcome === 'COMPLETED' ? true
        : ['MISSED', 'FAILED'].includes(outcome) ? false : null,
      event_missed: outcome === 'MISSED' ? true
        : actionType === 'ATTEND_EVENT' && outcome === 'COMPLETED' ? false : null,
      completion_event: audit.completion_event?.kind ?? null,
      missed_event: audit.missed_event?.kind ?? null,
      legal_action_confirmed: audit.legal_action_confirmed ?? null,
      safety_violation: audit.safety_violation ?? null
    },
    weights, total, total_bounds: { min: -0.35, max: 0.65 }
  };
}

module.exports = { computeReward, COMPONENTS, COMPLETION_KINDS };

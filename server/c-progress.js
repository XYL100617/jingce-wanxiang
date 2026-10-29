'use strict';

// C-layer progress events. These are deliberately thin: the actual route is
// still planned by B and the progress event is normalised into B's existing
// UserEvent vocabulary before it reaches the planner.
const PROGRESS_EVENT_TYPES = new Set(['ARRIVE', 'SKIP', 'DELAY', 'DEVIATE', 'EXIT_CHANGE']);

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`ProgressEvent.${field} 为必填字符串`);
  return value;
}

function optionalNumber(value, field, min, max = Infinity) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`ProgressEvent.${field} 必须在 ${min} 至 ${max} 之间`);
  }
  return Number(value);
}

function normalizeProgressEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ProgressEvent 必须是对象');
  if (!PROGRESS_EVENT_TYPES.has(raw.event_type)) return { event: raw, progress: null, eventId: null, exitNodeId: null };

  const eventId = raw.event_id === undefined || raw.event_id === null ? null : requiredString(raw.event_id, 'event_id');
  const timestamp = raw.timestamp;
  const base = {};
  if (raw.schema_version) base.schema_version = raw.schema_version;
  if (raw.scenario_id) base.scenario_id = raw.scenario_id;
  if (timestamp) base.timestamp = timestamp;

  const progress = {
    event_id: eventId,
    event_type: raw.event_type,
    target_id: raw.target_id || null,
    target_type: raw.target_type || null,
    node_id: raw.node_id || raw.current_node_id || null,
    timestamp: timestamp || null,
    remaining_time_min: raw.remaining_time_min ?? null,
    fatigue: raw.fatigue ?? null,
  };

  if (raw.event_type === 'ARRIVE') {
    requiredString(raw.target_id, 'target_id');
    requiredString(progress.node_id, 'node_id');
    // A park exit has no "visited POI" flag in B's model. Treat arrival there
    // as a position update, not as a fake completed attraction.
    const arrivingAtExit = raw.target_type === 'EXIT';
    return {
      event: {
        ...base,
        event_type: 'PROGRESS_UPDATE',
        current_node_id: progress.node_id,
        ...(!arrivingAtExit ? { target_id: raw.target_id } : {}),
        ...(raw.remaining_time_min !== undefined ? { remaining_time_min: optionalNumber(raw.remaining_time_min, 'remaining_time_min', 0) } : {}),
        ...(raw.fatigue !== undefined ? { fatigue: optionalNumber(raw.fatigue, 'fatigue', 0, 1) } : {}),
      },
      progress,
      eventId,
      exitNodeId: null,
    };
  }

  if (raw.event_type === 'SKIP') {
    requiredString(raw.target_id, 'target_id');
    return { event: { ...base, event_type: 'SKIP_TARGET', target_id: raw.target_id }, progress, eventId, exitNodeId: null };
  }

  if (raw.event_type === 'DELAY' || raw.event_type === 'DEVIATE') {
    requiredString(progress.node_id, 'node_id');
    return {
      event: {
        ...base,
        event_type: 'PROGRESS_UPDATE',
        current_node_id: progress.node_id,
        ...(raw.remaining_time_min !== undefined ? { remaining_time_min: optionalNumber(raw.remaining_time_min, 'remaining_time_min', 0) } : {}),
        ...(raw.fatigue !== undefined ? { fatigue: optionalNumber(raw.fatigue, 'fatigue', 0, 1) } : {}),
      },
      progress,
      eventId,
      exitNodeId: null,
    };
  }

  // EXIT_CHANGE only changes the planner's preferred exit, then asks B for a
  // fresh plan from the current state. It never fabricates a new position.
  const exitNodeId = requiredString(progress.node_id, 'node_id');
  return {
    event: { ...base, event_type: 'REQUEST_REPLAN' },
    progress,
    eventId,
    exitNodeId,
  };
}

function planStopKey(item) {
  return `${item?.action_type || 'ACTION'}:${item?.target_id || ''}`;
}

function summarizePlanChange(previousPlan, nextPlan, progress = null) {
  const previousStops = (previousPlan?.itinerary || []).map(planStopKey);
  const nextStops = (nextPlan?.itinerary || []).map(planStopKey);
  const previousSet = new Set(previousStops);
  const nextSet = new Set(nextStops);
  const removed = previousStops.filter(key => !nextSet.has(key));
  const added = nextStops.filter(key => !previousSet.has(key));
  const commonPrevious = previousStops.filter(key => nextSet.has(key));
  const commonNext = nextStops.filter(key => previousSet.has(key));
  const reordered = commonPrevious.join('>') !== commonNext.join('>');
  const changeCount = removed.length + added.length + (reordered ? 1 : 0);
  return {
    trigger: progress?.event_type || null,
    previous_plan_id: previousPlan?.plan_id || null,
    next_plan_id: nextPlan?.plan_id || null,
    previous_state_version: previousPlan?.based_on_state_version || null,
    next_state_version: nextPlan?.based_on_state_version || null,
    previous_forecast_version: previousPlan?.based_on_forecast_version || null,
    next_forecast_version: nextPlan?.based_on_forecast_version || null,
    from_node_id: nextPlan?.replan?.from_node_id || progress?.node_id || null,
    removed,
    added,
    reordered,
    changed: changeCount > 0,
    reason: changeCount
      ? (nextPlan?.reason || '当前状态变化后重新规划')
      : '路线保持，仅更新游客进度',
  };
}

module.exports = { PROGRESS_EVENT_TYPES, normalizeProgressEvent, summarizePlanChange };

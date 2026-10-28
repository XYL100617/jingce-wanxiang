'use strict';

const { parseTime, stamp } = require('../state/scenarioEngine');

const TYPES = new Set(['ROAD_CLOSE', 'ROAD_REOPEN', 'POI_CLOSE', 'POI_OPEN',
  'SHOW_BOARDING', 'SHOW_START', 'SHOW_LATEST_ENTRY', 'SHOW_END']);
// Reopen first, close last: a same-time conflict remains closed.
const PRIORITY = { ROAD_REOPEN: 0, POI_OPEN: 0, SHOW_BOARDING: 0, SHOW_START: 0,
  ROAD_CLOSE: 1, POI_CLOSE: 1, SHOW_LATEST_ENTRY: 1, SHOW_END: 1 };

class EventClock {
  constructor(startTime, stepMin, events = []) {
    if (!Number.isInteger(stepMin) || stepMin <= 0) throw new RangeError('stepMin must be a positive integer');
    this.startMs = parseTime(startTime, 'simulation start time');
    this.currentMs = this.startMs;
    this.stepMs = stepMin * 60000;
    this.stepIndex = 0;
    this.events = events.map((event, index) => {
      if (!event || !TYPES.has(event.event_type)) throw new RangeError(`unsupported P0 event type at index ${index}`);
      const timeMs = parseTime(event.timestamp, 'event timestamp');
      if (timeMs < this.startMs) throw new RangeError(`event precedes simulation start: ${event.event_type}`);
      if (typeof event.target_id !== 'string' || !event.target_id) throw new TypeError(`event target_id required: ${event.event_type}`);
      return { ...event, timeMs, order: index, event_id: event.event_id || `p0_event_${index + 1}` };
    }).sort((a, b) => a.timeMs - b.timeMs || PRIORITY[a.event_type] - PRIORITY[b.event_type]
      || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0) || a.order - b.order);
  }

  nextStep() {
    const startMs = this.currentMs;
    const endMs = this.startMs + (++this.stepIndex) * this.stepMs;
    const checkpoints = [];
    while (this.events.length && this.events[0].timeMs <= endMs) {
      const event = this.events.shift();
      const last = checkpoints.at(-1);
      if (last && last.timeMs === event.timeMs) last.events.push(event);
      else checkpoints.push({ timeMs: event.timeMs, timestamp: stamp(event.timeMs), events: [event] });
    }
    if (!checkpoints.length || checkpoints.at(-1).timeMs !== endMs) checkpoints.push({ timeMs: endMs, timestamp: stamp(endMs), events: [] });
    this.currentMs = endMs;
    return { startMs, endMs, checkpoints };
  }
}

module.exports = { EventClock, TYPES };

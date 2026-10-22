'use strict';

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim();
  const wallClock = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (wallClock) {
    const [, y, m, d, hh, mm, ss = '0'] = wallClock;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`无效时间格式: ${value}`);
  return parsed;
}

function formatTimestamp(value) {
  const date = new Date(toMillis(value));
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function addMinutes(value, minutes) {
  return formatTimestamp(toMillis(value) + Number(minutes) * 60000);
}

function diffMinutes(later, earlier) {
  return (toMillis(later) - toMillis(earlier)) / 60000;
}

module.exports = { toMillis, formatTimestamp, addMinutes, diffMinutes };

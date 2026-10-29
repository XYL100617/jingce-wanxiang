const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const DAY_MS = 86400000;
const COUNTER_KEYS = ['conversations', 'turns', 'external_calls', 'cloud_successes', 'local_responses', 'input_tokens', 'output_tokens', 'budget_tokens', 'unconfirmed_tokens', 'cloud_cache_hits', 'local_cache_hits', 'fallbacks'];
function dayAt(time) { return new Date(Number(time) + 8 * 3600000).toISOString().slice(0, 10); }
function freshDay(day) {
  return { day, ...Object.fromEntries(COUNTER_KEYS.map(key => [key, 0])), conversation_ids: [], fallback_reasons: {}, reservations: {}, circuits: {}, costs: {} };
}
function reasonCode(value) { return /^[a-z_]{1,40}$/.test(value || '') ? value : 'local_fallback'; }
function addConversation(row, sessionId) {
  row.turns++;
  if (!sessionId) { row.conversations++; return; }
  const id = createHash('sha256').update(String(sessionId)).digest('hex');
  if (!row.conversation_ids.includes(id)) {
    row.conversations++;
    // No user text or raw session identifier is persisted. Once the bounded
    // set fills, excess sessions are conservatively counted per turn.
    if (row.conversation_ids.length < 10000) row.conversation_ids.push(id);
  }
}
function addFallback(row, reason) {
  const code = reasonCode(reason);
  row.fallbacks++;
  row.local_responses++;
  row.fallback_reasons[code] = (row.fallback_reasons[code] || 0) + 1;
}

function createBudgetLedger({ ledgerPath, now = () => Date.now() }) {
  function read() {
    if (!fs.existsSync(ledgerPath)) return { version: 1, last_day: null, days: {} };
    if (fs.statSync(ledgerPath).size > 16 * 1024 * 1024) throw new Error('ledger_unavailable');
    const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (data?.version !== 1 || !data.days || Array.isArray(data.days) || typeof data.days !== 'object') throw new Error('ledger_unavailable');
    if (data.last_day !== undefined && data.last_day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(data.last_day)) throw new Error('ledger_unavailable');
    for (const [day, row] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || row?.day !== day || COUNTER_KEYS.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0) || !Array.isArray(row.conversation_ids) || !row.reservations || !row.fallback_reasons || !row.circuits || !row.costs) throw new Error('ledger_unavailable');
    }
    return data;
  }
  function mutate(operation) {
    let lock;
    let temporary;
    const lockPath = `${ledgerPath}.lock`;
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      // A stale lock fails closed. Never delete a lock owned by another process.
      lock = fs.openSync(lockPath, 'wx', 0o600);
      const data = read();
      const day = dayAt(now());
      data.last_day = [day, data.last_day, ...Object.keys(data.days)].filter(Boolean).sort().at(-1);
      data.days[day] ||= freshDay(day);
      const result = operation(data, data.days[day], day);
      // Keep outstanding reservations on their original day across midnight.
      for (const oldDay of Object.keys(data.days)) {
        if (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${oldDay}T00:00:00Z`) > 7 * DAY_MS) delete data.days[oldDay];
      }
      temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
      const file = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(file, JSON.stringify(data)); fs.fsyncSync(file); } finally { fs.closeSync(file); }
      fs.renameSync(temporary, ledgerPath);
      temporary = null;
      return { ok: true, value: result };
    } catch (_) {
      return { ok: false, reason: 'ledger_unavailable' };
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
      if (lock !== undefined) { try { fs.closeSync(lock); } catch (_) {} try { fs.unlinkSync(lockPath); } catch (_) {} }
    }
  }
  return {
    noteTurn(sessionId) { return mutate((_, row) => addConversation(row, sessionId)); },
    noteLocal({ sessionId, cacheHit = false, fallback = false, reason } = {}) {
      return mutate((_, row) => { addConversation(row, sessionId); if (cacheHit) row.local_cache_hits++; if (fallback) addFallback(row, reason); else row.local_responses++; });
    },
    noteFallback(reason) { return mutate((_, row) => addFallback(row, reason)); },
    noteCacheHit() { return mutate((_, row) => { row.cloud_cache_hits++; }); },
    reserve(config, circuitKey) {
      return mutate((data, row, day) => {
        if (day < data.last_day) return { ok: false, reason: 'clock_rollback' };
        if (row.circuits[circuitKey]) return { ok: false, reason: 'circuit_open' };
        const tokens = config.maxInputTokens + config.maxOutputTokens;
        if (row.external_calls >= config.dailyRequestLimit || row.budget_tokens + tokens > config.dailyTokenLimit) return { ok: false, reason: 'daily_limit' };
        const id = randomUUID();
        row.external_calls++;
        row.budget_tokens += tokens;
        row.unconfirmed_tokens += tokens;
        row.reservations[id] = { input: config.maxInputTokens, output: config.maxOutputTokens, confirmed: false, input_price: config.inputPricePerMillion, output_price: config.outputPricePerMillion, currency: config.currency };
        const cost = row.costs[config.currency] ||= { known: 0, unknown: 0 };
        if (config.inputPricePerMillion === null || config.outputPricePerMillion === null) cost.unknown++;
        else cost.known += (config.maxInputTokens * config.inputPricePerMillion + config.maxOutputTokens * config.outputPricePerMillion) / 1000000;
        return { ok: true, id, day, tokens };
      });
    },
    settle(reservation, usage, { success = false, circuitKey = null } = {}) {
      return mutate((data) => {
        const row = data.days[reservation.day];
        const held = row?.reservations?.[reservation.id];
        if (!held || held.confirmed) return null;
        if (success) row.cloud_successes++;
        if (circuitKey) row.circuits[circuitKey] = true;
        const input = usage?.prompt_tokens, output = usage?.completion_tokens, total = usage?.total_tokens;
        const valid = Number.isSafeInteger(input) && input >= 0 && input <= held.input && Number.isSafeInteger(output) && output >= 0 && output <= held.output && (total === undefined || total === input + output);
        if (!valid) return null;
        held.confirmed = true;
        row.budget_tokens += input + output - held.input - held.output;
        row.unconfirmed_tokens -= held.input + held.output;
        row.input_tokens += input;
        row.output_tokens += output;
        if (held.input_price !== null && held.output_price !== null) row.costs[held.currency].known += ((input - held.input) * held.input_price + (output - held.output) * held.output_price) / 1000000;
        return { input_tokens: input, output_tokens: output, total_tokens: input + output };
      });
    },
    snapshot() {
      try { return { ok: true, value: read().days[dayAt(now())] || freshDay(dayAt(now())) }; }
      catch (_) { return { ok: false, reason: 'ledger_unavailable', value: freshDay(dayAt(now())) }; }
    }
  };
}
module.exports = { createBudgetLedger, dayAt };

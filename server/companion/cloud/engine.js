const path = require('path');
const { createHash } = require('crypto');
const { createCloudConfig, publicCloudConfig } = require('./config');
const { createProvider } = require('./providers');
const { createBudgetLedger } = require('./budget');

function inputUpperBound(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 8) return null;
  if (messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || Object.keys(message).some(key => !['role', 'content'].includes(key)))) return null;
  // Bytes, rather than characters/4, give a conservative ceiling for the
  // supported byte-level tokenizers; include chat framing and JSON overhead.
  return 64 + messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8') + 16, 0);
}

function createCloudEngine({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), ledgerPath = path.join(__dirname, '../../data/companion-usage.local.json') } = {}) {
  const settings = createCloudConfig(env);
  const provider = createProvider(settings, { fetchImpl });
  const ledger = createBudgetLedger({ ledgerPath, now });
  const cache = new Map();
  // A corrected credential must not inherit a previous key's authentication
  // failure. This changes the circuit identity without exposing the key.
  const circuitKey = createHash('sha256').update(`${settings.provider}:${settings.model}:${settings.region}:${settings.apiKey}`).digest('hex');
  let active = 0;
  let storageBlocked = false;
  function recordFallback(reason) {
    if (!ledger.noteFallback(reason).ok) storageBlocked = true;
  }
  function fail(reason, attempted = false, status = null) { recordFallback(reason); return { ok: false, reason, attempted, ...(Number.isInteger(status) ? { status } : {}) }; }
  function validContent(content, validateContent) {
    if (!validateContent) return true;
    try { return validateContent(content) === true; } catch (_) { return false; }
  }
  function cacheId(messages, cacheKey) {
    // A caller-provided key alone cannot share one user's context with another.
    return createHash('sha256').update(JSON.stringify([settings.provider, settings.model, messages, String(cacheKey || '')])).digest('hex');
  }
  async function run({ messages, cacheKey, sessionId, validateContent } = {}) {
    if (!ledger.noteTurn(sessionId).ok) storageBlocked = true;
    if (settings.blockedReason) return fail(settings.blockedReason);
    if (storageBlocked) return fail('ledger_unavailable');
    const estimatedInput = inputUpperBound(messages);
    if (estimatedInput === null) return fail('invalid_messages');
    if (estimatedInput > settings.maxInputTokens) return fail('input_limit');
    const id = cacheId(messages, cacheKey);
    const cached = cache.get(id);
    if (cached?.expires > Number(now()) && validContent(cached.content, validateContent)) {
      if (!ledger.noteCacheHit().ok) { storageBlocked = true; return fail('ledger_unavailable'); }
      return { ok: true, content: cached.content, provider: settings.provider, model: settings.model, cached: true, attempted: false, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    }
    if (cached) cache.delete(id);
    if (active >= settings.maxConcurrency) return fail('concurrency');
    const held = ledger.reserve(settings, circuitKey);
    if (!held.ok) { storageBlocked = true; return fail('ledger_unavailable'); }
    if (!held.value.ok) return fail(held.value.reason);
    active++;
    const controller = new AbortController();
    let timer;
    let completed = false;
    let requestDone = false;
    let returned = false;
    let result;
    try {
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false, reason: 'timeout' }); }, settings.timeoutMs);
      });
      const request = provider.complete(messages, { signal: controller.signal })
        .catch(() => ({ ok: false, reason: controller.signal.aborted ? 'timeout' : 'provider_error' }))
        .finally(() => { requestDone = true; if (returned) active--; });
      result = await Promise.race([request, deadline]);
      if (result.ok && !validContent(result.content, validateContent)) result = { ...result, ok: false, reason: 'invalid_output' };
      const reconciled = ledger.settle(held.value, result.usage, { success: result.ok, circuitKey: result.circuit ? circuitKey : null });
      completed = true;
      if (!reconciled.ok) { storageBlocked = true; return fail('ledger_unavailable', true); }
      if (!result.ok) return fail(result.reason || 'provider_error', true, result.status);
      if (settings.cacheTtlMs > 0) {
        for (const [key, entry] of cache) if (entry.expires <= Number(now())) cache.delete(key);
        while (cache.size >= settings.cacheMaxEntries) cache.delete(cache.keys().next().value);
        cache.set(id, { content: result.content, expires: Number(now()) + settings.cacheTtlMs });
      }
      return { ok: true, content: result.content, provider: settings.provider, model: settings.model, cached: false, attempted: true, usage: reconciled.value || { input_tokens: null, output_tokens: null, total_tokens: null, reserved_tokens: held.value.tokens } };
    } catch (_) {
      return fail('provider_error', true);
    } finally {
      clearTimeout(timer);
      if (!completed) ledger.settle(held.value, null);
      returned = true;
      // An uncooperative transport must not free a slot while its request is
      // still running. The caller still receives the bounded local fallback.
      if (requestDone) active--;
    }
  }
  function recordLocal(options = {}) {
    const result = ledger.noteLocal(options);
    if (!result.ok) storageBlocked = true;
  }
  function report() {
    const snapshot = ledger.snapshot();
    const row = snapshot.value;
    const { conversation_ids, reservations, circuits, costs, ...counters } = row;
    const currencies = Object.keys(costs);
    const unknownPrice = currencies.length > 1 || currencies.some(currency => costs[currency].unknown > 0);
    const amount = !snapshot.ok ? null : !row.external_calls ? 0 : unknownPrice ? null : Number((costs[currencies[0]]?.known || 0).toFixed(8));
    const estimatedCost = {
      currency: currencies.length === 1 ? currencies[0] : settings.currency,
      amount,
      nominal_upper_bound: amount,
      pricing_configured: snapshot.ok && !unknownPrice && (settings.inputPricePerMillion !== null && settings.outputPricePerMillion !== null),
      free_quota_applied: false,
      basis: !snapshot.ok ? 'storage_unavailable' : row.unconfirmed_tokens ? 'confirmed_usage_plus_unconfirmed_reservations' : 'confirmed_usage',
      note: 'Nominal estimate before free quota; provider bill and console determine actual charges.'
    };
    const scale = row.conversations ? 100 / row.conversations : 0;
    return {
      ...counters,
      time_zone: 'Asia/Shanghai',
      storage_available: snapshot.ok && !storageBlocked,
      cache_hits: row.cloud_cache_hits + row.local_cache_hits,
      active_requests: active,
      config: publicCloudConfig(settings),
      limits: publicCloudConfig(settings).limits,
      estimated_cost: estimatedCost,
      per_100_conversations: {
        external_calls: Number((row.external_calls * scale).toFixed(4)),
        input_tokens: Number((row.input_tokens * scale).toFixed(4)),
        output_tokens: Number((row.output_tokens * scale).toFixed(4)),
        budget_tokens: Number((row.budget_tokens * scale).toFixed(4)),
        cache_hits: Number(((row.cloud_cache_hits + row.local_cache_hits) * scale).toFixed(4)),
        fallbacks: Number((row.fallbacks * scale).toFixed(4)),
        estimated_cost: { ...estimatedCost, amount: amount === null ? null : Number((amount * scale).toFixed(8)), nominal_upper_bound: amount === null ? null : Number((amount * scale).toFixed(8)) }
      }
    };
  }
  return { run, recordLocal, recordFallback, report, config: publicCloudConfig(settings) };
}
module.exports = { createCloudEngine, inputUpperBound };

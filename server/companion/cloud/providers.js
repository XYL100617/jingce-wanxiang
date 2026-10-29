// Only these official shared API endpoints are reachable. Redirects are disabled
// so neither environment configuration nor a provider redirect can forward keys.
const ALLOWED_ENDPOINTS = new Set([
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions',
  'https://api.deepseek.com/v1/chat/completions',
  'https://open.bigmodel.cn/api/paas/v4/chat/completions'
]);
const MAX_RESPONSE_BYTES = 65536;

async function discardBody(response) {
  try { await response.body?.cancel?.(); } catch (_) {}
}
async function readJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    throw new Error('response_limit');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error('response_limit');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  // Test doubles and small custom fetch implementations can expose json only.
  const value = await response.json();
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response_limit');
  return value;
}

function createProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  return {
    async complete(messages, { signal } = {}) {
      const endpoint = `${config.baseUrl}/chat/completions`;
      if (!ALLOWED_ENDPOINTS.has(endpoint) || typeof fetchImpl !== 'function') return { ok: false, reason: 'invalid_config' };
      const payload = {
        model: config.model,
        messages,
        max_tokens: config.maxOutputTokens,
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' },
        ...(config.provider === 'qwen' ? { enable_thinking: false } : { thinking: { type: 'disabled' } })
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal
      });
      if (!response?.ok) {
        const status = Number(response?.status);
        // Do not return provider error bodies: some gateways echo prompts/keys.
        if (response) await discardBody(response);
        return { ok: false, reason: 'provider_error', circuit: [400, 401, 402, 403, 404, 422, 429].includes(status), status };
      }
      const body = await readJson(response);
      const choice = body?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > config.maxOutputTokens * 8 || choice?.message?.tool_calls?.length || (choice?.finish_reason && choice.finish_reason !== 'stop')) {
        return { ok: false, reason: 'invalid_output', usage: body?.usage };
      }
      return { ok: true, content: content.trim(), usage: body?.usage };
    }
  };
}
module.exports = { createProvider, ALLOWED_ENDPOINTS };

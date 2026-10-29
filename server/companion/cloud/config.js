const QWEN_BASE_URLS = Object.freeze({
  'cn-beijing': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  us: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
});

function flag(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function rate(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100000 ? parsed : null;
}
function createCloudConfig(env = process.env) {
  const requestedProvider = String(env.COMPANION_PROVIDER || 'local').trim().toLowerCase();
  const provider = ['local', 'qwen', 'deepseek', 'zhipu'].includes(requestedProvider) ? requestedProvider : 'local';
  const rawRegion = String(env.COMPANION_QWEN_REGION || 'cn-beijing').trim().toLowerCase();
  const region = ({ 'ap-southeast-1': 'intl', 'sg': 'intl', 'us-east-1': 'us' })[rawRegion] || rawRegion;
  const defaultModel = provider === 'deepseek' ? 'deepseek-flash' : provider === 'zhipu' ? 'glm-4.7-flash' : 'qwen-flash';
  const rawModel = String(env.COMPANION_MODEL || defaultModel).trim();
  const validModel = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawModel);
  const rawKey = String(provider === 'qwen' ? (env.DASHSCOPE_API_KEY || '') : provider === 'deepseek' ? (env.DEEPSEEK_API_KEY || '') : provider === 'zhipu' ? (env.ZHIPU_API_KEY || '') : '').trim();
  const apiKey = rawKey.length <= 1024 && !/\s/.test(rawKey) ? rawKey : '';
  const freeOnly = flag(env.COMPANION_QWEN_FREE_ONLY, true);
  const allowPaid = flag(env.COMPANION_ALLOW_PAID);
  const freeOnlyConfirmed = flag(env.COMPANION_QWEN_FREE_ONLY_CONFIRMED);
  const zhipuFreeOnlyConfirmed = flag(env.COMPANION_ZHIPU_FREE_ONLY_CONFIRMED);
  const validRegion = Object.hasOwn(QWEN_BASE_URLS, region);
  let blockedReason = null;
  if (provider === 'local') blockedReason = 'local_disabled';
  else if (!apiKey) blockedReason = 'no_key';
  else if (!validModel || (provider === 'qwen' && !validRegion)) blockedReason = 'invalid_config';
  else if (provider === 'qwen' && freeOnly && (!freeOnlyConfirmed || region !== 'cn-beijing')) blockedReason = 'free_guard';
  else if (provider === 'zhipu' && rawModel !== 'glm-4.7-flash') blockedReason = 'free_model_only';
  else if (provider === 'zhipu' && !zhipuFreeOnlyConfirmed) blockedReason = 'free_guard';
  else if ((provider === 'deepseek' || !freeOnly) && !allowPaid) blockedReason = 'paid_guard';
  return Object.freeze({
    provider,
    model: validModel ? rawModel : '',
    region,
    apiKey,
    baseUrl: provider === 'qwen' ? (QWEN_BASE_URLS[region] || '') : provider === 'deepseek' ? 'https://api.deepseek.com/v1' : provider === 'zhipu' ? 'https://open.bigmodel.cn/api/paas/v4' : '',
    freeOnly,
    freeOnlyConfirmed,
    zhipuFreeOnlyConfirmed,
    allowPaid,
    blockedReason,
    dailyRequestLimit: integer(env.COMPANION_DAILY_REQUEST_LIMIT, 100, 0, 100000),
    dailyTokenLimit: integer(env.COMPANION_DAILY_TOKEN_LIMIT, 100000, 0, 100000000),
    maxInputTokens: integer(env.COMPANION_MAX_INPUT_TOKENS, 1536, 64, 8192),
    maxOutputTokens: integer(env.COMPANION_MAX_OUTPUT_TOKENS, provider === 'zhipu' ? 256 : 128, 16, 1024),
    timeoutMs: integer(env.COMPANION_TIMEOUT_MS, provider === 'zhipu' ? 8000 : 3500, 50, 10000),
    maxConcurrency: integer(env.COMPANION_MAX_CONCURRENCY, 2, 1, 4),
    cacheTtlMs: integer(env.COMPANION_CACHE_TTL_MS, 600000, 100, 3600000),
    cacheMaxEntries: 300,
    inputPricePerMillion: rate(env.COMPANION_INPUT_PRICE_PER_MILLION),
    outputPricePerMillion: rate(env.COMPANION_OUTPUT_PRICE_PER_MILLION),
    currency: /^[A-Z]{3}$/.test(env.COMPANION_PRICE_CURRENCY || '') ? env.COMPANION_PRICE_CURRENCY : 'CNY'
  });
}
function publicCloudConfig(config) {
  return {
    provider: config.provider,
    model: config.model,
    region: config.provider === 'qwen' ? config.region : null,
    enabled: !config.blockedReason,
    blocked_reason: config.blockedReason,
    key_configured: Boolean(config.apiKey),
    free_only: config.provider === 'zhipu' || (config.provider === 'qwen' && config.freeOnly),
    free_only_confirmed: config.provider === 'zhipu' ? config.zhipuFreeOnlyConfirmed : config.provider === 'qwen' && config.freeOnlyConfirmed,
    allow_paid: config.allowPaid,
    limits: {
      daily_requests: config.dailyRequestLimit,
      daily_tokens: config.dailyTokenLimit,
      max_input_tokens: config.maxInputTokens,
      max_output_tokens: config.maxOutputTokens,
      timeout_ms: config.timeoutMs,
      concurrency: config.maxConcurrency
    }
  };
}
module.exports = { createCloudConfig, publicCloudConfig, QWEN_BASE_URLS };

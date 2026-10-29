// Server-side adapter for Baidu Qianfan short-text speech synthesis.
// Credentials and billing confirmation stay in server environment variables.
const { randomUUID } = require('node:crypto');

const SPEAKERS = Object.freeze({ guide: 1, food: 0, photo: 3, outdoor: 4, story: 1 });
const ENDPOINT = 'https://tsn.baidu.com/text2audio';

function createQianfanTts({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = String(env.QIANFAN_TTS_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
  const freeConfirmed = env.QIANFAN_TTS_FREE_CONFIRMED === 'true';
  const enabled = Boolean(apiKey && freeConfirmed);
  const dailyLimit = Math.max(1, Math.min(5000, Number(env.QIANFAN_TTS_DAILY_REQUESTS) || 100));
  const audioCache = new Map();
  let requestDay = new Date().toISOString().slice(0, 10), requestCount = 0;

  function status() {
    return {
      qianfan_tts_ready: enabled,
      tts_ready: enabled,
      tts_provider: enabled ? 'qianfan' : null,
      qianfan_tts_reason: enabled ? null : !apiKey ? 'credentials_not_configured' : 'free_status_unconfirmed',
    };
  }

  async function synthesize({ text, voice = 'guide' }) {
    if (!enabled) {
      const error = new Error('千帆语音合成尚未配置，或尚未确认账号免费额度');
      error.statusCode = 503;
      throw error;
    }
    if (typeof fetchImpl !== 'function') {
      const error = new Error('当前 Node.js 运行环境不支持 fetch，请升级到 Node.js 18 或更高版本');
      error.statusCode = 503;
      throw error;
    }
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText || cleanText.length > 400 || SPEAKERS[voice] === undefined) {
      const error = new Error('播报内容为空、过长或讲解员无效');
      error.statusCode = 400;
      throw error;
    }
    const cacheKey = `${voice}\n${cleanText}`;
    if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== requestDay) { requestDay = today; requestCount = 0; }
    if (requestCount >= dailyLimit) {
      const error = new Error('今日语音合成保护额度已用完');
      error.statusCode = 429;
      throw error;
    }
    // Reserve before awaiting the provider so concurrent calls cannot bypass
    // the application-side daily guard. Failed attempts also consume the guard.
    requestCount++;

    const form = new URLSearchParams({
      tex: cleanText,
      cuid: `jingce-${randomUUID()}`,
      ctp: '1',
      lan: 'zh',
      per: String(SPEAKERS[voice]),
      spd: '5',
      pit: '5',
      vol: '5',
      aue: '3',
    });
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
    } catch (_) {
      const error = new Error('无法连接百度千帆语音合成服务');
      error.statusCode = 502;
      throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.toLowerCase().startsWith('audio/')) {
      let providerCode = '';
      try {
        const body = await response.json();
        providerCode = body.err_no === undefined ? '' : `（错误码 ${body.err_no}）`;
      } catch (_) {}
      const error = new Error(`百度语音合成未返回音频${providerCode}`);
      error.statusCode = 502;
      throw error;
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 1200000) {
      const error = new Error('百度语音合成返回的音频为空或过大');
      error.statusCode = 502;
      throw error;
    }
    const result = { audio_base64: audio.toString('base64'), mime_type: contentType.split(';')[0] || 'audio/mpeg' };
    if (audioCache.size >= 30) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(cacheKey, result);
    return result;
  }

  return { status, synthesize };
}

module.exports = { createQianfanTts, SPEAKERS, ENDPOINT };

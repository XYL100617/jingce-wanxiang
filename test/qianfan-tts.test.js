const test = require('node:test');
const assert = require('node:assert/strict');
const { createQianfanTts, ENDPOINT } = require('../server/companion/qianfan-tts');

const audioBytes = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
function fakeResponse(contentType = 'audio/mpeg') {
  return { ok: true, headers: { get: () => contentType }, arrayBuffer: async () => audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength) };
}

test('Qianfan TTS stays disabled until server key and free-quota confirmation are configured', async () => {
  let requests = 0;
  const gateway = createQianfanTts({ env: { QIANFAN_TTS_API_KEY: 'secret' }, fetchImpl: async () => { requests++; } });
  assert.equal(gateway.status().tts_ready, false);
  await assert.rejects(gateway.synthesize({ text: '欢迎游览' }), /尚未配置/);
  assert.equal(requests, 0);
});

test('Qianfan short-text TTS sends the documented form and returns binary audio', async () => {
  let request;
  const gateway = createQianfanTts({ env: { QIANFAN_TTS_API_KEY: 'server-key', QIANFAN_TTS_FREE_CONFIRMED: 'true' }, fetchImpl: async (url, options) => { request = { url, options }; return fakeResponse(); } });
  const result = await gateway.synthesize({ text: '欢迎来到大宋武侠城。', voice: 'food' });
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.options.headers.Authorization, 'Bearer server-key');
  assert.match(request.options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get('tex'), '欢迎来到大宋武侠城。');
  assert.equal(form.get('ctp'), '1');
  assert.equal(form.get('lan'), 'zh');
  assert.equal(form.get('per'), '0');
  assert.equal(form.get('aue'), '3');
  assert.equal(Buffer.from(result.audio_base64, 'base64').toString('hex'), audioBytes.toString('hex'));
  assert.equal(result.mime_type, 'audio/mpeg');
  assert.equal((await gateway.synthesize({ text: '欢迎来到大宋武侠城。', voice: 'food' })).audio_base64, result.audio_base64);
});

test('Qianfan TTS blocks unsupported voice, oversized text, provider errors, and calls above the daily guard', async () => {
  let requests = 0;
  const env = { QIANFAN_TTS_API_KEY: 'server-key', QIANFAN_TTS_FREE_CONFIRMED: 'true', QIANFAN_TTS_DAILY_REQUESTS: '1' };
  const gateway = createQianfanTts({ env, fetchImpl: async () => { requests++; return fakeResponse('application/json'); } });
  await assert.rejects(gateway.synthesize({ text: 'x', voice: 'unknown' }), /过长或讲解员无效/);
  await assert.rejects(gateway.synthesize({ text: 'x'.repeat(401) }), /过长或讲解员无效/);
  await assert.rejects(gateway.synthesize({ text: 'provider error' }), /未返回音频/);
  await assert.rejects(gateway.synthesize({ text: 'second request' }), /保护额度/);
  assert.equal(requests, 1);
});

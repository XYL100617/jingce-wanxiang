const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoiceGateway, canonicalQuery, signedHeaders, makeWav } = require('../server/companion/voice-gateway');

function configuredEnv() { return { VIVO_AI_APP_ID: 'app-id-123', VIVO_AI_APP_KEY: 'test-secret-key', VIVO_AI_FREE_CONFIRMED: 'true' }; }
function fakeWebSocketFactory(onRequest) {
  return class FakeWebSocket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; setImmediate(() => this.emit('open')); }
    send(value) {
      const asText = Buffer.isBuffer(value) ? value.toString() : value;
      if (asText === '--end--') {
        this.emit('message', Buffer.from(JSON.stringify({ action: 'result', code: 0, is_finish: true, data: { text: '介绍大宋武馆', reformation: 1, is_last: true } })), false);
      } else if (typeof asText === 'string' && asText.startsWith('{')) {
        const message = JSON.parse(asText);
        if (message.type === 'started') { onRequest(value, this); return; }
        onRequest(value, this);
        this.emit('message', Buffer.from(JSON.stringify({ error_code: 0, data: { audio: Buffer.from([1, 2, 3, 4]).toString('base64'), status: 0 } })), false);
        this.emit('message', Buffer.from(JSON.stringify({ error_code: 0, data: { audio: Buffer.from([5, 6, 7, 8]).toString('base64'), status: 2 } })), false);
      } else if (asText !== '--close--' && asText !== '--end--') onRequest(value, this);
    }
    close() { this.readyState = 3; }
  };
}
const pcm = Buffer.alloc(2560, 7).toString('base64');

test('vivo gateway remains disabled unless credentials and free allowance confirmation are both present', async () => {
  const gateway = createVoiceGateway({ env: { VIVO_AI_APP_ID: 'id', VIVO_AI_APP_KEY: 'secret' }, WebSocketImpl: fakeWebSocketFactory(() => assert.fail('must not connect')) });
  assert.deepEqual(gateway.status(), { enabled: false, asr_ready: false, tts_ready: false, provider: 'vivo_ai_algorithm_platform', reason: 'free_status_unconfirmed' });
  await assert.rejects(gateway.recognize({ audio_base64: pcm, mime_type: 'audio/pcm' }), /尚未配置/);
});

test('vivo signing canonicalizes query and emits the required gateway headers', () => {
  const query = { z: 'a b', a: '!' };
  assert.equal(canonicalQuery(query), 'a=%21&z=a%20b');
  const headers = signedHeaders({ appId: 'app-id', appKey: 'secret', uri: '/asr/v2', query, now: 1700000000000, nonce: 'abcd1234' });
  assert.equal(headers['X-AI-GATEWAY-APP-ID'], 'app-id');
  assert.equal(headers['X-AI-GATEWAY-TIMESTAMP'], '1700000000');
  assert.equal(headers['X-AI-GATEWAY-NONCE'], 'abcd1234');
  assert.equal(headers['X-AI-GATEWAY-SIGNED-HEADERS'], 'x-ai-gateway-app-id;x-ai-gateway-timestamp;x-ai-gateway-nonce');
  assert.match(headers['X-AI-GATEWAY-SIGNATURE'], /^[A-Za-z0-9+/]+=*$/);
});

test('vivo ASR sends signed 16k PCM frames and extracts the final corrected transcript', async () => {
  const calls = [];
  const gateway = createVoiceGateway({ env: configuredEnv(), now: () => 1700000000000,
    WebSocketImpl: fakeWebSocketFactory(value => calls.push(value)) });
  const result = await gateway.recognize({ audio_base64: pcm, mime_type: 'audio/pcm' });
  assert.deepEqual(result, { text: '介绍大宋武馆' });
  assert.equal(calls.length, 3);
  const started = JSON.parse(calls[0]);
  assert.equal(started.type, 'started');
  assert.equal(started.asr_info.audio_type, 'pcm');
  assert.ok(calls.slice(1).every(Buffer.isBuffer));
});

test('vivo TTS selects character voice, joins PCM chunks and returns a playable WAV', async () => {
  let request;
  const gateway = createVoiceGateway({ env: configuredEnv(), now: () => 1700000000000,
    WebSocketImpl: fakeWebSocketFactory((value, socket) => { request = JSON.parse(value); }) });
  const result = await gateway.synthesize({ text: '欢迎游览大宋武馆', voice: 'story' });
  assert.equal(request.vcn, 'vivoHelper');
  assert.equal(request.auf, 'audio/L16;rate=24000');
  assert.equal(Buffer.from(request.text, 'base64').toString(), '欢迎游览大宋武馆');
  const wav = Buffer.from(result.audio_base64, 'base64');
  assert.equal(result.mime_type, 'audio/wav');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual(makeWav(Buffer.from([1, 2]), 24000).subarray(44), Buffer.from([1, 2]));
});

test('vivo ASR rejects wrong formats and malformed PCM before opening a socket', async () => {
  let calls = 0;
  const gateway = createVoiceGateway({ env: configuredEnv(), WebSocketImpl: fakeWebSocketFactory(() => calls++) });
  await assert.rejects(gateway.recognize({ audio_base64: pcm, mime_type: 'audio/webm' }), /16kHz/);
  await assert.rejects(gateway.recognize({ audio_base64: Buffer.alloc(1025).toString('base64'), mime_type: 'audio/pcm' }), /无效/);
  assert.equal(calls, 0);
});

test('vivo voice HTTP endpoints report disabled status until configured', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-voice-http-'));
  const keys = ['ACCOUNTS_FILE', 'AUDIT_FILE', 'COMPANION_USAGE_FILE', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'VIVO_AI_APP_ID', 'VIVO_AI_APP_KEY', 'VIVO_AI_FREE_CONFIRMED'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ACCOUNTS_FILE = path.join(dir, 'accounts.json'); process.env.AUDIT_FILE = path.join(dir, 'audit.jsonl');
  process.env.COMPANION_USAGE_FILE = path.join(dir, 'usage.json'); process.env.ADMIN_USERNAME = 'voice_test_manager';
  process.env.ADMIN_PASSWORD = 'voice-test-manager-password-2026';
  for (const key of keys.filter(key => key.startsWith('VIVO_AI_'))) delete process.env[key];
  const { server } = require('../server/index');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${base}/api/companion/voice`);
  assert.equal(status.status, 200);
  const publicState = await status.json();
  assert.equal(publicState.enabled, false);
  assert.equal(publicState.provider, 'vivo_ai_algorithm_platform');
  const input = await fetch(`${base}/api/companion/voice/asr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_base64: pcm, mime_type: 'audio/pcm' }) });
  assert.equal(input.status, 503);
  const output = await fetch(`${base}/api/companion/voice/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '欢迎游览', voice: 'guide' }) });
  assert.equal(output.status, 503);
});

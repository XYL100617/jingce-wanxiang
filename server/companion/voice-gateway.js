// Server-side adapter for vivo AI Cloud ASR/TTS WebSocket APIs.
const crypto = require('node:crypto');
const MAX_AUDIO_BYTES = 400000; // 12.5 s of 16 kHz mono 16-bit PCM
const MAX_REPLY_BYTES = 1200000;
const SIGNED_HEADERS = 'x-ai-gateway-app-id;x-ai-gateway-timestamp;x-ai-gateway-nonce';
const TTS_VOICES = Object.freeze({ guide: 'xiaoming', food: 'yunye', photo: 'wanqing', outdoor: 'yige', story: 'vivoHelper' });
const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomNonce() {
  const bytes = crypto.randomBytes(8);
  return [...bytes].map(byte => NONCE_ALPHABET[byte % NONCE_ALPHABET.length]).join('');
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalQuery(query) {
  return Object.keys(query).sort().map(key => `${rfc3986(key)}=${rfc3986(query[key])}`).join('&');
}
function signedHeaders({ appId, appKey, method = 'GET', uri, query, now = Date.now(), nonce = randomNonce() }) {
  if (!/^[a-z0-9]{8}$/.test(nonce)) throw new Error('签名随机串必须为8位小写字母或数字');
  const timestamp = String(Math.floor(now / 1000));
  const canonicalHeaders = `x-ai-gateway-app-id:${appId}\nx-ai-gateway-timestamp:${timestamp}\nx-ai-gateway-nonce:${nonce}`;
  const signingString = `${method.toUpperCase()}\n${uri}\n${canonicalQuery(query)}\n${appId}\n${timestamp}\n${canonicalHeaders}`;
  const signature = crypto.createHmac('sha256', appKey).update(signingString, 'utf8').digest('base64');
  return {
    'X-AI-GATEWAY-APP-ID': appId,
    'X-AI-GATEWAY-TIMESTAMP': timestamp,
    'X-AI-GATEWAY-NONCE': nonce,
    'X-AI-GATEWAY-SIGNED-HEADERS': SIGNED_HEADERS,
    'X-AI-GATEWAY-SIGNATURE': signature,
  };
}
function makeWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function randomUserId() { return crypto.randomBytes(16).toString('hex'); }
function socketConstructor() {
  try { return require('ws'); }
  catch (_) { throw new Error('语音服务依赖未安装，请在部署环境安装项目依赖后重启'); }
}
function createVoiceGateway({ env = process.env, WebSocketImpl = null, now = Date.now, random = Math.random } = {}) {
  const appId = String(env.VIVO_AI_APP_ID || '').trim();
  const appKey = String(env.VIVO_AI_APP_KEY || '').trim();
  const freeConfirmed = env.VIVO_AI_FREE_CONFIRMED === 'true';
  const enabled = Boolean(appId && appKey && freeConfirmed);
  const publicStatus = Object.freeze({ enabled, asr_ready: enabled, tts_ready: enabled, provider: 'vivo_ai_algorithm_platform', reason: enabled ? null : !appId || !appKey ? 'credentials_not_configured' : 'free_status_unconfirmed' });
  let active = 0;
  const WebSocketClass = WebSocketImpl;

  function connect(uri, query) {
    const queryString = canonicalQuery(query);
    const url = `wss://api-ai.vivo.com.cn${uri}?${queryString}`;
    const headers = signedHeaders({ appId, appKey, uri, query, now: now(), nonce: randomNonce() });
    const Constructor = WebSocketClass || socketConstructor();
    return new Constructor(url, { headers, handshakeTimeout: 10000, maxPayload: MAX_REPLY_BYTES, perMessageDeflate: false });
  }
  function acquire() {
    if (!enabled) { const error = new Error('vivo语音接口尚未配置或未确认免费额度'); error.statusCode = 503; throw error; }
    if (active >= 2) { const error = new Error('语音服务正忙，请稍后再试'); error.statusCode = 429; throw error; }
    active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  }
  function baseQuery(kind, netType = '0') {
    const current = Math.floor(now());
    const common = { user_id: randomUserId(), client_version: 'unknown', sdk_version: 'unknown', android_version: 'unknown' };
    if (kind === 'asr') return { ...common, system_time: current, package: 'unknown', system_version: 'unknown', net_type: String(netType), engineid: 'shortasrinput' };
    return { ...common, system_time: Math.floor(current / 1000), model: 'unknown', product: 'unknown', package: 'unknown', system_version: 'unknown', engineid: 'short_audio_synthesis_jovi' };
  }
  function callAsr(pcm, netType) {
    const release = acquire();
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = connect('/asr/v2', baseQuery('asr', netType)); }
      catch (error) { release(); reject(error); return; }
      const requestId = crypto.randomUUID().replace(/-/g, '');
      let text = '', settled = false, frameOffset = 0;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); clearInterval(sender); release();
        try { if (socket.readyState === 1) socket.send(Buffer.from('--close--')); socket.close(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('语音识别超时')), 25000);
      let sender = null;
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'started', request_id: requestId, asr_info: { end_vad_time: 1000, audio_type: 'pcm', chinese2digital: 1, punctuation: 1 } }));
        // 40ms/frame at 16kHz, 16-bit mono = 1280 bytes.
        sender = setInterval(() => {
          if (frameOffset >= pcm.length) {
            clearInterval(sender); sender = null; socket.send(Buffer.from('--end--')); return;
          }
          const end = Math.min(frameOffset + 1280, pcm.length);
          socket.send(pcm.subarray(frameOffset, end)); frameOffset = end;
        }, 40);
      });
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let packet;
        try { packet = JSON.parse(raw.toString()); } catch (_) { return finish(new Error('语音识别返回格式无效')); }
        if (packet.action === 'error' || (Number.isInteger(packet.code) && packet.code !== 0)) return finish(new Error('语音识别服务返回错误'));
        if (packet.action === 'result' && typeof packet.data?.text === 'string') {
          text = packet.data.reformation === 1 ? packet.data.text : text + packet.data.text;
          if (packet.is_finish === true || packet.data.is_last === true) return finish(null, { text: text.trim() });
        }
      });
      socket.on('error', () => finish(new Error('无法连接vivo语音识别服务')));
      socket.on('close', () => { if (!settled) finish(text ? null : new Error('语音识别连接提前关闭'), text ? { text: text.trim() } : undefined); });
    });
  }
  function callTts(text, voice) {
    const release = acquire();
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = connect('/tts', baseQuery('tts')); }
      catch (error) { release(); reject(error); return; }
      const reqId = Math.floor(now() + random() * 1000);
      const audio = [];
      let audioBytes = 0, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); release();
        try { socket.close(); } catch (_) {}
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('语音合成超时')), 20000);
      socket.on('open', () => socket.send(JSON.stringify({ ent: 'intp65', aue: 0, auf: 'audio/L16;rate=24000', vcn: TTS_VOICES[voice], speed: 50, volume: 60, rdn: 0, text: Buffer.from(text, 'utf8').toString('base64'), encoding: 'utf8', sfl: 0, reqId })));
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return finish(new Error('语音合成返回了非预期数据格式'));
        let packet;
        try { packet = JSON.parse(raw.toString()); } catch (_) { return finish(new Error('语音合成返回格式无效')); }
        if (packet.error_code !== 0) return finish(new Error('语音合成服务返回错误'));
        if (!packet.data || typeof packet.data.audio !== 'string') return;
        const chunk = Buffer.from(packet.data.audio, 'base64');
        if (!chunk.length || chunk.toString('base64') !== packet.data.audio) return finish(new Error('语音合成音频格式无效'));
        audioBytes += chunk.length;
        if (audioBytes > MAX_REPLY_BYTES) return finish(new Error('语音合成音频过大'));
        audio.push(chunk);
        if (packet.data.status === 2) finish(null, makeWav(Buffer.concat(audio), 24000));
      });
      socket.on('error', () => finish(new Error('无法连接vivo语音合成服务')));
      socket.on('close', () => { if (!settled) finish(new Error('语音合成连接提前关闭')); });
    });
  }
  async function recognize({ audio_base64: encoded, mime_type: mime, net_type: netType = 0 }) {
    if (mime !== 'audio/pcm' || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0 || encoded.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4) {
      const error = new Error('请提供16kHz、16bit、单声道PCM录音'); error.statusCode = 400; throw error;
    }
    const pcm = Buffer.from(encoded, 'base64');
    if (![0, 1].includes(Number(netType)) || pcm.length < 1280 || pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 || pcm.toString('base64') !== encoded) {
      const error = new Error('PCM录音长度无效'); error.statusCode = 400; throw error;
    }
    return callAsr(pcm, Number(netType));
  }
  async function synthesize({ text, voice }) {
    if (typeof text !== 'string' || !text.trim() || !TTS_VOICES[voice]) {
      const error = new Error('播报文本或讲解员无效'); error.statusCode = 400; throw error;
    }
    const pieces = [];
    let piece = '';
    for (const character of text.trim()) {
      if (Buffer.byteLength(piece + character, 'utf8') > 2048) { if (piece) pieces.push(piece); piece = character; }
      else piece += character;
    }
    if (piece) pieces.push(piece);
    const pcmParts = [];
    for (const part of pieces) {
      const wav = await callTts(part, voice);
      pcmParts.push(wav.subarray(44));
    }
    const wav = makeWav(Buffer.concat(pcmParts), 24000);
    if (wav.length > MAX_REPLY_BYTES) { const error = new Error('语音合成音频过大'); error.statusCode = 502; throw error; }
    return { audio_base64: wav.toString('base64'), mime_type: 'audio/wav' };
  }
  return { status: () => publicStatus, recognize, synthesize };
}
module.exports = { createVoiceGateway, signedHeaders, canonicalQuery, makeWav, MAX_AUDIO_BYTES, TTS_VOICES };

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

/**
 * Headless round trip — the phone, without the phone.
 *
 * Exercises the real path end to end: mint a pairing code, redeem it for a
 * device token, open an authenticated socket, stream PCM up as a mic would,
 * and play back what comes down. The only thing faked is the microphone, and
 * it is faked with the TTS engine so there is genuine speech to transcribe.
 *
 * Prints the latency of every stage, and writes the reply audio to a wav so
 * the result can be listened to rather than taken on trust.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';
const QUESTION = process.argv.slice(2).join(' ')
  || 'Hey, quick question. What is the capital of Japan, and what is it famous for?';

const ms = (t) => `${String(Math.round(t)).padStart(5)} ms`;

/** 24 kHz (Kokoro) down to 16 kHz (Whisper). Linear is plenty for speech. */
function resample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const a = Math.floor(src);
    const b = Math.min(a + 1, input.length - 1);
    out[i] = input[a] + (input[b] - input[a]) * (src - a);
  }
  return out;
}

function wav(float32, rate) {
  const data = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---- 1. pair -----------------------------------------------------------
const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
let t = Date.now();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'test-client' }),
})).json();
console.log(`[pair]   ${ms(Date.now() - t)}  code ${pair.code}`);

// ---- 2. redeem ---------------------------------------------------------
t = Date.now();
const redeemRes = await fetch(`${BASE}/api/auth/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pair.code }),
});
const session = await redeemRes.json();
console.log(`[redeem] ${ms(Date.now() - t)}  device ${session.deviceId} for ${session.principalId}`);

// the code must not work twice
const again = await fetch(`${BASE}/api/auth/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pair.code }),
});
console.log(`[replay] code reused -> HTTP ${again.status} ${again.status === 403 ? '(correctly refused)' : '*** SHOULD BE 403 ***'}`);

// ---- 3. fabricate a microphone ----------------------------------------
t = Date.now();
const spoken = await fetch(`${SPEECH}/tts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: QUESTION, voice: 'am_michael', format: 'pcm' }),
});
const at24 = new Float32Array(Buffer.from(await spoken.arrayBuffer()).buffer.slice(0));
const mic = resample(at24, 24000, 16000);
console.log(`[mic]    ${ms(Date.now() - t)}  ${(mic.length / 16000).toFixed(1)}s  "${QUESTION}"`);

// ---- 4. the socket -----------------------------------------------------
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, {
  headers: { Authorization: `Bearer ${session.token}` },
});

const audio = [];
let spokeAt = null;
let tEnd = 0;
let transcript = '';

ws.on('open', () => console.log('[ws]     connected (authenticated at upgrade)'));

ws.on('message', (data, isBinary) => {
  if (isBinary) { audio.push(data); return; }
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'ready':
      console.log(`[ws]     ready as ${msg.principalId}`);
      ws.send(JSON.stringify({ type: 'hello', tools: false, format: 'pcm' }));
      break;
    case 'session':
      console.log(`[ws]     session ${msg.session.id} (tools=${msg.session.tools}, model=${msg.session.model})`);
      // Stream the utterance up in 32 ms frames, as a real mic would.
      for (let i = 0; i < mic.length; i += 512) {
        ws.send(Buffer.from(mic.buffer, i * 4, Math.min(512, mic.length - i) * 4));
      }
      tEnd = Date.now();
      ws.send(JSON.stringify({ type: 'end' }));
      break;
    case 'heard':
      console.log(`[stt]    ${ms(msg.ms)}  "${msg.text}"`);
      break;
    case 'text':
      transcript += msg.delta;
      break;
    case 'tool':
      console.log(`[tool]   ${msg.name} started — the client must fill this silence`);
      break;
    case 'speak':
      if (spokeAt === null) {
        spokeAt = Date.now() - tEnd;
        console.log(`\n  >>> FIRST AUDIO ${spokeAt} ms after the utterance ended <<<\n`);
      }
      console.log(`[speak]  synth ${ms(msg.synthMs)} for ${(msg.audioMs / 1000).toFixed(1)}s  "${msg.text.slice(0, 62)}"`);
      break;
    case 'done': {
      const out = path.join(ROOT, 'roundtrip-reply.wav');
      const all = Buffer.concat(audio);
      writeFileSync(out, wav(new Float32Array(all.buffer, all.byteOffset, all.length / 4), 24000));
      console.log(`\n[done]   turn ${ms(msg.ms)} | ${audio.length} audio chunks | ${(all.length / 4 / 24000).toFixed(1)}s`);
      console.log(`[reply]  "${transcript.trim().slice(0, 200)}"`);
      console.log(`[wrote]  ${out}`);
      ws.close();
      process.exit(0);
      break;
    }
    case 'error':
      console.error(`[error]  ${msg.message}`);
      break;
  }
});

ws.on('error', (err) => { console.error(`[ws]     ${err.message}`); process.exit(1); });
setTimeout(() => { console.error('[timeout] no completion in 120s'); process.exit(1); }, 120_000);

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

/**
 * Two turns down one socket.
 *
 * Turn one proves the pre-warm actually removes the cold start; turn two
 * proves the process really is being reused rather than respawned. If turn two
 * is not clearly faster than a cold spawn (6305 ms measured), the warm-process
 * design is not doing what the whole architecture is built around.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';

const QUESTIONS = [
  'In one sentence, what is a race condition?',
  'And in one sentence, how do you usually prevent one?',
];

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

async function fakeMic(text) {
  const res = await fetch(`${SPEECH}/tts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: 'am_michael', format: 'pcm' }),
  });
  return resample(new Float32Array(Buffer.from(await res.arrayBuffer()).buffer.slice(0)), 24000, 16000);
}

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'turns-test' }),
})).json();
const auth = await (await fetch(`${BASE}/api/auth/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pair.code }),
})).json();

const mics = await Promise.all(QUESTIONS.map(fakeMic));
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, {
  headers: { Authorization: `Bearer ${auth.token}` },
});

let turn = -1;
let tEnd = 0;
let firstAudio = null;
const results = [];

const speak = () => {
  turn += 1;
  if (turn >= QUESTIONS.length) {
    console.log('\n' + '='.repeat(58));
    results.forEach((r, i) => console.log(
      `  turn ${i + 1}: first audio ${String(Math.round(r.first)).padStart(5)} ms   (stt ${String(r.stt).padStart(4)} ms)   "${QUESTIONS[i].slice(0, 34)}..."`));
    console.log(`  cold spawn for comparison: 6305 ms just to first token`);
    console.log('='.repeat(58));
    ws.close();
    process.exit(0);
  }
  firstAudio = null;
  const mic = mics[turn];
  for (let i = 0; i < mic.length; i += 512) {
    ws.send(Buffer.from(mic.buffer, i * 4, Math.min(512, mic.length - i) * 4));
  }
  tEnd = Date.now();
  ws.send(JSON.stringify({ type: 'end' }));
};

let stt = 0;
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === 'ready') ws.send(JSON.stringify({ type: 'hello', tools: false, format: 'pcm' }));
  if (msg.type === 'session') { console.log(`session ${msg.session.id} warm=${msg.session.warm}`); speak(); }
  if (msg.type === 'heard') { stt = msg.ms; console.log(`\n[turn ${turn + 1}] heard "${msg.text}"`); }
  if (msg.type === 'speak' && firstAudio === null) {
    firstAudio = Date.now() - tEnd;
    console.log(`[turn ${turn + 1}] first audio ${firstAudio} ms`);
  }
  if (msg.type === 'done') { results.push({ first: firstAudio, stt }); speak(); }
  if (msg.type === 'error') console.error(`[error] ${msg.message}`);
});

ws.on('error', (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 120_000);

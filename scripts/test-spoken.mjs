import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

/**
 * Ask the live server something, and report the two channels separately.
 *
 * The screen and the speaker get different text, and only one of them can be
 * checked by reading the transcript. This prints what was written, what was
 * actually handed to the synthesiser, and — by transcribing the audio that came
 * back — roughly what a person heard. Nothing is mocked: it is the real socket,
 * the real session, the real voice.
 *
 *   npm run spoken -- read "What is the spot price of bitcoin?"
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';

const args = process.argv.slice(2);
const TIERS = ['chat', 'read', 'build', 'full'];
const tier = TIERS.includes(args[0]) ? args.shift() : 'chat';
const QUESTION = args.join(' ') || 'What is the spot price of bitcoin right now?';

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'spoken-test', ttlMs: 60_000 }),
})).json();
const redeemed = await (await fetch(`${BASE}/api/auth/redeem`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pair.code }),
})).json();

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, {
  headers: { Authorization: `Bearer ${redeemed.token}` },
});

const spoken = [];
const written = [];
const audio = [];
let done = null;
const finished = new Promise((r) => { done = r; });

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'new', tier, model: 'claude-sonnet-5' }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'text', text: QUESTION })), 600);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) { audio.push(Buffer.from(data)); return; }
  const msg = JSON.parse(data.toString());
  if (msg.type === 'text') written.push(msg.delta ?? msg.text ?? '');
  if (msg.type === 'speak') spoken.push(msg.text ?? '');
  if (msg.type === 'done' || msg.type === 'result') done();
  if (msg.type === 'error') { console.error('server error:', msg.message); done(); }
});

await Promise.race([finished, new Promise((r) => setTimeout(r, 90_000))]);
await new Promise((r) => setTimeout(r, 1500)); // let trailing audio land
ws.close();

const writtenText = written.join('').trim();
const spokenText = spoken.join(' ').replace(/\s+/g, ' ').trim();

console.log(`\n  asked     ${QUESTION}   (tier: ${tier})`);
console.log(`\n  ON SCREEN ${writtenText.slice(0, 400) || '(nothing)'}`);
console.log(`\n  TO VOICE  ${spokenText || '(nothing)'}`);

// mp3 chunks are what the phone receives; decode them back to hear the result.
if (audio.length) {
  const { execFileSync } = await import('node:child_process');
  const mp3 = Buffer.concat(audio);
  const wav = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'],
  { input: mp3, maxBuffer: 1 << 28 });
  const res = await fetch(`${SPEECH}/stt`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav,
  });
  const heard = (await res.json()).text.trim();
  console.log(`\n  HEARD     ${heard}`);
  console.log(`\n  (${audio.length} audio chunks, ${(wav.length / 4 / 16000).toFixed(1)}s)`);
}

// The thing being checked: no bare "$" ever reaches the synthesiser.
if (/\$\d/.test(spokenText)) {
  console.log('\n  FAIL: a raw dollar amount went to the voice — it will be read as "dollar ten".');
  process.exit(1);
}
console.log('\n  ok: nothing symbol-shaped went to the voice.\n');

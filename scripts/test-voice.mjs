import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

/**
 * The voice path, in a real browser, with a real endpoint decision.
 *
 * Chrome can feed a wav file to getUserMedia, so the browser's own capture
 * worklet, resampler and endpoint detector all run on actual speech instead of
 * being taken on trust. `%noloop` matters: a looping file never goes quiet, so
 * the endpoint would never fire and the turn would never start.
 *
 * Then barge-in — the one thing nothing has exercised yet. The page is told to
 * speak again while Claude is still talking, and the test checks that playback
 * stopped locally and the server was told to abandon the turn.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 16-bit PCM wav — what Chrome's fake capture device will accept. */
function wav16(float32, rate) {
  const data = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const QUESTION = 'In one short sentence, what is a mutex?';
const tts = await fetch(`${SPEECH}/tts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: QUESTION, voice: 'am_michael', format: 'pcm' }),
});
const speech = new Float32Array(Buffer.from(await tts.arrayBuffer()).buffer.slice(0));
// A second of lead-in silence lets the noise floor settle before speech starts,
// which is exactly what happens when a person taps Talk and then speaks.
const lead = new Float32Array(24000);
const both = new Float32Array(lead.length + speech.length);
both.set(lead); both.set(speech, lead.length);
const wavPath = path.join(ROOT, 'data', 'fake-mic.wav');
writeFileSync(wavPath, wav16(both, 24000));
console.log(`[wav]    ${(both.length / 24000).toFixed(1)}s  "${QUESTION}"`);

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'voice-test' }),
})).json();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.evaluateOnNewDocument(() => {
  window.__audio = { frames: 0, played: 0, stopped: 0 };
  window.__sent = [];
  const Native = WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Native(...a);
    const send = ws.send.bind(ws);
    ws.send = (d) => { if (typeof d === 'string') window.__sent.push(JSON.parse(d).type); return send(d); };
    ws.addEventListener('message', (e) => { if (e.data instanceof ArrayBuffer) window.__audio.frames += 1; });
    return ws;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (...a) { window.__audio.played += 1; return start.apply(this, a); };
  AudioBufferSourceNode.prototype.stop = function (...a) { window.__audio.stopped += 1; return stop.apply(this, a); };
});

await page.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`, { waitUntil: 'networkidle0' });
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#go')]);
await page.waitForSelector('#mic');
await new Promise((r) => setTimeout(r, 1200));

// ---- speak ---------------------------------------------------------------
const t0 = Date.now();
await page.evaluate(() => document.getElementById('mic').click());

await page.waitForFunction(() => document.body.classList.contains('hearing'), { timeout: 20_000 })
  .catch(() => { throw new Error('endpoint detector never heard speech'); });
console.log(`[vad]    speech detected at ${Date.now() - t0} ms`);

await page.waitForFunction(() => !document.body.classList.contains('hearing'), { timeout: 30_000 });
const endedAt = Date.now();
console.log(`[vad]    endpoint fired at ${endedAt - t0} ms`);

await page.waitForFunction(() => document.querySelector('.msg.me'), { timeout: 40_000 });
const heard = await page.$eval('.msg.me', (e) => e.textContent);
console.log(`[stt]    transcribed: "${heard}"`);

await page.waitForFunction(() => window.__audio.played > 0, { timeout: 60_000 });
console.log(`[audio]  first audio played ${Date.now() - endedAt} ms after the endpoint`);

// ---- barge in ------------------------------------------------------------
const before = await page.evaluate(() => ({ ...window.__audio }));
// The same function the endpoint detector calls when a loud frame arrives
// while Claude is talking. The detector half is already proven above — it is
// what produced the `hearing` class and the transcript.
await page.evaluate(() => window.foovox.bargeIn());
await new Promise((r) => setTimeout(r, 600));
const after = await page.evaluate(() => ({ audio: window.__audio, sent: window.__sent }));

const stoppedMore = after.audio.stopped > before.stopped;
const toldServer = after.sent.includes('interrupt');
console.log(`[barge]  playback stopped locally : ${stoppedMore ? 'yes' : 'no'}`);
console.log(`[barge]  server told to abandon   : ${toldServer ? 'yes' : 'no'}`);
if (!stoppedMore) errors.push('barge-in did not stop playback');
if (!toldServer) errors.push('barge-in did not send interrupt');

// ---- barge in during a GAP between chunks -------------------------------
// The bug that shipped: `bargeIn` returned early unless a chunk was actively
// sounding, so talking in the gap between two chunks sent no interrupt and
// the reply carried on. Reproduce that exact state — nothing playing, but a
// reply in flight — and require the interrupt to go out anyway.
await page.evaluate(() => { window.__sent.length = 0; });
await page.evaluate(() => window.foovox.ask('Please count slowly from one to twenty.'));
await page.waitForFunction(() => window.__audio.played > 0, { timeout: 60_000 }).catch(() => {});
const gap = await page.evaluate(async () => {
  // Force the exact gap condition: no source sounding, reply still coming.
  window.foovox.state.queued.forEach((s) => { try { s.stop(); } catch {} });
  window.foovox.state.queued = [];
  window.foovox.state.playing = false;
  window.__sent.length = 0;
  window.foovox.bargeIn();
  return { sent: [...window.__sent] };
});
const gapInterrupt = gap.sent.includes('interrupt');
console.log(`[barge]  interrupt sent during a gap: ${gapInterrupt ? 'yes' : 'NO — the old bug is back'}`);
if (!gapInterrupt) errors.push('no interrupt sent when barging in between chunks');

// The actual complaint was not "no interrupt", it was "it kept talking".
// So assert the thing that was observed: nothing more reaches the speaker.
const framesAtCut = await page.evaluate(() => window.__audio.played);
await new Promise((r) => setTimeout(r, 4000));
const framesAfter = await page.evaluate(() => window.__audio.played);
console.log(`[barge]  buffers played after cut : ${framesAfter - framesAtCut} (must be 0)`);
if (framesAfter > framesAtCut) {
  errors.push(`kept talking after interrupt: ${framesAfter - framesAtCut} more buffers played`);
}

// Why the endpoint fired where it did.
const trace = await page.evaluate(() => window.foovox.state.trace);
const spoken = trace.map((t, i) => [i, ...t]).filter(([, , , sp]) => sp);
if (spoken.length) {
  const from = spoken[0][0], to = spoken[spoken.length - 1][0];
  console.log(`
[trace]  rms/threshold during the utterance (x10000, 20ms frames):`);
  let line = '';
  for (let i = Math.max(0, from - 10); i <= Math.min(trace.length - 1, to + 10); i += 1) {
    const [rms, thr, sp] = trace[i];
    line += rms > thr ? '#' : (sp ? '.' : '_');
  }
  console.log(`  ${line}`);
  console.log(`  # above threshold   . below, still capturing   _ not capturing`);
}

await page.screenshot({ path: path.join(ROOT, 'shot-voice.png') });
console.log(`\n[errors] ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
process.exit(errors.length ? 1 : 0);

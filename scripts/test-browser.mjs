import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

/**
 * Load the PWA in a real browser and fail on anything it logs as an error.
 *
 * A client that throws on load is indistinguishable, from a phone in Hawaii,
 * from a server that is down — so the shell gets opened here, with a fake
 * microphone, before it gets opened over a tunnel.
 *
 * `--use-fake-device-for-media-stream` gives getUserMedia a synthetic mic, so
 * the capture path, the worklet and the endpoint detector all run for real.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'browser-test' }),
})).json();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });

// Count the audio actually delivered to the page. The transcript can look
// perfect while no sound is produced at all, and from a phone those two
// failures are indistinguishable until you notice you are reading, not
// listening. Installed before any page script so it sees the first frame.
await page.evaluateOnNewDocument(() => {
  window.__audio = { frames: 0, bytes: 0, played: 0 };
  const Native = WebSocket;
  window.WebSocket = function (...args) {
    const ws = new Native(...args);
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        window.__audio.frames += 1;
        window.__audio.bytes += e.data.byteLength;
      }
    });
    return ws;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
  // Count buffers that actually reach the speaker, not just the socket.
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__audio.played += 1;
    return start.apply(this, a);
  };
});

const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
// Console errors say "401" without saying what asked. Record the URL too, or
// every failure investigation starts by rerunning with more logging.
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
});
page.on('requestfailed', (r) => {
  // The socket closing at teardown is not a failure worth reporting.
  if (!r.url().includes('/ws')) errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
});

// ---- login page, and a real redemption through the UI --------------------
await page.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`, { waitUntil: 'networkidle0' });
const prefilled = await page.$eval('#code', (el) => el.value);
const urlAfter = page.url();
console.log(`[login]  code prefilled from link : ${prefilled === pair.code ? 'yes' : 'NO'}`);
console.log(`[login]  code stripped from URL   : ${urlAfter.includes('code=') ? 'NO — still in history' : 'yes'}`);
await page.screenshot({ path: path.join(ROOT, 'shot-login.png') });

await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }),
  page.click('#go'),
]);
console.log(`[login]  redeemed -> ${page.url()}`);

// ---- the app -------------------------------------------------------------
await page.waitForSelector('#mic', { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 1500)); // let the socket say hello

const status = await page.$eval('#status', (el) => el.textContent);
const who = await page.$eval('#who', (el) => el.textContent);
console.log(`[app]    signed in as "${who}", status "${status}"`);

// Service worker + manifest, the two things that make it installable.
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(reg);
});
const manifest = await page.$eval('link[rel=manifest]', (el) => el.href);
console.log(`[pwa]    service worker registered : ${sw ? 'yes' : 'no'}`);
console.log(`[pwa]    manifest                  : ${manifest.split('/').pop()}`);

// ---- exercise the mic path with Chrome's synthetic microphone -----------
await page.click('#mic');
await new Promise((r) => setTimeout(r, 2500));
const micState = await page.evaluate(() => ({
  listening: document.body.classList.contains('listening'),
  label: document.getElementById('mic').textContent,
  status: document.getElementById('status').textContent,
}));
console.log(`[mic]    listening=${micState.listening} button="${micState.label}" status="${micState.status}"`);

await page.screenshot({ path: path.join(ROOT, 'shot-app.png') });

// ---- the rail ------------------------------------------------------------
await page.click('#rail-toggle');
await new Promise((r) => setTimeout(r, 400));
const railOpen = await page.evaluate(() => document.body.classList.contains('rail-open'));
const railCount = await page.$$eval('.rail-item', (els) => els.length);
console.log(`[rail]   open=${railOpen} sessions listed=${railCount}`);
await page.screenshot({ path: path.join(ROOT, 'shot-rail.png') });

// ---- a real conversation, end to end in the browser ---------------------
// Close the rail and stop the mic by dispatching to the elements, not by
// pixel. A coordinate click at the centre of the viewport lands on the open
// rail panel, not the scrim behind it — which is how the previous run armed
// tools instead of stopping the microphone.
await page.evaluate(() => {
  document.getElementById('rail-scrim').click();
  // Chrome's synthetic device emits a constant tone; leaving it running means
  // the endpoint detector and the typed message drive the same session.
  if (document.body.classList.contains('listening')) document.getElementById('mic').click();
});
await page.waitForFunction(
  () => !document.body.classList.contains('rail-open') && !document.body.classList.contains('listening'),
  { timeout: 5000 },
);

const dump = async (label) => {
  const s = await page.evaluate(() => ({
    status: document.getElementById('status')?.textContent,
    bubbles: [...document.querySelectorAll('.msg')].map((e) => `${e.className}: ${e.textContent.slice(0, 70)}`),
    ws: window.__wsState,
    audio: window.__audio,
  }));
  console.log(`\n[dump ${label}] status="${s.status}" ws=${s.ws} audio=${JSON.stringify(s.audio)}`);
  for (const b of s.bubbles) console.log(`   ${b}`);
};

const asked = Date.now();
await page.type('#typed', 'In one short sentence, what is a deadlock?');
await page.evaluate(() => document.getElementById('send').click());

await page.waitForFunction(
  () => document.querySelectorAll('.msg.them').length > 0 && document.querySelector('.msg.them').textContent.length > 10,
  { timeout: 60_000 },
).catch(async (e) => { await dump('no reply'); throw e; });
const firstText = Date.now() - asked;
await page.waitForFunction(() => window.__audio.played > 0, { timeout: 60_000 });
const firstAudio = Date.now() - asked;

// Let the rest of the turn arrive.
await page.waitForFunction(
  () => /done in/.test(document.getElementById('status').textContent),
  { timeout: 60_000 },
).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));

const conv = await page.evaluate(() => ({
  ...window.__audio,
  reply: document.querySelector('.msg.them')?.textContent ?? '',
  mine: document.querySelector('.msg.me')?.textContent ?? '',
  emptyGone: !document.getElementById('empty'),
}));

console.log(`\n[chat]   asked   "${conv.mine}"`);
console.log(`[chat]   replied "${conv.reply.slice(0, 90)}"`);
console.log(`[chat]   first text ${firstText} ms | first audio played ${firstAudio} ms`);
console.log(`[audio]  ${conv.frames} frames, ${(conv.bytes / 1024).toFixed(0)} KB, ${conv.played} buffers played`);
console.log(`[chat]   empty state cleared: ${conv.emptyGone ? 'yes' : 'NO'}`);
if (!conv.played) errors.push('no audio reached the speaker');
if (conv.frames !== conv.played) errors.push(`${conv.frames} audio frames received but ${conv.played} played`);

await page.screenshot({ path: path.join(ROOT, 'shot-chat.png') });

// ---- playback must un-stick even if onended never fires -----------------
/*
 * The reported failure: first turn perfect, every turn after it chopped after
 * a word or two. Cause was `state.playing` being cleared only from
 * `source.onended`; when that does not fire — which happens on iOS Safari —
 * the flag stuck true and the endpoint detector kept judging the user against
 * the echo guard from the previous reply.
 *
 * Reproduced here by swallowing every `onended`, which is the exact defect.
 */
await page.evaluate(() => {
  Object.defineProperty(AudioBufferSourceNode.prototype, 'onended', {
    set() { /* swallowed, as iOS sometimes does */ },
    get() { return null; },
    configurable: true,
  });
  window.foovox.state.cutoffs = 0;
});

await page.evaluate(() => window.foovox.ask('Say the single word: ready.'));
await page.waitForFunction(() => window.__audio.played > 0, { timeout: 60_000 }).catch(() => {});
// Wait past the end of the scheduled audio, plus margin.
await page.waitForFunction(
  () => !window.foovox.state.playhead || window.foovox.state.playhead < window.foovox.state.ctx.currentTime,
  { timeout: 30_000 },
).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

const after = await page.evaluate(() => {
  const s = window.foovox.state;
  /*
   * What the bar *should* be with no echo contribution at all. Chrome's fake
   * microphone emits a constant tone, so the room's noise floor is genuinely
   * high here — comparing against an absolute number would be testing the
   * test rig. What matters is that nothing echo-derived is still inflating it.
   *
   * This asked the level model for `settings.sensitivity`, which stopped
   * existing when the model was rewritten to interpolate between the room and
   * the learned voice. It silently became NaN, so the two comparisons below
   * were both false and this check had quietly stopped checking anything.
   */
  const base = s.level.threshold(s.settings.margin);
  return {
    playing: s.playing,
    peak: s.echo.peak,
    queued: s.queued.length,
    threshold: s.lastThreshold,
    base,
  };
});
console.log(`\n[stuck]  onended suppressed -> playing=${after.playing} echoPeak=${after.peak.toFixed(3)}`);
console.log(`[stuck]  threshold ${after.threshold.toFixed(4)} vs echo-free base ${after.base.toFixed(4)}`);
if (after.playing) errors.push('playback stuck "playing" when onended never fired — later turns will be cut off');
if (after.peak > 0) errors.push(`stale echo peak ${after.peak} survived the reply — it will suppress the next turn`);
if (after.threshold > after.base * 1.01) {
  errors.push(`threshold ${after.threshold} still carries an echo term above base ${after.base}`);
}

console.log(`\n[console] ${logs.length} messages, ${errors.length} errors`);
for (const e of errors) console.log(`  ERROR: ${e}`);

await browser.close();
process.exit(errors.length ? 1 : 0);

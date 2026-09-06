import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

/**
 * The two things reported from a real room, checked in a real browser.
 *
 *   "when I set the mic sensitivity in the settings it doesn't do anything"
 *   "when I stop talking it goes right back down and picks up the dude
 *    talking across the way"
 *
 * Both are about the live threshold, so both are checked by reading the live
 * threshold rather than by looking at the slider.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const CHROME = process.env.CHROME_PATH
  ?? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'levels' }),
})).json();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`, { waitUntil: 'networkidle0' });
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#go')]);
await page.waitForSelector('#sens');
await new Promise((r) => setTimeout(r, 1200));

/* Drive the level model directly with known values. The fake microphone
 * cannot be made to speak on cue, and what is being tested is the maths and
 * the wiring, not the capture path — which the voice test already covers. */
const feed = (quietFor, speechAt, speechFor) => page.evaluate(
  ({ q, sa, sf }) => {
    const m = window.foovox.state.level;
    for (let i = 0; i < q; i += 1) m.observeQuiet(0.004);
    for (let i = 0; i < sf; i += 1) m.observeSpeech(sa);
    return null;
  }, { q: quietFor, sa: speechAt, sf: speechFor },
);

const threshold = () => page.evaluate(
  () => window.foovox.state.level.threshold(window.foovox.state.settings.margin));

const setSlider = (pct) => page.evaluate((v) => {
  const s = document.getElementById('sens');
  s.value = String(v);
  s.dispatchEvent(new Event('input'));
  return window.foovox.state.settings.margin;
}, pct);

console.log('\n[1] does the slider change the live threshold?');
await feed(100, 0.09, 100); // 2s of room, 2s of speech
const readings = [];
for (const pct of [5, 25, 50, 75, 90]) {
  const margin = await setSlider(pct);
  const t = await threshold();
  readings.push({ pct, margin, t });
  console.log(`    ${String(pct).padStart(2)}%  margin ${margin.toFixed(2)}  threshold ${t.toFixed(4)}`);
}
const monotonic = readings.every((r, i) => i === 0 || r.t > readings[i - 1].t);
const spread = readings[readings.length - 1].t / readings[0].t;
console.log(`    monotonic: ${monotonic ? 'yes' : 'NO'} | range: ${spread.toFixed(1)}x`);
if (!monotonic) errors.push('the slider does not move the threshold monotonically');
if (spread < 2) errors.push(`the slider only spans ${spread.toFixed(1)}x — effectively inert`);

console.log('\n[2] does the bar stay up when you stop talking?');
await setSlider(35);
await page.evaluate(() => window.foovox.state.level.reset());
await feed(100, 0.09, 150);
const afterSpeech = await threshold();
await feed(250, 0.09, 0); // five seconds of silence
const afterPause = await threshold();
const OTHERS = 0.02; // someone talking across the room
console.log(`    right after speaking : ${afterSpeech.toFixed(4)}`);
console.log(`    after a 5s pause     : ${afterPause.toFixed(4)}`);
console.log(`    someone across room  : ${OTHERS} — clears the bar? ${OTHERS > afterPause ? 'YES (bad)' : 'no'}`);
if (afterPause < afterSpeech * 0.7) errors.push('the bar collapsed during a pause');
if (OTHERS > afterPause) errors.push('background speech still clears the bar after a pause');

console.log('\n[3] can you still be heard after the pause?');
const you = 0.09;
console.log(`    your voice ${you} clears ${afterPause.toFixed(4)}? ${you > afterPause ? 'yes' : 'NO'}`);
if (you <= afterPause) errors.push('the bar held so high that you can no longer be heard');

console.log(`\n[errors] ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
process.exit(errors.length ? 1 : 0);

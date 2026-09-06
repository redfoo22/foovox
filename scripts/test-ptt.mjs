import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

/**
 * Press and hold, for real, in a real browser.
 *
 * The push-to-talk logic is a state machine driven by pointer events, and the
 * interesting cases are all about timing: a tap that must not be read as a
 * hold, a hold that must not be ended by the silence timer, a release that
 * must return to the mode you were in before. None of that can be checked by
 * calling functions directly — it has to be a genuine pointerdown, a genuine
 * wait, and a genuine pointerup on the actual element.
 *
 * The decisive assertion is on the *messages sent to the server*, not on CSS
 * classes: exactly one `end` per turn, and never one while the thumb is down.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const CYCLES_HEADING = '\n--- start and stop many times over ---';
const REENTRY_HEADING = '\n--- two presses do not open two microphones ---';
const HEALTHY_HEADING = '\n--- the page stayed healthy ---';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'ptt-test' }),
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

// Record every control message the client sends, so a turn can be asserted on
// what actually went out rather than on what the UI looked like.
await page.evaluateOnNewDocument(() => {
  window.__sent = [];
  window.__pcm = 0;
  const Native = WebSocket;
  window.WebSocket = function (...args) {
    const ws = new Native(...args);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      if (typeof data === 'string') {
        try { window.__sent.push(JSON.parse(data)); } catch { /* not ours */ }
      } else {
        window.__pcm += 1;
      }
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);

  // Stand in for the browser's permission prompt, which cannot be driven from
  // here: the first getUserMedia takes as long as a person takes to find and
  // tap Allow. Everything about the first-run bug hangs off that delay.
  window.__micDelay = 0;
  window.__gumCalls = 0;
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__gumCalls += 1;
    if (window.__micDelay) await new Promise((r) => setTimeout(r, window.__micDelay));
    return realGUM(constraints);
  };

  /*
   * Chrome is launched with the permission pre-granted, so a cold first run
   * has to be staged. Read from localStorage rather than a window flag because
   * the app decides which route to take at module load, before a test can
   * reach in — and localStorage is the one thing that survives the reload.
   */
  /*
   * Count AudioContexts. Safari caps them per page at about four, and the one
   * past the cap neither resolves nor throws - the button sticks on
   * "Starting..." until the page is reloaded. Creating one per start and never
   * closing it is exactly how that cap gets reached.
   */
  window.__ctxCount = 0;
  const NativeCtx = window.AudioContext;
  window.AudioContext = function (...a) {
    window.__ctxCount += 1;
    return new NativeCtx(...a);
  };
  window.AudioContext.prototype = NativeCtx.prototype;
  Object.assign(window.AudioContext, NativeCtx);

  const realQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (desc) => {
    if (desc?.name === 'microphone') {
      const forced = localStorage.getItem('__testPermState');
      if (forced) return Promise.resolve({ state: forced, onchange: null });
    }
    return realQuery(desc);
  };
});

const errors = [];
page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`, { waitUntil: 'networkidle0' });
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }),
  page.click('#go'),
]);
await page.waitForSelector('#mic', { timeout: 10_000 });
await wait(1500);

const box = await page.$eval('#mic', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});

const look = () => page.evaluate(() => ({
  held: document.body.classList.contains('held'),
  hearing: document.body.classList.contains('hearing'),
  listening: document.body.classList.contains('listening'),
  label: document.getElementById('mic').textContent,
  sent: window.__sent.map((m) => m.type),
  pcm: window.__pcm,
  state: {
    held: window.foovox.state.held,
    speaking: window.foovox.state.speaking,
    listening: window.foovox.state.listening,
    heldFrames: window.foovox.state.heldFrames,
  },
}));

const reset = () => page.evaluate(() => { window.__sent = []; window.__pcm = 0; });

// A hold is one pointerdown, a wait, and one pointerup. Puppeteer's `click`
// is far too fast to be one, which is the point of doing it by hand.
async function hold(ms) {
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(ms);
  const during = await look();
  await page.mouse.up();
  await wait(400);
  return { during, after: await look() };
}

async function tap() {
  await page.mouse.click(box.x, box.y);
  await wait(1200);
  return look();
}

console.log('\n--- a tap is hands-free, not a hold ---');
await reset();
let s = await tap();
check('tap starts listening', s.listening && s.state.listening);
check('a tap is never read as a hold', !s.held && !s.state.held);
check('the label says how to stop it', s.label === 'Stop', `"${s.label}"`);

console.log('\n--- a second tap stops it ---');
s = await tap();
check('tap again stops listening', !s.listening && !s.state.listening);
check('back to the idle label', s.label === 'Talk', `"${s.label}"`);

console.log('\n--- hold from idle: a one-shot ---');
await reset();
// Put the bar out of reach first. In hands-free this microphone could not
// start a turn at all, so anything that gets through proves the hold path
// ignores the threshold rather than happening to clear it.
await page.evaluate(() => {
  window.foovox.state.settings.margin = 0.9;
  window.foovox.state.level.floor = 0.5;
});
let r = await hold(1800);
check('holding shows it is recording', r.during.held && r.during.state.held);
check('the label says what release does', r.during.label === 'Release to send', `"${r.during.label}"`);
check('it is treated as speech throughout', r.during.state.speaking);
check('audio streams while held', r.during.pcm > 10, `${r.during.pcm} frames`);
check('a bar it could never clear does not stop it', r.during.state.heldFrames > 10,
  `${r.during.state.heldFrames} frames`);
check('NO end is sent while the thumb is down', !r.during.sent.includes('end'),
  r.during.sent.join(','));
check('release sends exactly one end',
  r.after.sent.filter((t) => t === 'end').length === 1, r.after.sent.join(','));
check('release clears the held state', !r.after.held && !r.after.state.held);
check('a hold from idle returns to idle', !r.after.state.listening);
check('and the label goes back', r.after.label === 'Talk', `"${r.after.label}"`);

console.log('\n--- the silence timer cannot end a held turn ---');
await reset();
await page.evaluate(() => {
  // Well under the 1.8 s hold below: without the held branch, this would fire.
  window.foovox.state.settings.silenceMs = 300;
  window.foovox.state.settings.margin = 0.9;
  window.foovox.state.level.floor = 0.5;
});
r = await hold(1800);
check('still no end after 6x the silence window', !r.during.sent.includes('end'),
  r.during.sent.join(','));
check('the turn ends only on release',
  r.after.sent.filter((t) => t === 'end').length === 1, r.after.sent.join(','));
await page.evaluate(() => { window.foovox.state.settings.silenceMs = 800; });

console.log('\n--- hold during a hands-free conversation ---');
await tap(); // back into hands-free
await reset();
r = await hold(1500);
check('it records while held', r.during.state.held && r.during.pcm > 10);
check('release sends the turn', r.after.sent.filter((t) => t === 'end').length === 1);
check('and hands-free carries on', r.after.state.listening, `label "${r.after.label}"`);
check('the label returns to Stop', r.after.label === 'Stop', `"${r.after.label}"`);
await tap(); // stop

console.log('\n--- a fumbled press sends nothing ---');
await reset();
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await wait(500);           // long enough to engage the hold
await page.evaluate(() => {
  // Cut frame delivery *before* zeroing the counter. Zeroing alone raced the
  // worklet, which delivers every 20 ms — by the time the release landed the
  // count was back above zero and this passed or failed on timing.
  window.foovox.state.node.port.onmessage = null;
  window.foovox.state.heldFrames = 0;
});
await page.mouse.up();
await wait(400);
s = await look();
check('an empty hold sends no end', !s.sent.includes('end'), s.sent.join(','));
check('and it does not sit there looking live', !s.held && !s.hearing);

console.log('\n--- a bare click still works (scripts, screen readers) ---');
// element.click() fires no pointer events at all. Moving to pointerdown/up
// alone made this button do nothing for anyone not using a mouse or a thumb.
await reset();
await page.evaluate(() => document.getElementById('mic').click());
await wait(1200);
s = await look();
check('a scripted click starts listening', s.state.listening, `label "${s.label}"`);
await page.evaluate(() => document.getElementById('mic').click());
await wait(600);
s = await look();
check('and stops it again', !s.state.listening, `label "${s.label}"`);

console.log('\n--- the keyboard gets both modes ---');
await reset();
await page.focus('#mic');
await page.keyboard.press('Enter');
await wait(1200);
s = await look();
check('Enter taps into hands-free', s.state.listening && !s.state.held, `label "${s.label}"`);
check('one press is not two', s.label === 'Stop', `"${s.label}"`);
await page.keyboard.press('Enter');
await wait(600);
s = await look();
check('Enter again stops it', !s.state.listening);

await reset();
await page.focus('#mic');
await page.keyboard.down(' ');
await wait(1500);
const heldByKey = await look();
await page.keyboard.up(' ');
await wait(400);
s = await look();
check('holding Space is push-to-talk', heldByKey.state.held, `label "${heldByKey.label}"`);
check('it records while the key is down', heldByKey.pcm > 10, `${heldByKey.pcm} frames`);
check('no end until the key comes up', !heldByKey.sent.includes('end'), heldByKey.sent.join(','));
check('releasing sends exactly one end',
  s.sent.filter((t) => t === 'end').length === 1, s.sent.join(','));
check('and the trailing click is not a second tap', !s.state.listening && !s.state.held,
  `listening=${s.state.listening} label "${s.label}"`);

console.log('\n--- first run: going straight for the long press ---');
/*
 * The reported bug, and the reason it is subtle.
 *
 * Safari only counts a touch as a user gesture when the finger *lifts*. A tap
 * lifts at once and the permission prompt appears; a long press asks while the
 * touch is still down, and Safari declines to prompt at all. So on a cold page
 * the long press did nothing, and tapping once first permanently "fixed" it —
 * exactly what was reported.
 *
 * The check that matters here is that no getUserMedia call is made during the
 * press. That is the call Safari would silently swallow.
 */
await page.evaluate(() => {
  localStorage.removeItem('foovox-mic-granted');
  localStorage.setItem('__testPermState', 'prompt');
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#mic', { timeout: 10_000 });
await wait(1500);
await reset();
await page.evaluate(() => { window.__gumCalls = 0; });

s = await look();
check('starts from cold, not listening', !s.state.listening, `label "${s.label}"`);

await page.mouse.move(box.x, box.y);
await page.mouse.down();
await wait(700);                       // well past HOLD_MS
const whilePrompted = await page.evaluate(() => ({
  held: window.foovox.state.held,
  label: document.getElementById('mic').textContent,
  gum: window.__gumCalls,
}));
check('the microphone is NOT asked for during the press', whilePrompted.gum === 0,
  `${whilePrompted.gum} getUserMedia calls`);
check('and it does not claim to be recording', !whilePrompted.held);
check('the button offers what it can actually do', whilePrompted.label === 'Enable microphone',
  `"${whilePrompted.label}"`);

await page.mouse.up();                 // the lift is where Safari will prompt
await wait(2500);
s = await look();
const gum = await page.evaluate(() => window.__gumCalls);
check('the release is what asks', gum === 1, `${gum} getUserMedia calls`);
check('and it ends up listening', s.state.listening, `label "${s.label}"`);
check('the button says so', s.label === 'Stop', `"${s.label}"`);
check('it did not get stuck held', !s.state.held);
const note = await page.evaluate(() =>
  [...document.querySelectorAll('.msg.note')].some((e) => /hold the Talk button/i.test(e.textContent)));
check('it explains hold-to-talk, once', note);

// And the whole point: the very next long press must work, with no tap first.
await reset();
r = await hold(1200);
check('the long press right after now records', r.during.state.held && r.during.pcm > 10,
  `${r.during.pcm} frames`);
check('and sends its turn', r.after.sent.filter((t) => t === 'end').length === 1,
  r.after.sent.join(','));
await page.evaluate(() => localStorage.removeItem('__testPermState'));

console.log('\n--- holding right through a slow permission prompt ---');
await page.evaluate(() => { window.foovox.stop(); });
await wait(400);
await reset();
await page.evaluate(() => { window.__micDelay = 1200; });
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await wait(2600);                      // still holding when the mic finally lands
const late = await look();
await page.mouse.up();
await wait(500);
s = await look();
check('a hold still pending when the mic arrives engages itself', late.state.held,
  `label "${late.label}"`);
check('and records once it can', late.pcm > 10, `${late.pcm} frames`);
check('release sends the turn', s.sent.filter((t) => t === 'end').length === 1, s.sent.join(','));
await page.evaluate(() => { window.__micDelay = 0; });

console.log(CYCLES_HEADING);
// The "it hangs on Starting, then I reload and it works" report. A context was
// created on every start and never closed, so each cycle leaked one and the app
// got closer to the cap the more it was used - which is why it worked at first
// and then stopped.
await page.evaluate(() => { window.foovox.stop(); });
await wait(300);
const ctxBefore = await page.evaluate(() => window.__ctxCount);
for (let i = 0; i < 5; i += 1) {
  await tap();                       // start
  await tap();                       // stop
}
const ctxAfter = await page.evaluate(() => window.__ctxCount);
check('ten start/stop cycles create no new AudioContext', ctxAfter === ctxBefore,
  `${ctxBefore} -> ${ctxAfter}`);
check('and it is still one for the whole page', ctxAfter <= 1, `${ctxAfter} contexts`);

// It still has to work after all that, which is the part a leak breaks last.
await reset();
r = await hold(1200);
check('hold still records after ten cycles', r.during.state.held && r.during.pcm > 10,
  `${r.during.pcm} frames`);
check('and still sends its turn', r.after.sent.filter((t) => t === 'end').length === 1,
  r.after.sent.join(','));

console.log(REENTRY_HEADING);
await page.evaluate(() => {
  window.foovox.stop();
  window.__gumCalls = 0;
  window.__micDelay = 1200;
});
await wait(300);
await page.mouse.click(box.x, box.y);
await wait(150);
await page.mouse.click(box.x, box.y);   // an impatient second press while it opens
await wait(2500);
const calls = await page.evaluate(() => window.__gumCalls);
check('a second press during a slow start is not a second stream', calls === 1,
  `${calls} getUserMedia calls`);
await page.evaluate(() => { window.__micDelay = 0; });

console.log(HEALTHY_HEADING);
check('no uncaught errors', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: path.join(ROOT, 'shot-ptt.png') });
await browser.close();

console.log(`\n${failures === 0 ? 'all push-to-talk checks passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

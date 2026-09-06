import assert from 'node:assert/strict';
import test from 'node:test';

import { EchoModel } from '../public/echo.js';

/**
 * The question this module exists to answer: is that Claude coming back
 * through the speaker, or a person talking over him?
 *
 * Synthetic speech-shaped output — loud syllables with real gaps between
 * words, because the gaps are what the whole approach turns on.
 */

const FRAME = 0.02;

/** Speech-like envelope: bursts of ~200ms separated by ~120ms of silence. */
function speechSamples(seconds, rate = 24000) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / rate;
    const inWord = (t % 0.32) < 0.2;
    out[i] = inWord ? Math.sin(2 * Math.PI * 200 * t) * 0.5 : 0;
  }
  return out;
}

function modelWithOutput(seconds = 2) {
  const model = new EchoModel({ frameMs: 20 });
  model.remember(speechSamples(seconds), 24000, 0);
  return model;
}

test('learns the coupling of a leaky speakerphone', () => {
  const model = modelWithOutput();
  const LEAK = 0.35; // a third of our output returns through the room
  for (let t = 0; t < 1.5; t += FRAME) {
    const output = model.expected(t);
    model.observe(output * LEAK, output);
  }
  assert.ok(Math.abs(model.coupling - LEAK) < 0.12,
    `coupling should approach ${LEAK}, got ${model.coupling.toFixed(3)}`);
});

test('echo alone never counts as a person', () => {
  const model = modelWithOutput();
  const LEAK = 0.35;
  const base = 0.008;
  let falseTriggers = 0;
  for (let t = 0; t < 1.5; t += FRAME) {
    const output = model.expected(t);
    const mic = output * LEAK; // pure echo, nobody in the room
    model.observe(mic, output);
    if (mic > model.threshold(base, output)) falseTriggers += 1;
  }
  assert.equal(falseTriggers, 0, `${falseTriggers} frames of echo were mistaken for speech`);
});

test('a person talking over the reply is detected', () => {
  const model = modelWithOutput();
  const LEAK = 0.35;
  const base = 0.008;
  // Let it settle on the room first.
  for (let t = 0; t < 1; t += FRAME) {
    const output = model.expected(t);
    model.observe(output * LEAK, output);
  }
  // Now somebody speaks at a normal level, on top of the echo.
  let detected = 0;
  for (let t = 1; t < 1.5; t += FRAME) {
    const output = model.expected(t);
    const mic = output * LEAK + 0.15; // their voice adds to what is already there
    if (mic > model.threshold(base, output)) detected += 1;
  }
  assert.ok(detected > 20, `only ${detected} frames of real speech were detected`);
});

test('the gaps between words are heard at full sensitivity', () => {
  // The point of the design: in a gap the predicted echo is zero, so a quiet
  // interruption is caught immediately rather than having to out-shout Claude.
  const model = modelWithOutput();
  model.coupling = 0.6;
  const base = 0.008;
  const quiet = 0.02; // someone starting to speak softly

  let gapFrames = 0;
  let gapDetected = 0;
  for (let t = 0; t < 1.5; t += FRAME) {
    const output = model.expected(t);
    if (output > 0.01) continue; // mid-word, not a gap
    gapFrames += 1;
    if (quiet > model.threshold(base, output)) gapDetected += 1;
  }
  assert.ok(gapFrames > 5, 'the fixture should contain gaps between words');
  assert.equal(gapDetected, gapFrames,
    'a quiet voice in a gap must be detected in every gap frame');
});

test('a person is not drowned out by a loud reply', () => {
  // Regression guard on the learning rule: without the "echo alone" condition
  // in observe(), a person's voice teaches the model that the echo is huge and
  // they can never be heard again.
  const model = modelWithOutput();
  const base = 0.008;
  for (let t = 0; t < 1.5; t += FRAME) {
    const output = model.expected(t);
    model.observe(output * 0.35 + 0.2, output); // loud person, whole time
  }
  assert.ok(model.coupling < 0.8,
    `coupling ran away to ${model.coupling.toFixed(2)} — a person taught it to ignore people`);
});

test('envelopes are forgotten once they can no longer explain anything', () => {
  const model = modelWithOutput(1);
  model.expected(0.5);
  assert.ok(model.clips.length > 0);
  model.expected(60);
  assert.equal(model.clips.length, 0, 'old output envelopes were never pruned');
});

test('measures the delay between speaking and hearing it back', () => {
  // Simulate a device whose speaker-to-microphone path lags by 90ms, and check
  // the model finds it rather than keeping its 60ms default.
  const TRUE_LAG = 0.09;
  const model = modelWithOutput(3);
  model.lag = 0.02; // start wrong on purpose
  for (let round = 0; round < 4; round += 1) {
    for (let t = 0; t < 2; t += FRAME) {
      model.pushMic(t, model.at(t - TRUE_LAG) * 0.4);
    }
    model.estimateLag(2);
  }
  assert.ok(Math.abs(model.lag - TRUE_LAG) < 0.025,
    `lag should converge near ${TRUE_LAG}, got ${model.lag.toFixed(3)}`);
});

test('a tight window keeps the gaps intact', () => {
  // The regression that broke the whole idea: a wide max-window smeared over
  // the gaps between words and there were none left to hear a person in.
  const model = modelWithOutput(2);
  model.lag = 0;
  let silent = 0;
  for (let t = 0; t < 1.5; t += FRAME) if (model.expected(t) <= 0.01) silent += 1;
  assert.ok(silent > 10, `only ${silent} gap frames survived the window`);
});

test('says nothing at all during the opening of a reply', () => {
  // The reported failure: "the moment it started talking it cut itself off."
  // At playback start the lag is unmeasured, so no judgement is safe yet.
  const model = modelWithOutput();
  model.startPlayback(0);
  const loud = 1.0; // even a shout must not interrupt during the hold-off
  let triggered = 0;
  for (let t = 0; t < 0.7; t += FRAME) {
    if (loud > model.guard(0.008, model.expected(t), t)) triggered += 1;
  }
  assert.equal(triggered, 0, `${triggered} frames interrupted during the hold-off`);
});

test('a wrong lag can no longer cause a self-interrupt', () => {
  // The guard has to hold even when the lag estimate is badly wrong, because
  // that is precisely the state the model is in when a reply begins.
  const TRUE_LAG = 0.15;
  const model = modelWithOutput(4);
  model.lag = 0.0; // as wrong as it gets
  model.startPlayback(0);

  // Hold-off: measure whatever the room gives back.
  for (let t = 0; t < 0.7; t += FRAME) {
    model.notePeak(model.at(t - TRUE_LAG) * 0.4);
  }
  // Afterwards, pure echo must still never read as a person.
  let falseTriggers = 0;
  for (let t = 0.7; t < 2.5; t += FRAME) {
    const mic = model.at(t - TRUE_LAG) * 0.4;
    if (mic > model.guard(0.008, model.expected(t), t)) falseTriggers += 1;
  }
  assert.equal(falseTriggers, 0,
    `${falseTriggers} frames of echo interrupted despite a 150ms lag error`);
});

test('a person louder than the room still gets through', () => {
  const TRUE_LAG = 0.15;
  const model = modelWithOutput(4);
  model.lag = 0.0;
  model.startPlayback(0);
  for (let t = 0; t < 0.7; t += FRAME) model.notePeak(model.at(t - TRUE_LAG) * 0.4);

  let detected = 0;
  for (let t = 0.7; t < 1.5; t += FRAME) {
    const mic = model.at(t - TRUE_LAG) * 0.4 + 0.4; // someone speaking up
    if (mic > model.guard(0.008, model.expected(t), t)) detected += 1;
  }
  assert.ok(detected > 10, `only ${detected} frames of a real interruption got through`);
});

test('the bar falls back to normal in the gaps between words', () => {
  // Reported from a phone: "when the bot is talking the threshold goes all the
  // way up so I can't even interrupt it". The peak guard was a flat floor for
  // the whole reply, which erased the gaps — and the gaps were the mechanism.
  const model = modelWithOutput(3);
  model.lag = 0;
  model.startPlayback(0);
  for (let t = 0; t < 0.7; t += FRAME) model.notePeak(0.30); // a loud speakerphone
  // Gaps only open once the delay has been measured — see `lagMeasured`.
  model.lagMeasured = true;
  const VOICE = 0.09;

  let openings = 0;
  for (let t = 0.7; t < 2.5; t += FRAME) {
    const output = model.expected(t);
    if (output > 0.01) continue;                  // mid-word, guarded
    if (VOICE > model.guard(0.008, output, t, VOICE)) openings += 1;
  }
  assert.ok(openings > 10, `only ${openings} gap frames were interruptible`);
});

test('the bar never rises above a level the person can reach', () => {
  // On speaker the echo peak can exceed the user's own voice, and the bar was
  // set from the echo — so no amount of shouting could clear it.
  const model = modelWithOutput(3);
  model.startPlayback(0);
  for (let t = 0; t < 0.7; t += FRAME) model.notePeak(0.5); // echo louder than them
  const VOICE = 0.09;

  for (let t = 0.7; t < 2.0; t += FRAME) {
    const bar = model.guard(0.008, model.expected(t), t, VOICE);
    assert.ok(bar <= VOICE, `bar ${bar.toFixed(3)} is above the user's voice ${VOICE} at t=${t.toFixed(2)}`);
  }
});

test('with no learned voice it still defends against echo', () => {
  // Before the user has been measured there is no ceiling to apply, and the
  // echo guard must still do its job.
  const model = modelWithOutput(3);
  model.lag = 0;
  model.startPlayback(0);
  for (let t = 0; t < 0.7; t += FRAME) model.notePeak(model.at(t) * 0.4);

  let falseTriggers = 0;
  for (let t = 0.7; t < 2.0; t += FRAME) {
    const output = model.expected(t);
    const mic = model.at(t) * 0.4; // pure echo
    if (mic > model.guard(0.008, output, t, 0)) falseTriggers += 1;
  }
  assert.equal(falseTriggers, 0, `${falseTriggers} echo frames read as speech`);
});

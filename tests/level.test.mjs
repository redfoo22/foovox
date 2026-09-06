import assert from 'node:assert/strict';
import test from 'node:test';

import { LevelModel } from '../public/level.js';

/**
 * Both of these tests exist because of a specific complaint from a phone in a
 * room with other people in it:
 *
 *   "when I'm talking it sets it right — I see the sensitivity moving — and if
 *    it would just stay up there it wouldn't pick up the noise when I stop.
 *    But it goes right back down."
 *
 *   "when I set the mic sensitivity in the settings, it doesn't do anything."
 */

const FRAME = 20;
const seconds = (n) => Math.round((n * 1000) / FRAME);

const ROOM = 0.004;   // quiet room
const VOICE = 0.09;   // the person holding the phone
const OTHERS = 0.02;  // someone talking across the room

function settle(model, level, forSeconds) {
  for (let i = 0; i < seconds(forSeconds); i += 1) model.observeQuiet(level);
  return model;
}

function speak(model, level, forSeconds) {
  for (let i = 0; i < seconds(forSeconds); i += 1) model.observeSpeech(level);
  return model;
}

test('the bar sits between the room and your voice', () => {
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);
  const t = m.threshold(0.35);
  assert.ok(t > ROOM, `bar ${t.toFixed(4)} must be above the room ${ROOM}`);
  assert.ok(t < VOICE, `bar ${t.toFixed(4)} must be below your voice ${VOICE}`);
});

test('the bar stays up while you pause', () => {
  // The actual complaint. After speaking, a few seconds of silence must not
  // drop the bar back onto room noise.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);
  const rightAfter = m.threshold(0.35);

  settle(m, ROOM, 5); // five seconds of thinking
  const afterPause = m.threshold(0.35);

  assert.ok(afterPause > rightAfter * 0.75,
    `bar collapsed during a pause: ${rightAfter.toFixed(4)} -> ${afterPause.toFixed(4)}`);
  assert.ok(afterPause > OTHERS,
    `after a pause the bar ${afterPause.toFixed(4)} is below other people ${OTHERS} — they will trigger it`);
});

test('someone talking across the room does not clear the bar', () => {
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 3);
  settle(m, ROOM, 3);

  let crossings = 0;
  for (let i = 0; i < seconds(10); i += 1) {
    if (OTHERS > m.threshold(0.35)) crossings += 1;
    m.observeQuiet(OTHERS); // and it is heard as room noise the whole time
  }
  assert.equal(crossings, 0, `${crossings} frames of someone else's voice cleared the bar`);
});

test('you still clear your own bar after a long pause', () => {
  // The bar holding up is only useful if it does not lock you out.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 3);
  settle(m, ROOM, 20);
  assert.ok(VOICE > m.threshold(0.35),
    `your own voice ${VOICE} no longer clears the bar ${m.threshold(0.35).toFixed(4)}`);
});

test('the sensitivity control actually changes the threshold', () => {
  // The old formula was max(floor * sensitivity, 0.008). In a quiet room every
  // slider position landed under the 0.008 minimum and produced an identical
  // threshold, so the control was inert across nearly its whole travel.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);

  const low = m.threshold(0.1);
  const mid = m.threshold(0.5);
  const high = m.threshold(0.9);

  assert.ok(low < mid && mid < high, `not monotonic: ${low} ${mid} ${high}`);
  assert.ok(high > low * 2, `the range is too narrow to be useful: ${low} to ${high}`);
});

test('the control works before your voice has ever been measured', () => {
  // First utterance of a fresh session: nothing learned yet, and the slider
  // still has to do something or it looks broken on the very first try.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  assert.ok(!m.learned);

  const low = m.threshold(0.1);
  const high = m.threshold(0.9);
  assert.ok(high > low * 2, `inert before learning: ${low} to ${high}`);
  assert.ok(low > ROOM, 'even the lowest setting must sit above the room');
});

test('a noisy room raises the floor without pinning the bar to it', () => {
  const LOUD_ROOM = 0.03;
  const m = new LevelModel();
  settle(m, LOUD_ROOM, 4);
  speak(m, 0.2, 2);
  const t = m.threshold(0.35);
  assert.ok(t > LOUD_ROOM, `bar ${t.toFixed(4)} must clear a loud room ${LOUD_ROOM}`);
  assert.ok(t < 0.2, 'but must still be under the voice');
});

test('one loud bang does not deafen it', () => {
  const m = new LevelModel();
  settle(m, ROOM, 2);
  const before = m.threshold(0.35);
  for (let i = 0; i < 5; i += 1) m.observeQuiet(0.5); // a door slam
  settle(m, ROOM, 2);
  const after = m.threshold(0.35);
  assert.ok(after < before * 3, `a transient moved the floor too far: ${before} -> ${after}`);
});

test('it takes more to start a turn than to keep one going', () => {
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);
  assert.ok(m.holdThreshold(0.35) < m.threshold(0.35),
    'the bar for continuing must be below the bar for starting');
});

test('a quiet syllable does not end a sentence', () => {
  // The reported failure: "if I don't talk at my max volume all the time then
  // it's cutting off". Real speech swings between a loud stressed syllable and
  // an unstressed one at roughly a third of it.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);

  const QUIET_SYLLABLE = VOICE * 0.3;
  assert.ok(QUIET_SYLLABLE > m.holdThreshold(0.35),
    `a quiet syllable (${QUIET_SYLLABLE.toFixed(4)}) fell under the hold bar `
    + `(${m.holdThreshold(0.35).toFixed(4)}) — the sentence would be cut off`);
});

test('but the room still cannot start a turn', () => {
  // Lowering the hold bar must not lower the start bar with it.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);
  settle(m, ROOM, 2);
  assert.ok(OTHERS < m.threshold(0.35),
    'someone across the room should still be under the bar that starts a turn');
});

test('the hold bar still sits above the room', () => {
  // It has to end the turn eventually, or a pause never finishes an utterance.
  const m = new LevelModel();
  settle(m, ROOM, 2);
  speak(m, VOICE, 2);
  assert.ok(m.holdThreshold(0.35) > ROOM,
    'silence must fall below the hold bar or the turn never ends');
});

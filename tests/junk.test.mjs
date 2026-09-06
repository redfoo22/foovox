import assert from 'node:assert/strict';
import test from 'node:test';

import { isJunk } from '../server/junk.mjs';

/**
 * "A bird chirps and now we're started all over."
 *
 * The asymmetry that sets the bar: dropping a real short utterance costs the
 * person saying "yes" a second time. Accepting a hallucinated one puts a
 * sentence they never said into the conversation history, and every later
 * answer is conditioned on it.
 */

test('drops what Whisper invents about silence', () => {
  // "Okay" is deliberately absent: it is both a hallucination and a real way
  // of saying "yes, go ahead", so it is handled by length instead — see the
  // ambiguity test below.
  for (const noise of ['Thank you.', 'you', 'Thanks for watching!', 'Bye.',
    'um', '...', '[BLANK_AUDIO]', '(music)', ' ', '.', '!']) {
    const { junk } = isJunk(noise, 1.0);
    assert.ok(junk, `let noise through: "${noise}"`);
  }
});

test('never drops a real utterance', () => {
  for (const real of [
    'yes',
    'no, stop',
    'count to ten',
    'what is the weather in Kona',
    'thank you, that worked',
    'okay do it again',
    'run the tests',
    'go',
  ]) {
    const { junk, why } = isJunk(real, 1.6);
    assert.ok(!junk, `dropped a real utterance: "${real}" (${why})`);
  }
});

test('a fragment of audio cannot be a sentence', () => {
  // A quarter-second is under two syllables. Whatever was transcribed from it
  // was invented, however confident the words look.
  assert.ok(isJunk('Get me the stock price for Apple', 0.2).junk);
  assert.ok(!isJunk('Get me the stock price for Apple', 2.0).junk);
});

test('one filler word out of several seconds is a mis-hearing', () => {
  assert.ok(isJunk('so', 3.0).junk, 'three seconds does not produce one filler word');
  assert.ok(isJunk('um', 4.0).junk);
  assert.ok(!isJunk('go', 0.8).junk, 'a genuinely short command is fine');
});

test('the answers that matter most are never dropped on length', () => {
  // The first version of the length rule threw away a real "yes" — the single
  // worst word to lose, because it is how someone agrees to something.
  for (const seconds of [0.6, 1.6, 3.0, 6.0]) {
    for (const word of ['yes', 'no', 'go', 'stop', 'wait']) {
      const { junk, why } = isJunk(word, seconds);
      assert.ok(!junk, `dropped "${word}" at ${seconds}s (${why})`);
    }
  }
});

test('short real commands survive', () => {
  // These matter: they are how someone stops a runaway reply.
  for (const cmd of ['stop', 'wait', 'no', 'cancel that', 'louder']) {
    assert.ok(!isJunk(cmd, 1.0).junk, `dropped a command: "${cmd}"`);
  }
});

test('always says why, so it can be shown rather than guessed at', () => {
  const { junk, why } = isJunk('Thank you.', 1.0);
  assert.ok(junk);
  assert.ok(why && why.length > 5, 'a dropped turn needs a reason to display');
});

test('"okay" is an answer, not just noise', () => {
  // Both a hallucination and a real way of saying "yes, go ahead". Dropped only
  // when the audio is far longer than the word — the signature of noise.
  assert.ok(!isJunk('okay', 0.7).junk, 'a crisp "okay" is someone agreeing');
  assert.ok(!isJunk('yeah', 1.0).junk);
  assert.ok(isJunk('okay', 4.0).junk, 'four seconds producing "okay" is noise');
});

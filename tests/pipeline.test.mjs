import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChunker } from '../server/sessions.js';
import { makeSpeechFilter } from '../server/speech-text.mjs';

/**
 * The speech filter and the chunker end to end.
 *
 * Each is well covered alone, and the bug that prompted this file lived
 * precisely between them: the end-of-turn path called `chunker.push()` and
 * discarded what it returned. Long replies were unaffected, because the filter
 * releases those mid-stream where the return value is used — so every test
 * passed while every short reply was silently never spoken.
 *
 * Asked to count to ten, the transcript read "1, 2, 3, 4, 5, 6, 7, 8, 9, 10."
 * and the speaker said nothing.
 */

/** Exactly what a turn does: stream deltas in, collect what would be spoken. */
function speakThrough(reply, deltaSize = 7) {
  const filter = makeSpeechFilter();
  const chunker = makeChunker();
  const spoken = [];

  for (let i = 0; i < reply.length; i += deltaSize) {
    const out = filter.feed(reply.slice(i, i + deltaSize));
    if (out) spoken.push(...chunker.push(out));
  }
  const tail = filter.flush();
  if (tail) spoken.push(...chunker.push(tail));
  spoken.push(...chunker.flush());

  return spoken.join('');
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

test('counting to ten is actually spoken', () => {
  const out = speakThrough('1, 2, 3, 4, 5, 6, 7, 8, 9, 10.');
  for (const n of ['1', '5', '10']) {
    assert.ok(out.includes(n), `"${n}" was never spoken: "${out}"`);
  }
});

test('a short reply is never silently dropped', () => {
  // The whole class of bug: anything that arrives without a newline and is too
  // short for the filter's early release used to vanish entirely.
  for (const reply of [
    'Yes.',
    'About four seconds.',
    'Tokyo is the capital of Japan.',
    'One, two, three, four, five, six.',
    'That is done, and it took about a minute.',
    'I checked and everything looks fine to me.',
  ]) {
    const out = speakThrough(reply);
    assert.ok(out.trim().length > 0, `nothing spoken for: "${reply}"`);
    // Every word of the original has to survive to the speaker.
    for (const w of words(reply)) {
      assert.ok(words(out).includes(w), `lost the word "${w}" from "${reply}" -> "${out}"`);
    }
  }
});

test('nothing is lost at any delta size', () => {
  const reply = 'Counting now: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10. That is ten.';
  for (const size of [1, 2, 3, 5, 11, 40, 500]) {
    const out = speakThrough(reply, size);
    for (const w of words(reply)) {
      assert.ok(words(out).includes(w), `lost "${w}" at delta size ${size}: "${out}"`);
    }
  }
});

test('a long reply still streams rather than arriving all at the end', () => {
  const reply = 'A deadlock is when two or more processes each hold a resource '
    + 'the other one needs, so neither can ever proceed and both wait forever.';
  const filter = makeSpeechFilter();
  const chunker = makeChunker();
  let firstAt = -1;
  let seen = 0;
  for (let i = 0; i < reply.length; i += 7) {
    const out = filter.feed(reply.slice(i, i + 7));
    if (out) {
      const chunks = chunker.push(out);
      if (chunks.length && firstAt < 0) firstAt = i;
      seen += chunks.length;
    }
  }
  assert.ok(firstAt >= 0 && firstAt < reply.length * 0.7,
    `first chunk only appeared at ${firstAt} of ${reply.length} — not streaming`);
  assert.ok(seen >= 1);
});

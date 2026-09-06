import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChunker } from '../server/sessions.js';

/**
 * The chunker decides what gets spoken and when, and its failures are audible
 * rather than visible: a lost clause is a sentence that stops halfway, and a
 * split inside a word is two wrong words read aloud.
 *
 * Both bugs it has actually had were invisible at one delta size and obvious
 * at another — the "Senso-ji" split only happened when a delta boundary landed
 * inside that word — so every case runs at every granularity from one
 * character to forty.
 */

const SAMPLES = [
  "Tokyo is the capital of Japan. It's famous for blending ultramodern and traditional, think neon-lit districts like Shibuya and Shinjuku alongside historic sites like the Senso-ji temple and the Imperial Palace.",
  'A mutex is like a single key to a locked room. A semaphore is more like a bouncer counting how many people are already inside, so several can hold it at once.',
  'Yes.',
  'No punctuation at all just a long run of words that never terminates properly and keeps going well past any reasonable cap so the hard limit has to fire somewhere sensible',
  'Version 3.5 shipped on Dr. Smith\'s birthday. That is 2.7 times faster than before.',
];

const stream = (text, size) => {
  const chunker = makeChunker();
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)));
  out.push(...chunker.flush());
  return out;
};

test('never loses or reorders text, at any delta size', () => {
  for (const text of SAMPLES) {
    for (let size = 1; size <= 40; size += 1) {
      assert.equal(stream(text, size).join(''), text,
        `text was altered for size=${size}: ${text.slice(0, 40)}...`);
    }
  }
});

test('never splits inside a word', () => {
  for (const text of SAMPLES) {
    for (let size = 1; size <= 40; size += 1) {
      const chunks = stream(text, size);
      // A boundary is legal only where the original text had whitespace.
      let at = 0;
      for (const chunk of chunks.slice(0, -1)) {
        at += chunk.length;
        const before = text[at - 1];
        const after = text[at];
        assert.ok(/\s/.test(before) || /\s/.test(after),
          `size=${size} split mid-word: ...${text.slice(Math.max(0, at - 12), at)}|${text.slice(at, at + 12)}...`);
      }
    }
  }
});

test('first chunk is short enough to start speaking quickly', () => {
  for (const text of SAMPLES) {
    for (let size = 1; size <= 40; size += 1) {
      const [firstChunk] = stream(text, size);
      const words = firstChunk.trim().split(/\s+/).filter(Boolean).length;
      // 12 is the cap; the flush path can return a shorter whole utterance.
      assert.ok(words <= 12, `first chunk was ${words} words at size=${size}: "${firstChunk}"`);
    }
  }
});

test('later chunks stay under the cap that keeps synthesis ahead of playback', () => {
  const long = SAMPLES[3];
  for (let size = 1; size <= 40; size += 1) {
    for (const chunk of stream(long, size)) {
      const words = chunk.trim().split(/\s+/).filter(Boolean).length;
      assert.ok(words <= 20, `chunk was ${words} words at size=${size}`);
    }
  }
});

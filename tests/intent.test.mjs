import assert from 'node:assert/strict';
import test from 'node:test';

import { detectIntent } from '../public/intent.js';

/**
 * The asymmetry that sets the bar here: a missed intent costs one repeated
 * sentence. A false dispatch starts a Claude with tools armed, on the machine
 * that also runs a live website and a logged-in storefront. So the tests for
 * "must not fire" matter more than the tests for "must fire", and normal
 * conversation is the adversary.
 */

test('recognises asking for status', () => {
  for (const said of [
    'status',
    'give me a status',
    "what's the status",
    "how's it going",
    'how are the jobs coming',
    'hey, status',
    'what are you working on',
    'is it still running',
  ]) {
    assert.equal(detectIntent(said)?.type, 'status', `missed status in: "${said}"`);
  }
});

test('recognises a dispatch that names a model', () => {
  const cases = [
    ['code it in Opus', 'claude-opus-5'],
    ['build that with Fable', 'claude-fable-5'],
    ['go implement this in Opus', 'claude-opus-5'],
    ['work on it using Sonnet', 'claude-sonnet-5'],
    ['dispatch this', 'claude-opus-5'],
    ['start a job', 'claude-opus-5'],
  ];
  for (const [said, model] of cases) {
    const intent = detectIntent(said);
    assert.equal(intent?.type, 'dispatch', `missed dispatch in: "${said}"`);
    assert.equal(intent.model, model, `wrong model for: "${said}"`);
  }
});

test('does not dispatch on ordinary conversation', () => {
  // Every one of these is a thing you might genuinely say to a voice assistant.
  // Any of them starting a tool-armed job would be a bad day.
  for (const said of [
    'what is a mutex',
    'can you explain how the parser works',
    'I think we should build a new front end at some point',
    'tell me about Opus',
    'what is the difference between Opus and Sonnet',
    'is Opus better for this kind of thing',
    "let's use Opus for the next one",
    'that build failed yesterday',
    'do you think it works',
    'how do I make a sourdough starter',
    'run me through the plan',
    'what did you do',
  ]) {
    const intent = detectIntent(said);
    assert.notEqual(intent?.type, 'dispatch', `false dispatch on: "${said}"`);
  }
});

test('a model name alone is not an instruction', () => {
  // Mentioning Opus while talking about Opus must never start a job.
  assert.equal(detectIntent('Opus is the smartest one right')?.type, undefined);
  assert.equal(detectIntent('I like Opus')?.type, undefined);
});

test('an instruction without a model goes to the current session', () => {
  // "build it" is a request to whoever you are talking to, not a dispatch.
  assert.equal(detectIntent('build it')?.type, undefined);
  assert.equal(detectIntent('write that for me')?.type, undefined);
});

test('picks up a narrowing hint', () => {
  const intent = detectIntent('code it in Opus, focus on the retry logic');
  assert.equal(intent.type, 'dispatch');
  assert.match(intent.hint, /retry logic/);
});

test('empty and junk input is ignored', () => {
  assert.equal(detectIntent(''), null);
  assert.equal(detectIntent(null), null);
  assert.equal(detectIntent('   '), null);
});

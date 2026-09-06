import assert from 'node:assert/strict';
import test from 'node:test';

import { statusReport, spokenModel } from '../server/status.mjs';

/**
 * A status report is heard, not read. It cannot be skimmed or scrolled, so
 * every wasted clause is real time spent listening — and anything that spells
 * a file path out one character at a time is worse than saying nothing.
 */

const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

const job = (over = {}) => ({
  id: 's_1', kind: 'work', model: 'claude-opus-5', busy: true, status: 'working',
  runningSeconds: 65, idleSeconds: 0, lastTool: 'Edit', summary: 'Building the parser.',
  title: 'parser', error: null, ...over,
});

test('says so plainly when nothing is running', () => {
  assert.match(statusReport([]), /Nothing is running/i);
  assert.match(statusReport([{ kind: 'voice', id: 'v' }]), /Nothing is running/i);
});

test('never reads a file path out character by character', () => {
  // The real output that caused this: a Windows path quoted verbatim into
  // speech, read as "C colon backslash Users backslash alex backslash…".
  const winPath = ['C:', 'Users', 'alex', 'foovox', 'wordcount.mjs'].join(BACKSLASH);
  const text = statusReport([job({
    summary: `I wrote the script but the write to ${BACKTICK}${winPath}${BACKTICK} was not approved.`,
  })]);
  assert.ok(!text.includes('C:'), `a drive letter survived: ${text}`);
  assert.ok(!text.includes(BACKSLASH), `a backslash survived: ${text}`);
  assert.ok(!text.includes(BACKTICK), `a backtick survived: ${text}`);
  assert.match(text, /wordcount\.mjs/, 'the filename itself is worth keeping');
});

test('strips POSIX paths too', () => {
  const text = statusReport([job({ summary: 'Edited /home/user/project/src/main.js today.' })]);
  assert.ok(!text.includes('/home/'), `a posix path survived: ${text}`);
  assert.match(text, /main\.js/);
});

test('a truncated quote still ends in a full stop', () => {
  // Otherwise it runs straight into the next sentence, which is how
  // "It said: I'll create Finished 2 minutes ago on Opus." happened.
  const text = statusReport([
    job({ summary: "I'll create the thing and then go on at considerable length about it without ever reaching a full stop which is exactly the case that ran two sentences together" }),
    job({ id: 's_2', busy: false, status: 'done', idleSeconds: 120, summary: 'Done.' }),
  ]);
  assert.ok(!/[a-z] Finished/.test(text), `sentences ran together: ${text}`);
});

test('names the model the way a person says it', () => {
  assert.equal(spokenModel('claude-opus-5'), 'Opus');
  assert.equal(spokenModel('claude-haiku-4-5-20251001'), 'Haiku');
  assert.match(statusReport([job()]), /Opus/);
});

test('leads with the shape, not the detail', () => {
  const text = statusReport([job(), job({ id: 's_2' }), job({ id: 's_3', busy: false, status: 'done' })]);
  assert.match(text.split('.')[0], /3 jobs/, `should open with the count: ${text}`);
});

test('excludes the session doing the asking', () => {
  assert.match(statusReport([job({ id: 'me' })], 'me'), /Nothing is running/i);
});

test('surfaces a failure', () => {
  assert.match(statusReport([job({ busy: false, status: 'error', error: 'build failed' })]), /failed/i);
});

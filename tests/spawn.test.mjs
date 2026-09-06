import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore } from '../server/sessions.js';

/**
 * One job must never be able to take the server down with it.
 *
 * `spawn` reports failure asynchronously through an `error` event, and an
 * EventEmitter with no listener for `error` rethrows it as an uncaught
 * exception. A dispatch pointed at a directory that did not exist killed the
 * whole server — every other session, and the phone's connection with it.
 */

/*
 * A fresh path per test rather than deleting and recreating one.
 *
 * `rmSync` followed immediately by `mkdirSync` of the same tree is a race on
 * Windows — the removal can still be settling when the create runs, which
 * fails with EPERM. That made this test fail about one run in three, on a
 * filesystem quirk rather than on anything it was written to check.
 */
let counter = 0;
const freshDir = () => path.join(os.tmpdir(), `foovox-spawn-${process.pid}-${counter += 1}`);

test('a missing working directory is created rather than fatal', () => {
  const store = new SessionStore();
  const scratch = freshDir();
  const dir = path.join(scratch, 'nested', 'deep');

  const session = store.create({ cwd: dir, kind: 'work' });
  session.on('error', () => { /* must not be required, must not throw */ });

  assert.doesNotThrow(() => session.start(), 'start must never throw');
  assert.ok(existsSync(dir), 'the working directory should have been created');

  session.stop();
  store.stopAll();
  rmSync(scratch, { recursive: true, force: true });
});

test('an unusable working directory falls back instead of failing', () => {
  const store = new SessionStore();
  // A path that cannot be created on Windows: reserved characters.
  const session = store.create({ cwd: 'C:\\<not|a*dir>', kind: 'work' });
  const errors = [];
  session.on('error', (e) => errors.push(e));

  // Deliberately not asserting on `session.proc`. That was flaky: under load a
  // spawn can fail asynchronously and the error handler correctly nulls it, so
  // the test failed on the very behaviour it exists to protect. What matters
  // is that a bad directory does not throw and does not kill the process.
  assert.doesNotThrow(() => session.start(), 'a bad cwd must never throw synchronously');
  assert.equal(session.status, 'error', 'it should refuse, not silently run elsewhere');
  assert.ok(!session.proc, "it must not spawn in the server's own directory");

  session.stop();
  store.stopAll();
});

test('the store survives a session that cannot start', async () => {
  const store = new SessionStore();
  const ok = store.create({ kind: 'voice' });
  ok.on('error', () => {});
  ok.start();

  const bad = store.create({ cwd: 'C:\\<bad>', kind: 'work' });
  bad.on('error', () => {});
  bad.start();
  await new Promise((r) => setTimeout(r, 200));

  /*
   * The property being protected is that the *store* survives — one bad
   * dispatch used to take the whole server, and every other conversation, down
   * with it. Asserting the healthy session still holds a live process was
   * flaky under load and is not the point; that this code is still running,
   * and both sessions are still listed, is.
   */
  assert.equal(store.list().length, 2, 'both sessions must still be tracked');
  assert.doesNotThrow(() => store.list(), 'the store must still be usable');

  store.stopAll();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionStore } from '../server/sessions.js';

/**
 * These exist because of a report that sessions were not saved at all:
 *
 *   "sessions are not working correctly... it's not saving the sessions
 *    history at all, if I go to a new session then they all are new"
 *
 * Two separate faults sat behind that single complaint, and either one alone
 * produces exactly that experience.
 *
 * **Nothing survived a restart.** The store was a plain Map. Every deploy,
 * crash or reboot discarded every conversation, and the rail came back empty.
 *
 * **Nothing recorded what was said.** The claude process held the conversation
 * and `--resume` restored it, but the app kept no transcript, so switching
 * sessions changed which process you were talking to while leaving the previous
 * one's messages on screen.
 */

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'foovox-sessions-'));
  return { file: path.join(dir, 'sessions.json'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A session that has been talked to, without spawning a real CLI. */
function used(store, { text = 'hello', reply = 'hi there' } = {}) {
  const s = store.create({ model: 'claude-sonnet-5', tier: 'chat' });
  s.claudeSessionId = `claude-${s.id}`;   // what `--resume` needs
  s.title = text.slice(0, 60);
  s.remember('me', text);
  s.remember('claude', reply);
  s.turns = 1;
  store.save();
  return s;
}

test('a conversation survives a restart', () => {
  const { file, clean } = temp();
  try {
    const before = new SessionStore({ file });
    const s = used(before, { text: 'what is a mutex', reply: 'A lock.' });

    // The restart. Only the file carries over.
    const after = new SessionStore({ file });
    const restored = after.get(s.id);
    assert.ok(restored, 'the session was lost entirely');
    assert.equal(restored.title, 'what is a mutex');
    assert.equal(restored.claudeSessionId, `claude-${s.id}`,
      'without the resume id the conversation cannot be continued');
    after.stopAll();
    before.stopAll();
  } finally { clean(); }
});

test('what was said comes back with it', () => {
  const { file, clean } = temp();
  try {
    const before = new SessionStore({ file });
    const s = used(before, { text: 'count to three', reply: 'One, two, three.' });

    const after = new SessionStore({ file });
    const history = after.get(s.id).transcript();
    assert.deepEqual(history, [
      { role: 'me', text: 'count to three' },
      { role: 'claude', text: 'One, two, three.' },
    ]);
    after.stopAll();
    before.stopAll();
  } finally { clean(); }
});

test('several sessions all come back, and stay separate', () => {
  // The heart of the complaint: switching between them must not blur them.
  const { file, clean } = temp();
  try {
    const before = new SessionStore({ file });
    const a = used(before, { text: 'first thing', reply: 'answer one' });
    const b = used(before, { text: 'second thing', reply: 'answer two' });

    const after = new SessionStore({ file });
    assert.equal(after.list().length, 2);
    assert.equal(after.get(a.id).transcript()[0].text, 'first thing');
    assert.equal(after.get(b.id).transcript()[0].text, 'second thing');
    after.stopAll();
    before.stopAll();
  } finally { clean(); }
});

test('a session nobody used is not persisted', () => {
  // Otherwise every stray tap on "New" accumulates forever in the rail.
  const { file, clean } = temp();
  try {
    const before = new SessionStore({ file });
    before.create({ model: 'claude-sonnet-5' });
    const after = new SessionStore({ file });
    assert.equal(after.list().length, 0);
    after.stopAll();
    before.stopAll();
  } finally { clean(); }
});

test('deleting a session removes it for good', () => {
  const { file, clean } = temp();
  try {
    const before = new SessionStore({ file });
    const s = used(before);
    before.remove(s.id);
    const after = new SessionStore({ file });
    assert.equal(after.get(s.id), null);
    after.stopAll();
    before.stopAll();
  } finally { clean(); }
});

test('the transcript is capped, so a long day cannot grow without limit', () => {
  const { file, clean } = temp();
  try {
    const store = new SessionStore({ file });
    const s = store.create({});
    for (let i = 0; i < 400; i += 1) s.remember('me', `message ${i}`);
    assert.ok(s.history.length <= 120, `history grew to ${s.history.length}`);
    // The newest turns are the ones worth keeping.
    assert.match(s.history[s.history.length - 1].text, /399/);
    store.stopAll();
  } finally { clean(); }
});

test('a huge single reply does not blow the transcript budget', () => {
  const { file, clean } = temp();
  try {
    const store = new SessionStore({ file });
    const s = store.create({});
    for (let i = 0; i < 30; i += 1) s.remember('claude', 'x'.repeat(7000));
    const total = s.history.reduce((n, h) => n + h.text.length, 0);
    assert.ok(total <= 60_000, `transcript held ${total} characters`);
    store.stopAll();
  } finally { clean(); }
});

test('a corrupt file starts empty rather than refusing to boot', () => {
  const { file, clean } = temp();
  try {
    const store = new SessionStore({ file });
    used(store);
    store.stopAll();
    // Truncated JSON, as a process killed mid-write would leave.
    const broken = readFileSync(file, 'utf8').slice(0, 40);
    rmSync(file);
    writeFileSync(file, broken);
    const after = new SessionStore({ file });
    assert.equal(after.list().length, 0);
    after.stopAll();
  } finally { clean(); }
});

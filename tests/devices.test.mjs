import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DeviceStore } from '../server/devices.js';

/**
 * These exist because ten pairing codes were handed over and every one of them
 * came back as "already used" by someone who had used none of them.
 *
 * Nobody had taken them. Pairing codes lived only in memory while devices were
 * written to disk, so each restart of the server silently voided every
 * unclaimed code — and because an unknown code and a spent one produced the
 * same message, the codes looked stolen rather than lost.
 */

function store(file) {
  return new DeviceStore({ path: file });
}

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'foovox-devices-'));
  return { file: path.join(dir, 'devices.json'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a pairing code survives a restart', () => {
  const { file, clean } = tempFile();
  try {
    const first = store(file);
    const { code } = first.createPairing({ principalId: 'redfoo', label: 'phone' });

    // The restart. Everything in memory is gone; only the file carries over.
    const second = store(file);
    const device = second.redeemPairing(code, { source: 'test' });
    assert.equal(device.principalId, 'redfoo');
  } finally { clean(); }
});

test('ten codes all survive, and each still works exactly once', () => {
  const { file, clean } = tempFile();
  try {
    const first = store(file);
    const codes = Array.from({ length: 10 }, (_, i) =>
      first.createPairing({ principalId: 'redfoo', label: `phone-${i + 1}` }).code);

    const second = store(file);
    for (const code of codes) {
      assert.ok(second.redeemPairing(code, { source: 'test' }).token, 'a code was lost');
    }
    // And no code is good twice, restart or not.
    const third = store(file);
    assert.throws(() => third.redeemPairing(codes[0], { source: 'test' }), /already used/);
  } finally { clean(); }
});

test('a code that was never issued is not called "already used"', () => {
  // The misleading half of the bug. "Already used" sends someone looking for a
  // stranger on their account; it must only be said when it is true.
  const { file, clean } = tempFile();
  try {
    const s = store(file);
    assert.throws(() => s.redeemPairing('never-existed', { source: 'test' }), (err) => {
      assert.match(err.message, /not valid/);
      assert.ok(!/already used/.test(err.message), `misreported: ${err.message}`);
      return true;
    });
  } finally { clean(); }
});

test('a genuinely spent code says so, and when', () => {
  const { file, clean } = tempFile();
  try {
    const s = store(file);
    const { code } = s.createPairing({ principalId: 'redfoo' });
    s.redeemPairing(code, { source: 'test' });
    assert.throws(() => s.redeemPairing(code, { source: 'test' }), /already used on \d{4}-/);
  } finally { clean(); }
});

test('the raw code is never written to disk', () => {
  const { file, clean } = tempFile();
  try {
    const s = store(file);
    const { code } = s.createPairing({ principalId: 'redfoo' });
    const onDisk = readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes(code), 'the pairing code itself was persisted in the clear');
    assert.match(onDisk, /codeHash/, 'the hash should be what is stored');
  } finally { clean(); }
});

test('an expired code does not come back after a restart', async () => {
  const { file, clean } = tempFile();
  try {
    const first = store(file);
    const { code } = first.createPairing({ principalId: 'redfoo', ttlMs: 1 });
    // Actually let it expire. Creating and reloading inside the same
    // millisecond made this pass or fail on how fast the machine was.
    await new Promise((r) => { setTimeout(r, 20); });
    const second = store(file);
    assert.throws(() => second.redeemPairing(code, { source: 'test' }), /not valid|expired/);
  } finally { clean(); }
});

test('devices still load alongside the new fields', () => {
  // The file grew two keys. An older file without them, and a newer one with
  // them, both have to load — this is the credential store.
  const { file, clean } = tempFile();
  try {
    const first = store(file);
    const { code } = first.createPairing({ principalId: 'redfoo' });
    const paired = first.redeemPairing(code, { source: 'test' });

    const second = store(file);
    assert.ok(second.authenticate(paired.token), 'a paired device stopped authenticating');
    assert.equal(second.listFor('redfoo').length, 1);
  } finally { clean(); }
});

test('pending codes can be counted without exposing them', () => {
  const { file, clean } = tempFile();
  try {
    const s = store(file);
    s.createPairing({ principalId: 'redfoo', label: 'a' });
    s.createPairing({ principalId: 'redfoo', label: 'b' });
    s.createPairing({ principalId: 'someone-else', label: 'c' });
    const pending = s.pendingFor('redfoo');
    assert.equal(pending.length, 2);
    assert.ok(!JSON.stringify(pending).includes('codeHash'), 'do not hand back the hashes');
  } finally { clean(); }
});

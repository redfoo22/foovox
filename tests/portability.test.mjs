import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { venvPython } from '../scripts/venv-python.mjs';

/**
 * This project is written on Windows and meant to be installed on a Mac.
 *
 * That combination hides a specific kind of bug: something that works here and
 * cannot possibly work there, with nothing to notice it until someone else runs
 * the installer. Two shipped files pointed at `venv/Scripts/python.exe`, which
 * does not exist on macOS or Linux — `npm run speech` and the whole pm2 config
 * were dead on arrival, and every test passed the entire time.
 *
 * These check the files that get published, not the working tree, so local
 * scratch files and the virtualenv itself are out of scope.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that would actually be published, per git. */
function shippedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => /\.(mjs|js|cjs|json|py|sh|md)$/.test(f))
    .filter((f) => f !== 'package-lock.json');
}

const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('nothing shipped hardcodes the Windows virtualenv layout', () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    // The helper and this test are allowed to name both spellings; that is
    // their whole job.
    if (file === 'scripts/venv-python.mjs') continue;
    /*
     * This guards *runtime code*, so prose and tests are exempt.
     *
     * Documentation has to be free to describe the trap — AGENTS.md warns about
     * the `WindowsApps\python3.exe` stub by name — and a test proves the
     * resolver handles a Windows path by naming one as an input. Both are the
     * opposite of the mistake being guarded against, and flagging them would
     * teach people to silence this test rather than read it.
     */
    if (file.endsWith('.md') || file.startsWith('tests/')) continue;
    /*
     * Only *unconditional* uses count. `IS_WIN ? 'Scripts' : 'bin'` is the
     * correct way to spell this and must not be flagged, or the test cries wolf
     * and stops being read. Comments explaining the difference are fine too.
     */
    const suspect = read(file).split('\n')
      .filter((line) => /venv[\\/]Scripts|['"]Scripts['"]|python\.exe/.test(line))
      .filter((line) => !/IS_WIN|process\.platform|win \?|^\s*(\*|\/\/)/.test(line));
    if (suspect.length) offenders.push(`${file}: ${suspect[0].trim()}`);
  }
  assert.deepEqual(offenders, [],
    `these name a Windows-only python path and will fail on macOS: ${offenders.join(', ')}`);
});

test('the virtualenv path is resolved per platform', () => {
  const resolved = venvPython('/x');
  if (process.platform === 'win32') {
    assert.match(resolved, /Scripts/);
    assert.match(resolved, /python\.exe$/);
  } else {
    assert.match(resolved, /[\\/]bin[\\/]python$/);
  }
});

test('the pm2 config resolves python rather than naming it', () => {
  // pm2 reads this file directly, so a wrong path here means the speech service
  // never starts and the app is silent with no obvious cause.
  const config = read('ecosystem.config.cjs');
  assert.match(config, /process\.platform/, 'the python path must be chosen at runtime');
  assert.ok(!/'Scripts'|python\.exe/.test(config.replace(/IS_WIN \?[^\n]*/g, '')),
    'the pm2 config still names a Windows-only path unconditionally');
});

test('no developer home directory escapes into a shipped file', () => {
  /*
   * Checked against *this* machine's username rather than a generic pattern.
   * "/home/user/thing" in a fixture is fine and readable; the actual person's
   * account name is both broken for everyone else and a small privacy leak,
   * and it is the one that gets pasted in by accident.
   */
  const me = os.userInfo().username;
  const offenders = [];
  for (const file of shippedFiles()) {
    if (file === 'tests/portability.test.mjs') continue;
    const text = read(file);
    if (new RegExp(`\\b${me}\\b`, 'i').test(text) || /[A-Z]:\\Users\\/.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `this machine's account name or a Windows user path is in: ${offenders.join(', ')}`);
});

test('no credential or private hostname is in a shipped file', () => {
  // data/ is gitignored, but a token pasted into a script or a doc would not be.
  const offenders = [];
  for (const file of shippedFiles()) {
    if (file === 'tests/portability.test.mjs') continue;
    const text = read(file);
    // A real tailnet host, not the generic "*.ts.net" the docs have to mention.
    if (/[\w-]+\.tail[0-9a-z]+\.ts\.net/i.test(text) || /\b[0-9a-f]{40,}\b/.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `a real tailnet hostname or long hex secret is in: ${offenders.join(', ')}`);
});

test('the PowerShell installer never passes a quoted script to node', () => {
  /*
   * PowerShell strips inner double quotes before a native command sees them.
   * `node -p 'process.versions.node.split(".")[0]'` therefore reached node as
   * `split(.)`, threw, and cast to 0 — so the installer told every Windows
   * machine "Node 0 is too old" and refused to run. The identical line in
   * install.sh is correct, because bash keeps the quotes, which is why it
   * survived review.
   *
   * The rule is simply: do not ask node to evaluate a string here. Read
   * `node --version` and parse it in PowerShell, where the quoting is ours.
   */
  const ps = read('install.ps1');
  const evals = ps.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /\bnode\s+-(p|e|-eval|-print)\b/.test(l));
  assert.deepEqual(evals, [],
    `install.ps1 evaluates JS through the shell, which mangles quotes: ${evals.join(' | ')}`);
  assert.match(ps, /node --version/, 'it should read the version directly');
});

test('the shell installer is stored with unix line endings', () => {
  /*
   * `install.sh` is the first thing anyone runs, and a CRLF copy fails on macOS
   * with `bad interpreter: /usr/bin/env bash^M` — an error that names neither
   * the cause nor the file, and which cannot occur on the Windows machine that
   * produced it.
   *
   * Asked of git rather than of the file: the working copy is legitimately CRLF
   * here, and it is the *index* that gets cloned. Reading the bytes off disk,
   * or through a shell that rewrites newlines, answers a different question.
   */
  const eol = execFileSync('git', ['ls-files', '--eol', 'install.sh'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.match(eol, /^i\/lf/, `install.sh is not LF in the index: ${eol.trim()}`);
});

test('the installer names a repository that is actually configured', () => {
  // The install line is the first thing anyone runs. A placeholder here sends
  // them to a 404 before they ever see the app.
  const sh = read('install.sh');
  const placeholder = /USER\/foovox|YOUR_?USER|example\.com|<your/i;
  assert.ok(!placeholder.test(sh),
    'install.sh still contains a placeholder repository URL');
});

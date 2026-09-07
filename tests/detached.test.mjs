import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * The pid recorded for a background service has to be the service.
 *
 * `foovox start` spawned with `shell: true` on Windows, so `child.pid` was the
 * pid of the cmd.exe wrapper rather than of node or python. That wrapper is
 * gone in under a second, so pids.json held a dead pid while the service kept
 * running: `foovox stop` found nothing alive, killed nothing, printed nothing,
 * and exited 0. The services could only be stopped by hunting them down by
 * command line, and the next `start` failed on a port already in use.
 *
 * This is the Windows failure, but the assertion is meaningful everywhere: the
 * pid you keep must still be alive, and must be the process you started.
 */

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const IS_WIN = process.platform === 'win32';
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Mirrors the rule in bin/foovox.mjs: a real path never needs a shell. */
const needsShell = (cmd) => IS_WIN && !path.isAbsolute(cmd) && !cmd.includes(path.sep);

function startLike(cmd, args, useShell) {
  return spawn(cmd, args, {
    detached: !IS_WIN, stdio: 'ignore', shell: useShell, windowsHide: true,
  });
}

test('a detached child is still alive under the pid we recorded', async () => {
  // node's own path is absolute, exactly like venvPython() and process.execPath
  // at the real call sites.
  const child = startLike(process.execPath, ['-e', 'setTimeout(()=>{},5000)'],
    needsShell(process.execPath));
  const pid = child.pid;
  child.unref();
  await wait(1200); // long enough for a shell wrapper to have handed off and gone

  assert.ok(alive(pid), `pid ${pid} was dead 1.2s after start — stop would find nothing to kill`);
  try { process.kill(pid); } catch { /* already gone */ }
});

test('the shell rule never wraps an absolute path', () => {
  assert.equal(needsShell(process.execPath), false,
    'an absolute path must be spawned directly, or its pid is the shell wrapper');
  assert.equal(needsShell(path.join('C:', 'x', 'venv', 'Scripts', 'python.exe')), false);
  assert.equal(needsShell(path.join('/usr', 'bin', 'python3')), false);
});

test('killing the recorded pid actually stops it', async () => {
  const child = startLike(process.execPath, ['-e', 'setTimeout(()=>{},10000)'],
    needsShell(process.execPath));
  const pid = child.pid;
  child.unref();
  await wait(800);
  assert.ok(alive(pid), 'precondition: it should be running');

  process.kill(pid);
  await wait(600);
  assert.ok(!alive(pid), `pid ${pid} survived being killed`);
});

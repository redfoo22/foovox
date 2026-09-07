#!/usr/bin/env node
/**
 * The `foovox` command.
 *
 * Everything a person needs to run this on their own machine, without reading
 * the source. Three things it has to get right:
 *
 *   1. **Tell you what is wrong.** Most failures here are environmental —
 *      Python missing, models not downloaded, Claude not signed in, a port in
 *      use. `doctor` names the problem and the exact command that fixes it,
 *      because "it does not work" is not a debuggable report from a phone.
 *   2. **Mint pairing codes.** They live only in the server's memory, so they
 *      can only come from the running server. This is the front door.
 *   3. **Choose how the phone reaches it.** Tailscale, a Cloudflare tunnel, or
 *      plain localhost, with the security difference stated rather than
 *      implied.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data');
const IS_WIN = process.platform === 'win32';

const PORT = Number(process.env.FOOVOX_PORT ?? 3210);
const SPEECH_PORT = Number(process.env.FOOVOX_SPEECH_PORT ?? 3211);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- output

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' }
  : { dim: '', b: '', g: '', y: '', r: '', c: '', x: '' };

const say = (s = '') => console.log(s);
const ok = (s) => say(`  ${C.g}✓${C.x} ${s}`);
const bad = (s) => say(`  ${C.r}✗${C.x} ${s}`);
const warn = (s) => say(`  ${C.y}!${C.x} ${s}`);
const info = (s) => say(`  ${C.dim}${s}${C.x}`);
const head = (s) => say(`\n${C.b}${s}${C.x}`);

// ---------------------------------------------------------------- helpers

const venvPython = () => path.join(ROOT, 'venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');

/*
 * `shell: true` only when we actually need PATH resolution.
 *
 * On Windows a shell re-splits the argument array on spaces, so
 * `['-p', 'Reply with the single word: ok']` arrives as six arguments and the
 * prompt is lost. That made the sign-in check report "not signed in" on a
 * machine that was signed in and working — a false alarm in the one tool whose
 * job is telling people what is wrong.
 */
function run(cmd, args, opts = {}) {
  const needsShell = IS_WIN && !path.isAbsolute(cmd) && !cmd.includes(path.sep);
  return spawnSync(cmd, args, { encoding: 'utf8', shell: needsShell, ...opts });
}

function which(cmd) {
  const r = run(IS_WIN ? 'where' : 'which', [cmd]);
  if (r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).find(Boolean) ?? null;
}

/**
 * A Python that is genuinely there, not merely on PATH.
 *
 * Windows ships stub executables at `WindowsApps\python3.exe` that exist, are
 * found by `where`, and do nothing but print "Python was not found; run without
 * arguments to install from the Microsoft Store" and fail. Picking an
 * interpreter by existence alone therefore chose the stub on a machine with
 * Python 3.11 installed, and the install died at "could not create the python
 * environment" with the real cause buried above it.
 *
 * So each candidate is *run*, and has to report a version we can use. `py -3`
 * comes first on Windows because the launcher is the one thing that reliably
 * resolves to a real install; `python3` comes last there for the same reason it
 * comes first everywhere else.
 */
function findPython() {
  const candidates = IS_WIN
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

  for (const [cmd, prefix] of candidates) {
    if (!which(cmd)) continue;
    const r = run(cmd, [...prefix, '--version']);
    if (r.status !== 0) continue;
    const version = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(); // 3.4 prints to stderr
    const m = version.match(/Python (\d+)\.(\d+)/);
    if (!m) continue;
    const [major, minor] = [Number(m[1]), Number(m[2])];
    if (major < 3 || (major === 3 && minor < 10)) continue;
    return { cmd, prefix, version: `${major}.${minor}` };
  }
  return null;
}

/** Tailscale ships as a GUI app on Windows and macOS; the binary is not always on PATH. */
function tailscaleBin() {
  const onPath = which('tailscale');
  if (onPath) return onPath;
  for (const candidate of [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    // The Mac App Store build ships the CLI inside the app bundle and does
    // not put it on PATH, which is how most Mac users have Tailscale.
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]) if (existsSync(candidate)) return candidate;
  return null;
}

function adminToken() {
  const file = path.join(DATA, 'admin-token.txt');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim();
}

async function api(pathname, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const token = adminToken();
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

async function serverUp() {
  try {
    await api('/health', { timeout: 2500 });
    return true;
  } catch { return false; }
}

async function speechUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${SPEECH_PORT}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch { return false; }
}

const PIDS = path.join(DATA, 'pids.json');
const readPids = () => { try { return JSON.parse(readFileSync(PIDS, 'utf8')); } catch { return {}; } };
const writePids = (p) => writeFileSync(PIDS, JSON.stringify(p, null, 2));

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid) {
  if (!alive(pid)) return;
  try {
    if (IS_WIN) run('taskkill', ['/PID', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

/** Start a long-lived process detached, so the CLI can exit without killing it. */
function startDetached(name, cmd, args, env = {}) {
  mkdirSync(DATA, { recursive: true });
  /*
   * No shell when the command is a real path, which on Windows is the
   * difference between being able to stop these services and not.
   *
   * `shell: true` runs the program under cmd.exe, and `child.pid` is then the
   * pid of *cmd.exe*, not of node or python. That wrapper exits as soon as it
   * has handed off, so the pid written to pids.json is dead within a second
   * while the service itself keeps running. `foovox stop` looked up the pid,
   * found it not alive, killed nothing, printed nothing, and exited 0 — and
   * the only way to stop the services was to find them by command line.
   *
   * All three call sites pass an absolute path already, so the shell was never
   * doing anything except losing the process.
   */
  const needsShell = IS_WIN && !path.isAbsolute(cmd) && !cmd.includes(path.sep);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: !IS_WIN,
    stdio: 'ignore',
    shell: needsShell,
    windowsHide: true,
  });
  child.unref();
  const pids = readPids();
  pids[name] = child.pid;
  writePids(pids);
  return child.pid;
}

const waitFor = async (check, seconds) => {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

// ---------------------------------------------------------------- doctor

const CHECKS = [
  {
    name: 'Node 20 or newer',
    check: () => {
      const major = Number(process.versions.node.split('.')[0]);
      return major >= 20 ? `v${process.versions.node}` : false;
    },
    fix: 'Install Node 20+ from https://nodejs.org',
  },
  {
    name: 'Claude Code CLI',
    check: () => {
      const bin = process.env.FOOVOX_CLAUDE
        ?? which('claude')
        ?? [path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude')].find(existsSync);
      if (!bin) return false;
      const r = run(bin, ['--version']);
      return r.status === 0 ? String(r.stdout).trim().split('\n')[0] : false;
    },
    fix: 'Install it from https://claude.com/claude-code, then run: claude',
  },
  {
    name: 'Claude Code is signed in',
    check: () => {
      const bin = process.env.FOOVOX_CLAUDE ?? which('claude')
        ?? path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
      // A one-word prompt is the cheapest thing that proves credentials work.
      const r = run(bin, ['-p', '--model', 'claude-haiku-4-5-20251001', 'Reply with the single word: ok'],
        { timeout: 60_000 });
      if (r.status === 0 && /ok/i.test(String(r.stdout))) return 'authenticated';
      return false;
    },
    fix: 'Run `claude` once in a terminal and complete the sign-in, then try again.',
    slow: true,
  },
  {
    // Checked separately from the virtualenv, because "no interpreter" and
    // "interpreter fine, environment not built yet" need different fixes and
    // used to be reported as the same thing.
    name: 'Python 3.10+',
    check: () => {
      const py = findPython();
      return py ? `${py.version} (${py.cmd})` : false;
    },
    fix: IS_WIN
      ? 'Install from python.org. If `python3` opens the Microsoft Store, turn the '
        + 'alias off in Settings > Apps > Advanced app settings > App execution aliases.'
      : 'Install Python 3.10+ from python.org, or: brew install python',
  },
  {
    name: 'Python virtual environment',
    check: () => (existsSync(venvPython()) ? venvPython() : false),
    fix: 'Run: foovox install',
  },
  {
    name: 'Speech models downloaded',
    check: () => {
      const model = path.join(ROOT, 'models', 'kokoro-v1.0.onnx');
      const voices = path.join(ROOT, 'models', 'voices-v1.0.bin');
      return existsSync(model) && existsSync(voices) ? 'kokoro + voices present' : false;
    },
    fix: 'Run: foovox install',
  },
  {
    name: 'ffmpeg',
    check: () => (which('ffmpeg') ? 'found' : false),
    fix: IS_WIN
      ? 'Install with: winget install Gyan.FFmpeg'
      : 'Install with: brew install ffmpeg   (or apt install ffmpeg)',
    // Audio is sent as mp3; without an encoder every reply is 16x larger and
    // arrives slower than it can be spoken.
    hard: true,
  },
];

async function doctor({ quiet = false } = {}) {
  if (!quiet) head('Checking your machine');
  let failures = 0;
  for (const item of CHECKS) {
    if (item.slow && !quiet) info(`checking ${item.name.toLowerCase()}…`);
    let result;
    try { result = item.check(); } catch { result = false; }
    if (result) ok(`${item.name} ${C.dim}${typeof result === 'string' ? result : ''}${C.x}`);
    else { bad(`${item.name} — ${item.fix}`); failures += 1; }
  }

  if (!quiet) {
    head('Services');
    (await serverUp()) ? ok(`server on ${PORT}`) : warn(`server not running on ${PORT} — run: foovox start`);
    (await speechUp()) ? ok(`speech on ${SPEECH_PORT}`) : warn(`speech not running on ${SPEECH_PORT} — run: foovox start`);
  }
  return failures;
}

// ---------------------------------------------------------------- install

const MODELS = [
  ['kokoro-v1.0.onnx', 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'],
  ['voices-v1.0.bin', 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'],
];

async function install() {
  head('Installing Foovox');

  // 1. Node dependencies
  info('installing node packages…');
  const npm = run(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: ROOT, stdio: 'inherit' });
  if (npm.status !== 0) { bad('npm install failed'); return 1; }
  ok('node packages');

  // 2. Python environment. Speech runs on CPU on purpose — see README.
  if (!existsSync(venvPython())) {
    info('creating python environment…');
    const py = findPython();
    if (!py) {
      bad('No working Python 3.10+ found. Install it from https://python.org');
      if (IS_WIN) {
        info('If `python3` opens the Microsoft Store, turn off the alias in');
        info('Settings > Apps > Advanced app settings > App execution aliases.');
      }
      return 1;
    }
    info(`using Python ${py.version} (${py.cmd})`);
    const venv = run(py.cmd, [...py.prefix, '-m', 'venv', path.join(ROOT, 'venv')], { stdio: 'inherit' });
    if (venv.status !== 0) { bad('could not create the python environment'); return 1; }
  }
  ok('python environment');

  info('installing speech packages (this takes a few minutes)…');
  const pip = run(venvPython(), ['-m', 'pip', 'install', '-q', '--upgrade',
    'kokoro-onnx', 'faster-whisper', 'soundfile', 'numpy'], { stdio: 'inherit' });
  if (pip.status !== 0) { bad('installing speech packages failed'); return 1; }
  ok('speech packages');

  // 3. Models
  mkdirSync(path.join(ROOT, 'models'), { recursive: true });
  for (const [file, url] of MODELS) {
    const dest = path.join(ROOT, 'models', file);
    if (existsSync(dest)) { ok(`${file} (already downloaded)`); continue; }
    info(`downloading ${file}…`);
    const res = await fetch(url);
    if (!res.ok) { bad(`could not download ${file}: HTTP ${res.status}`); return 1; }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    ok(file);
  }

  head('Installed');
  info('Next: foovox setup');
  return 0;
}

// ---------------------------------------------------------------- services

async function start() {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(path.join(DATA, 'work'), { recursive: true });

  if (!(await speechUp())) {
    info('starting speech service…');
    startDetached('speech', venvPython(), [path.join(ROOT, 'speech_service.py')], {
      PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
      FOOVOX_SPEECH_PORT: String(SPEECH_PORT),
    });
    if (!(await waitFor(speechUp, 90))) { bad('speech service did not come up — run: foovox doctor'); return 1; }
  }
  ok(`speech on ${SPEECH_PORT}`);

  if (!(await serverUp())) {
    info('starting server…');
    startDetached('server', process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
      FOOVOX_PORT: String(PORT),
      FOOVOX_SPEECH: `http://127.0.0.1:${SPEECH_PORT}`,
      FOOVOX_WORK_DIR: process.env.FOOVOX_WORK_DIR ?? path.join(DATA, 'work'),
    });
    if (!(await waitFor(serverUp, 30))) { bad('server did not come up — run: foovox doctor'); return 1; }
  }
  ok(`server on ${PORT}`);
  return 0;
}

async function stop() {
  const pids = readPids();
  let stopped = 0;
  for (const [name, pid] of Object.entries(pids)) {
    if (alive(pid)) { killPid(pid); ok(`stopped ${name}`); stopped += 1; }
  }
  try { unlinkSync(PIDS); } catch { /* nothing to remove */ }

  /*
   * Say so when there was nothing to stop, and check the ports rather than
   * trusting the pid file.
   *
   * This used to print nothing at all and exit 0 whether it had stopped two
   * services or none, so a stale pid file was indistinguishable from success —
   * which is exactly how orphaned services went unnoticed until the next start
   * failed on a port already in use.
   */
  if (!stopped) info('nothing was running (no live pids recorded)');
  for (const [label, port, up] of [['server', PORT, serverUp], ['speech', SPEECH_PORT, speechUp]]) {
    if (await up()) {
      bad(`${label} is still answering on ${port} — it was not started by this command`);
      info(IS_WIN
        ? `Find it with: netstat -ano | findstr :${port}`
        : `Find it with: lsof -i :${port}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- exposure

async function serveMode(mode, { quiet = false } = {}) {
  const ts = tailscaleBin();

  if (mode === 'tailscale') {
    if (!ts) {
      bad('Tailscale is not installed. Get it from https://tailscale.com/download');
      return null;
    }
    const status = run(ts, ['status', '--json']);
    let dns = null;
    try { dns = JSON.parse(status.stdout)?.Self?.DNSName?.replace(/\.$/, ''); } catch { /* not logged in */ }
    if (!dns) { bad('Tailscale is installed but not signed in. Run: tailscale up'); return null; }

    const r = run(ts, ['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`]);
    if (r.status !== 0) {
      bad(`tailscale serve failed: ${String(r.stderr || r.stdout).trim().split('\n')[0]}`);
      info('HTTPS certificates must be enabled for your tailnet in the admin console.');
      return null;
    }
    const url = `https://${dns}`;
    if (!quiet) {
      ok(`serving on ${C.c}${url}${C.x}`);
      info('Reachable only from devices signed into your tailnet. Nothing is public.');
    }
    return url;
  }

  if (mode === 'cloudflare') {
    const cf = which('cloudflared');
    if (!cf) { bad('cloudflared not found. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'); return null; }
    info('starting a Cloudflare quick tunnel…');
    const logFile = path.join(DATA, 'tunnel.log');
    writeFileSync(logFile, '');
    startDetached('tunnel', cf, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`,
      '--logfile', logFile]);
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (found) {
        writeFileSync(path.join(DATA, 'tunnel-url.txt'), found[0]);
        if (!quiet) {
          ok(`serving on ${C.c}${found[0]}${C.x}`);
          warn('This URL is public. Anyone who has it reaches your sign-in page.');
          info('The pairing code is the only lock. Prefer Tailscale if you can.');
        }
        return found[0];
      }
    }
    bad('the tunnel did not produce a URL');
    return null;
  }

  if (mode === 'local') {
    const url = `http://localhost:${PORT}`;
    if (!quiet) {
      ok(`serving on ${C.c}${url}${C.x}`);
      warn('Microphones need a secure context: this works on this machine only.');
      info('A phone on your LAN cannot use the mic over plain http. Use tailscale.');
    }
    return url;
  }

  if (mode === 'off') {
    if (ts) run(ts, ['serve', '--https=443', 'off']);
    const pids = readPids();
    if (pids.tunnel) killPid(pids.tunnel);
    ok('stopped serving publicly; still on localhost');
    return null;
  }

  bad(`unknown mode: ${mode}. Use tailscale, cloudflare, local or off.`);
  return null;
}

// ---------------------------------------------------------------- pairing

async function pair({ count = 1, label = 'phone', ttl = '7d', url = null } = {}) {
  if (!(await serverUp())) { bad('the server is not running — run: foovox start'); return 1; }
  const ms = parseTtl(ttl);
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const body = await api('/api/auth/pair', {
      method: 'POST',
      body: { label: count > 1 ? `${label}-${i + 1}` : label, ttlMs: ms },
    });
    codes.push(body);
  }

  const target = url ?? currentUrl() ?? BASE;
  head(count > 1 ? `${count} pairing codes` : 'Pairing code');
  for (const c of codes) {
    say(`  ${C.b}${c.code}${C.x}`);
    say(`  ${C.dim}${target}/login?code=${encodeURIComponent(c.code)}${C.x}`);
    say('');
  }
  info(`Each works once. They expire ${new Date(codes[0].expiresAt).toLocaleString()}.`);
  if (count > 1) info('Keep the spares somewhere safe — each one is a key to this machine.');
  return 0;
}

function parseTtl(s) {
  const m = /^(\d+)\s*([smhd])?$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] ?? 'm'];
}

function currentUrl() {
  const ts = tailscaleBin();
  if (ts) {
    const r = run(ts, ['serve', 'status']);
    const m = /https:\/\/[^\s]+/.exec(String(r.stdout || ''));
    if (m) return m[0];
  }
  const f = path.join(DATA, 'tunnel-url.txt');
  if (existsSync(f)) {
    const u = readFileSync(f, 'utf8').trim();
    if (u) return u;
  }
  return null;
}

// ---------------------------------------------------------------- setup

async function setup(args) {
  head('Foovox setup');
  say(`  ${C.dim}Talk to Claude Code out loud, from your phone.${C.x}`);

  const failures = await doctor({ quiet: true });
  if (failures) {
    head('Fix these first');
    info('Run `foovox install` if you have not yet, then `foovox doctor`.');
    return 1;
  }

  if (await start()) return 1;

  // Tailscale unless told otherwise: it is the only option with no public
  // surface, and it provides the HTTPS a microphone requires.
  let mode = argOf(args, 'serve');
  if (!mode) mode = tailscaleBin() ? 'tailscale' : 'cloudflare';
  head(`Exposing over ${mode}`);
  const url = await serveMode(mode);
  if (!url) return 1;

  await pair({ count: Number(argOf(args, 'codes') ?? 3), url, ttl: argOf(args, 'ttl') ?? '7d' });

  head('Open the link on your phone');
  info('Then Share → Add to Home Screen to install it as an app.');
  info('Permissions start at Chat — nothing can be read, written or run.');
  info('Raise them per session in the menu when you want more.');
  return 0;
}

// ---------------------------------------------------------------- status

async function status() {
  head('Foovox');
  const up = await serverUp();
  up ? ok(`server on ${PORT}`) : bad(`server not running`);
  (await speechUp()) ? ok(`speech on ${SPEECH_PORT}`) : bad('speech not running');

  const url = currentUrl();
  if (url) ok(`reachable at ${C.c}${url}${C.x}`);
  else warn('not exposed — run: foovox serve tailscale');

  if (up) {
    try {
      const health = await api('/health');
      if (health.speech) info(`speech: ${health.speech.stt} on ${health.speech.device}`);
      info(`sessions: ${health.sessions ?? 0}`);
    } catch { /* health is optional detail */ }
  }
  return 0;
}

// ---------------------------------------------------------------- dispatch

const argOf = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const HELP = `
${C.b}foovox${C.x} — talk to Claude Code out loud, from your phone

  ${C.b}foovox install${C.x}              install dependencies and download speech models
  ${C.b}foovox setup${C.x}                first run: check, start, expose, print pairing codes
  ${C.b}foovox start${C.x} | ${C.b}stop${C.x}         run or stop the local services
  ${C.b}foovox status${C.x}               what is running and where it is reachable
  ${C.b}foovox doctor${C.x}               check the machine and say what is missing
  ${C.b}foovox pair${C.x} [--count 10]    mint pairing codes  ${C.dim}[--ttl 7d] [--label phone]${C.x}
  ${C.b}foovox serve${C.x} <mode>         tailscale | cloudflare | local | off

${C.dim}Tailscale is recommended: your phone reaches the machine over your own
private network, there is no public URL, and it supplies the HTTPS that
browsers require before they will hand over a microphone.${C.x}
`;

const [, , command, ...rest] = process.argv;

const run_ = async () => {
  switch (command) {
    case 'install': return install();
    case 'setup': return setup(rest);
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': await stop(); return start();
    case 'status': return status();
    case 'doctor': return doctor();
    case 'pair': return pair({
      count: Number(argOf(rest, 'count') ?? 1),
      label: argOf(rest, 'label') ?? 'phone',
      ttl: argOf(rest, 'ttl') ?? '7d',
    });
    case 'serve': {
      const mode = rest.find((a) => !a.startsWith('--'));
      if (!mode) { bad('which mode? tailscale, cloudflare, local or off'); return 1; }
      return (await serveMode(mode)) === null && mode !== 'off' ? 1 : 0;
    }
    default:
      say(HELP);
      return command ? 1 : 0;
  }
};

run_().then((code) => process.exit(code ?? 0)).catch((err) => {
  bad(err.message);
  process.exit(1);
});

/*
 * pm2 process definitions.
 *
 * Both services were ad-hoc background processes until a dispatch with a
 * missing working directory crashed the server and took the phone's connection
 * with it. The crash is fixed, but "one unhandled event ends the session" is a
 * class of bug, not a single one — so the supervisor is the actual answer, and
 * it also means these survive a reboot.
 *
 * The speech service is listed first and both bind 127.0.0.1 only; cloudflared
 * is the sole public surface. See ~/ports.md.
 */

const path = require('path');

const ROOT = __dirname;

// Python's virtualenv layout differs by platform, and this pointed only at
// the Windows one - so pm2 could never start the speech service on a Mac.
const IS_WIN = process.platform === 'win32';
const PYTHON = path.join(ROOT, 'venv', IS_WIN ? 'Scripts' : 'bin',
  IS_WIN ? 'python.exe' : 'python');

module.exports = {
  apps: [
    {
      name: 'foovox-speech',
      cwd: ROOT,
      script: PYTHON,
      args: 'speech_service.py',
      interpreter: 'none',
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        FOOVOX_SPEECH_PORT: '3211',
      },
      // Two models are loaded at startup; restarting in a tight loop would
      // thrash the CPU rather than recover.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      out_file: path.join(ROOT, 'data', 'pm2-speech.out'),
      error_file: path.join(ROOT, 'data', 'pm2-speech.err'),
    },
    {
      name: 'foovox',
      cwd: ROOT,
      script: path.join(ROOT, 'server', 'index.mjs'),
      env: {
        FOOVOX_PORT: '3210',
        FOOVOX_SPEECH: 'http://127.0.0.1:3211',
        // Where dispatched jobs run. Deliberately its own directory rather
        // than the repo: a job with tools armed should not be one path
        // traversal away from this project's own source.
        FOOVOX_WORK_DIR: path.join(ROOT, 'data', 'work'),
      },
      min_uptime: '10s',
      max_restarts: 20,
      restart_delay: 2000,
      out_file: path.join(ROOT, 'data', 'pm2-server.out'),
      error_file: path.join(ROOT, 'data', 'pm2-server.err'),
    },
  ],
};

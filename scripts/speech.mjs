#!/usr/bin/env node
/**
 * Run the speech service in the foreground.
 *
 * This exists so `npm run speech` is not spelled differently on every OS.
 * Python puts its virtualenv executables in `venv/Scripts` on Windows and
 * `venv/bin` everywhere else, and the script used to hardcode the Windows one —
 * which meant the command simply did not exist on a Mac.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { venvPython } from './venv-python.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

spawn(venvPython(ROOT), [path.join(ROOT, 'speech_service.py')], { stdio: 'inherit' })
  .on('exit', (code) => process.exit(code ?? 0));

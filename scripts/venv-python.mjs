import path from 'node:path';

/**
 * Where Python put the interpreter for this project's virtualenv.
 *
 * `venv/Scripts/python.exe` on Windows, `venv/bin/python` everywhere else.
 * One line, but it was written out by hand in three places and two of them
 * only had the Windows spelling — so `npm run speech` and the pm2 config both
 * pointed at a file that does not exist on macOS or Linux. Worth having in
 * exactly one place.
 */
export function venvPython(root) {
  const win = process.platform === 'win32';
  return path.join(root, 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
}

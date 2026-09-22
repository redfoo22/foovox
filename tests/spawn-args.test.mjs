import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * A long argument must reach the program as one argument.
 *
 * The voice system prompt is several hundred words passed as a single value to
 * `--append-system-prompt`. It was spawned with `shell: true`, so on Windows
 * cmd.exe re-split it on spaces: the flag received the word "You" and the rest
 * of the instruction arrived as a few hundred stray arguments. The prompt had
 * therefore never been applied at all, which is why replies stayed long and
 * full of markdown no matter what it said.
 *
 * This is the second time a shell has eaten an argument in this project — the
 * CLI's `-p` lost its prompt the same way — so it is worth a test rather than
 * another comment.
 */

const IS_WIN = process.platform === 'win32';

/** Print argv, so we can count what actually arrived. */
const ECHO = [
  '-e',
  'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
];

const LONG_PROMPT = [
  'You are a voice assistant. Everything you write is read aloud to someone',
  'holding a phone, and they cannot see it. Write the way a person speaks.',
  'No headings, no bullet points, no tables — those are punctuation to a',
  'synthesiser, not emphasis.',
].join(' ');

function argvWhenSpawned(useShell) {
  // The `--` matters: without it node claims `--prompt` as one of its own
  // options and exits 9 before the script ever runs.
  const r = spawnSync(process.execPath, [...ECHO, '--', '--prompt', LONG_PROMPT], {
    encoding: 'utf8', shell: useShell,
  });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

test('a multi-word argument survives as one argument', () => {
  const argv = argvWhenSpawned(false);
  assert.ok(argv, 'the child produced no parseable argv');
  const at = argv.indexOf('--prompt');
  assert.ok(at >= 0, '--prompt did not arrive');
  assert.equal(argv[at + 1], LONG_PROMPT,
    'the prompt was split; the flag received only its first word');
  assert.equal(argv.length, at + 2, `${argv.length - at - 2} stray arguments followed`);
});

test('the shell is what breaks it, on Windows', { skip: !IS_WIN }, () => {
  // Documents the actual failure, so the reason for `shell: false` is not
  // mistaken for cargo cult and quietly reverted.
  const argv = argvWhenSpawned(true);
  assert.ok(argv, 'the child produced no parseable argv');
  const at = argv.indexOf('--prompt');
  assert.notEqual(argv[at + 1], LONG_PROMPT,
    'if this ever passes, cmd.exe stopped re-splitting and the note can go');
  assert.equal(argv[at + 1], 'You', 'it arrives as just the first word');
});

test('sessions.js does not spawn the CLI through a shell', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(path.join(root, 'server', 'sessions.js'), 'utf8');

  const spawnCall = src.slice(src.indexOf('spawn(CLAUDE'), src.indexOf('spawn(CLAUDE') + 260);
  assert.ok(!/shell:\s*true/.test(spawnCall),
    'spawn(CLAUDE) uses a shell again — the system prompt will be split on spaces');
});

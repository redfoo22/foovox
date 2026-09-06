import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tierArgs } from '../server/permissions.mjs';

/**
 * Prove each tier does exactly what it claims, against the real CLI.
 *
 * The config has now lied twice. `full` passed `acceptEdits`, which only
 * auto-approves file edits, so a user who deliberately chose Full was told
 * "I don't have permission to use WebSearch". `read` had no mode at all and
 * could not search either. Both looked correct in the source and both were
 * wrong in practice, which is exactly the class of bug a unit test on the
 * argument list cannot catch — the arguments were the thing that was wrong.
 *
 * So this runs Claude for real, once per tier per capability, and checks what
 * actually happened rather than what was requested.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = process.env.FOOVOX_CLAUDE
  ?? path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const WORK = path.join(ROOT, 'data', 'tier-check');

const MODEL = 'claude-sonnet-5';

/**
 * Which tools actually ran.
 *
 * Reading the prose was useless: asked to search the web, the model answers
 * "Tailscale is a WireGuard-based mesh VPN" from its own knowledge and the
 * test scored it as a successful search. Asked to run a command, it replies
 * "Output: alive" having run nothing. Both scored as capability leaks that
 * were not there.
 *
 * The stream reports every `tool_use` by name, so that is what gets checked —
 * whether a tool was invoked, not whether the answer sounds like it was.
 */
function toolsUsed(tier, prompt) {
  const r = spawnSync(CLAUDE,
    ['-p', ...tierArgs(tier), '--model', MODEL, '--output-format', 'stream-json', '--verbose', prompt],
    { cwd: WORK, encoding: 'utf8', timeout: 120_000, shell: false });
  const used = new Set();
  for (const line of String(r.stdout ?? '').split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const blocks = msg?.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) if (b?.type === 'tool_use' && b.name) used.add(b.name);
    }
    const block = msg?.event?.content_block ?? msg?.content_block;
    if (block?.type === 'tool_use' && block.name) used.add(block.name);
  }
  return used;
}

const CASES = [
  {
    capability: 'read a file',
    prompt: 'Read the file probe.txt in this directory and print its contents.',
    tools: ['Read', 'Glob', 'Grep'],
    expect: { chat: false, read: true, build: true, full: true },
  },
  {
    capability: 'search the web',
    prompt: 'Use web search to find the current version number of Tailscale. You must search.',
    tools: ['WebSearch', 'WebFetch'],
    expect: { chat: false, read: true, build: true, full: true },
  },
  {
    capability: 'write a file',
    prompt: 'Create a file called written.txt in this directory containing the word done.',
    tools: ['Write', 'Edit', 'NotebookEdit'],
    expect: { chat: false, read: false, build: true, full: true },
    reset: () => rmSync(path.join(WORK, 'written.txt'), { force: true }),
  },
  {
    // Every shell, not just Bash. Naming only Bash is how `chat` kept
    // PowerShell and could run commands while documented as unable to.
    capability: 'run a command',
    prompt: 'Run a shell command that prints the word alive, and tell me its real output.',
    tools: ['Bash', 'PowerShell', 'Task', 'Agent', 'Skill', 'Workflow'],
    expect: { chat: false, read: false, build: false, full: true },
  },
];

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const { writeFileSync } = await import('node:fs');
writeFileSync(path.join(WORK, 'probe.txt'), 'hello world test file\n');

let failures = 0;
console.log('\nVerifying every tier against the real CLI. This takes a few minutes.\n');
console.log('  capability          chat    read    build   full');
console.log('  ' + '-'.repeat(48));

for (const c of CASES) {
  const row = [];
  for (const tier of ['chat', 'read', 'build', 'full']) {
    c.reset?.();
    const used = toolsUsed(tier, c.prompt);
    const got = c.tools.some((t) => used.has(t));
    const want = c.expect[tier];
    const good = got === want;
    if (!good) failures += 1;
    row.push(`${got ? 'yes' : 'no '}${good ? '   ' : ' !! '}`);
  }
  console.log(`  ${c.capability.padEnd(20)}${row.join(' ')}`);
}

console.log('  ' + '-'.repeat(48));
console.log(`  expected:           chat: nothing, read: look only,`);
console.log(`                      build: +write, full: +commands\n`);

if (failures) {
  console.log(`  ${failures} tier(s) did not behave as documented — marked !!\n`);
  process.exit(1);
}
console.log('  Every tier does exactly what it claims.\n');
rmSync(WORK, { recursive: true, force: true });

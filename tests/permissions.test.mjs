import assert from 'node:assert/strict';
import test from 'node:test';

import { TIERS, tierArgs, tierAllows, normaliseTier, DEFAULT_TIER, setRuntimeTools } from '../server/permissions.mjs';

/**
 * The tiers decide what a stranger gets if a pairing code leaks, so the tests
 * that matter are the ones asserting a tier cannot do more than it claims.
 */

const argsOf = (tier) => tierArgs(tier).join(' ');

/** The tools a tier hands to --disallowed-tools, as a set. */
const deniedBy = (tier) => {
  const args = tierArgs(tier);
  const at = args.indexOf('--disallowed-tools');
  return new Set(at < 0 ? [] : args[at + 1].split(','));
};

/** The tools a tier hands to --allowed-tools, as a set. */
const allowedBy = (tier) => {
  const args = tierArgs(tier);
  const at = args.indexOf('--allowed-tools');
  return new Set(at < 0 ? [] : args[at + 1].split(','));
};

test('the default grants nothing — including every shell', () => {
  assert.equal(DEFAULT_TIER, 'chat');
  const denied = deniedBy('chat');
  // PowerShell is the one that mattered: denying only `Bash` left chat with a
  // working shell on a machine documented as having none.
  for (const tool of ['Bash', 'PowerShell', 'Task', 'Agent', 'Skill', 'Workflow',
    'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
    assert.ok(denied.has(tool), `chat must deny ${tool}`);
  }
  assert.equal(allowedBy('chat').size, 0, 'chat allows nothing');
  assert.ok(!argsOf('chat').includes('permission-mode'), 'chat needs no mode');
});

test('read can look but never change', () => {
  const allowed = allowedBy('read');
  const denied = deniedBy('read');
  for (const tool of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']) {
    assert.ok(allowed.has(tool), `read must allow ${tool}`);
    assert.ok(!denied.has(tool), `read must not also deny ${tool}`);
  }
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task']) {
    assert.ok(denied.has(tool), `read must deny ${tool}`);
  }
  assert.ok(!argsOf('read').includes('acceptEdits'), 'read must not auto-accept edits');
});

test('build can write but not run commands, in any shell', () => {
  const denied = deniedBy('build');
  for (const tool of ['Bash', 'PowerShell', 'Task', 'Agent', 'Skill', 'Workflow']) {
    assert.ok(denied.has(tool), `build must deny ${tool}`);
  }
  assert.ok(allowedBy('build').has('Write'), 'build must allow Write');
  assert.ok(argsOf('build').includes('acceptEdits'),
    'build needs edits auto-accepted or it writes nothing');
});

test('an unknown future tool is denied by every tier except full', () => {
  // The property a deny-list cannot have. Simulate Claude Code shipping a new
  // tool and confirm it is refused rather than silently permitted.
  setRuntimeTools(['SomeBrandNewShell']);
  for (const tier of ['chat', 'read', 'build']) {
    assert.ok(deniedBy(tier).has('SomeBrandNewShell'),
      `${tier} must deny a tool it has never heard of`);
  }
  assert.equal(deniedBy('full').size, 0, 'full denies nothing, by definition');
});

test('full actually grants everything it claims to', () => {
  const args = argsOf('full');
  assert.ok(!args.includes('--disallowed-tools'), `full should deny nothing: ${args}`);
  // The bug this exists to prevent: full passed `acceptEdits`, which only
  // auto-approves file edits, so Bash and WebSearch were still denied and a
  // user who chose Full was told "I don't have permission to use WebSearch".
  assert.ok(args.includes('bypassPermissions'),
    `full must bypass permissions, not merely accept edits: ${args}`);
  assert.ok(!args.includes('acceptEdits'), 'acceptEdits is not enough for full');
  assert.equal(TIERS.full.dangerous, true, 'full must be flagged so the UI can warn');
});

test('build accepts edits but does not bypass the gate', () => {
  const args = argsOf('build');
  assert.ok(args.includes('acceptEdits'), 'build needs edits auto-approved');
  assert.ok(!args.includes('bypassPermissions'),
    'build must not bypass permissions — that is what full is for');
});

test('tiers are strictly ordered', () => {
  assert.ok(tierAllows('full', 'build'));
  assert.ok(tierAllows('build', 'read'));
  assert.ok(tierAllows('read', 'chat'));
  assert.ok(!tierAllows('chat', 'read'));
  assert.ok(!tierAllows('read', 'build'));
  assert.ok(!tierAllows('build', 'full'));
});

test('unknown or missing input falls back to the safest tier, never the loudest', () => {
  for (const bad of [undefined, null, '', 'admin', 'root', 'FULL', 0, {}]) {
    assert.equal(normaliseTier(bad), 'chat', `"${String(bad)}" must fall back to chat`);
  }
});

test('the old boolean keeps working', () => {
  assert.equal(normaliseTier(true), 'build');
  assert.equal(normaliseTier(false), 'chat');
});

test('a session with write permission is never given the server\'s own directory', async () => {
  // A voice session raised to Build had cwd null, so `spawn` inherited ours and
  // it wrote a file into this project's source tree. Every path that creates a
  // session must pass a bounded directory.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  const nulls = [...src.matchAll(/cwd:\s*[^,\n]*\?\?\s*null/g)];
  assert.equal(nulls.length, 0,
    `a session is created with a null cwd: ${nulls.map((m) => m[0]).join(', ')}`);
  assert.match(src, /const WORK_DIR/, 'there should be one place that decides the work directory');
});

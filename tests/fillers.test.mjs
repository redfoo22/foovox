import assert from 'node:assert/strict';
import test from 'node:test';

import { makeFillers, FILLER_LINES } from '../server/fillers.mjs';

test('says something relevant to the tool that started', () => {
  const f = makeFillers();
  assert.match(f.forTool('WebSearch'), /search|look.*up/i);
  f.newTurn();
  assert.match(f.forTool('Bash'), /run/i);
});

test('never repeats the previous line', () => {
  const f = makeFillers();
  const seen = [];
  for (let i = 0; i < 60; i += 1) {
    f.newTurn();
    const line = f.forTool('Read');
    assert.notEqual(line, seen[seen.length - 1], `repeated back to back at ${i}: "${line}"`);
    seen.push(line);
  }
  // And it should actually vary, not alternate between two.
  assert.ok(new Set(seen).size >= 3, `only ${new Set(seen).size} distinct lines in 60 turns`);
});

test('speaks once per turn, however many tools run', () => {
  const f = makeFillers();
  f.newTurn();
  assert.ok(f.forTool('Read'), 'the first tool should speak');
  for (const tool of ['Grep', 'Read', 'WebSearch', 'Bash']) {
    assert.equal(f.forTool(tool), null, `${tool} should stay quiet — one filler per turn`);
  }
  f.newTurn();
  assert.ok(f.forTool('Read'), 'a new turn may speak again');
});

test('an unknown tool still gets something to say', () => {
  const f = makeFillers();
  const line = f.forTool('SomeToolInventedNextYear');
  assert.ok(line && line.length > 3, `nothing said for an unknown tool: ${line}`);
});

test('every line is speakable — no markdown, no punctuation soup', () => {
  const all = [...FILLER_LINES.GENERIC, ...Object.values(FILLER_LINES.BY_TOOL).flat()];
  for (const line of all) {
    assert.ok(!/[*`_|#[\]()<>]/.test(line), `not speech-safe: "${line}"`);
    assert.match(line, /[.!?]$/, `should end like a sentence: "${line}"`);
    assert.ok(line.split(/\s+/).length <= 8, `too long to be a filler: "${line}"`);
  }
});

test('a single-line tool pool does not repeat itself', () => {
  // NotebookEdit has exactly one line; asked twice in a row it must reach for
  // the generic set rather than say the same thing again.
  const f = makeFillers();
  f.newTurn();
  const first = f.forTool('NotebookEdit');
  f.newTurn();
  const second = f.forTool('NotebookEdit');
  assert.notEqual(first, second, 'a one-line pool repeated back to back');
});

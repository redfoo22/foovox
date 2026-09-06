import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

/**
 * Phase 5 end to end: hold a conversation, dispatch it, ask for status.
 *
 * The thing being proven is not that a job runs — it is that the *right* job
 * runs. "Code it in Opus" is a pronoun; the task lives in the conversation
 * before it, so the brief has to carry that across to a process that has never
 * seen it.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL ?? 'http://127.0.0.1:3210';
// A fresh directory per run rather than deleting the last one: the previous
// job's process is still alive with that directory as its cwd, so Windows
// refuses to remove it (EBUSY). Cleaning up after a detached agent is the
// agent's business, not the test's.
const WORK = path.join(ROOT, 'data', `jobtest-${process.pid}`);
mkdirSync(WORK, { recursive: true });

const admin = readFileSync(path.join(ROOT, 'data', 'admin-token.txt'), 'utf8').trim();
const pair = await (await fetch(`${BASE}/api/auth/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
  body: JSON.stringify({ label: 'jobs-test' }),
})).json();
const auth = await (await fetch(`${BASE}/api/auth/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pair.code }),
})).json();

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, {
  headers: { Authorization: `Bearer ${auth.token}` },
});

const errors = [];
let reply = '';
let brief = null;
let spoken = [];
const waiting = [];
const expect = (pred, label, ms = 120_000) => new Promise((resolve, reject) => {
  const entry = { pred, resolve, label };
  waiting.push(entry);
  setTimeout(() => {
    if (!entry.done) { entry.done = true; reject(new Error(`timed out waiting for ${label}`)); }
  }, ms);
});
const settle = (msg) => {
  for (const w of waiting) {
    if (!w.done && w.pred(msg)) { w.done = true; w.resolve(msg); }
  }
};

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === 'text') reply += msg.delta;
  if (msg.type === 'speak') spoken.push(msg.text);
  if (msg.type === 'note') console.log(`   note: ${msg.text}`);
  if (msg.type === 'error') { errors.push(msg.message); console.log(`   ERROR: ${msg.message}`); }
  if (msg.type === 'dispatched') brief = msg;
  settle(msg);
});

const send = (o) => ws.send(JSON.stringify(o));

await new Promise((r) => ws.on('open', r));
await expect((m) => m.type === 'ready', 'ready');
send({ type: 'hello', tools: false, format: 'pcm', model: 'claude-sonnet-5' });
await expect((m) => m.type === 'session', 'session');
console.log('[1] connected, voice session on Sonnet');

// ---- establish context the dispatch will have to carry -------------------
reply = '';
send({ type: 'text', text: 'I want a tiny Node script called wordcount.mjs that reads a text file path from argv and prints the number of words. Nothing else.' });
await expect((m) => m.type === 'done', 'first reply');
console.log(`[2] discussed the task: "${reply.trim().slice(0, 80)}"`);

// ---- the actual command --------------------------------------------------
spoken = [];
send({ type: 'text', text: 'Great, code it in Opus.' });
await expect((m) => m.type === 'dispatched', 'dispatch', 180_000);
console.log(`[3] dispatched to ${brief.job.model}`);
console.log(`    title: ${brief.job.title}`);
console.log(`    brief carries the task: ${/wordcount|word count/i.test(brief.brief) ? 'YES' : 'NO — the pronoun was dispatched, not the task'}`);
if (!/wordcount|word count/i.test(brief.brief)) errors.push('brief lost the conversation context');
if (brief.job.model !== 'claude-opus-5') errors.push(`wrong model: ${brief.job.model}`);
if (!brief.job.tools) errors.push('job has no tools armed — it cannot write anything');

// ---- ask for status while it is still working ---------------------------
await new Promise((r) => setTimeout(r, 4000));
spoken = [];
send({ type: 'text', text: "how's it going" });
await expect((m) => m.type === 'status', 'status');
// Wait for the audio, not for a guess at how long synthesis takes. The first
// version slept 1500 ms and read an empty buffer while the note had already
// arrived — testing the wrong signal.
await expect((m) => m.type === 'speak', 'status audio');
const status = spoken.join(' ');
console.log(`[4] status spoken: "${status.slice(0, 160)}"`);
if (!/job/i.test(status)) errors.push('status did not mention any job');
if (!/opus/i.test(status)) errors.push('status did not name the model');

// ---- ordinary conversation must still reach Claude ----------------------
reply = '';
send({ type: 'text', text: 'While that runs — what is a semaphore, in one sentence?' });
await expect((m) => m.type === 'done', 'normal turn still works');
console.log(`[5] normal conversation still works: "${reply.trim().slice(0, 70)}"`);
if (!reply.trim()) errors.push('a normal question got swallowed by the intent router');

console.log(`\n[errors] ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
ws.close();
process.exit(errors.length ? 1 : 0);

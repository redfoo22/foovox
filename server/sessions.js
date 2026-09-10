import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { normaliseTier, tierArgs, tierAllows, setRuntimeTools } from './permissions.mjs';
import { makeSpeechFilter } from './speech-text.mjs';

/**
 * Claude Code sessions — one warm process each.
 *
 * The measurement that determined this design: spawning `claude -p` per
 * message costs **6305 ms** to first token. Holding one process open on
 * `--input-format stream-json` costs **1011 ms**. That 5.3 seconds a turn is
 * the difference between a conversation and a voicemail, so the process stays
 * alive between turns and the rail's sessions are real OS processes, not
 * records.
 *
 * They cannot stay alive forever, though — a long rail would be a dozen idle
 * Claudes holding memory. Idle sessions are reaped and resumed later by
 * `--resume <id>`, which restores the conversation without the process.
 */

const CLAUDE = process.env.FOOVOX_CLAUDE
  ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe');

/*
 * The voice session is a person talking, not a terminal printing.
 *
 * A filter downstream guarantees markdown and URLs are never spoken, but a
 * filter can only remove things. It cannot turn a wall of implementation
 * detail into the one sentence somebody actually wanted, so the instruction
 * has to do that part.
 */
const VOICE_PROMPT = [
  'You are a voice assistant. Everything you write is read aloud to someone',
  'holding a phone, and they cannot see it. Write the way a person speaks.',
  '',
  'Write in plain sentences. No headings, no bullet points, no tables, no bold',
  'or italics — those are punctuation to a synthesiser, not emphasis.',
  '',
  /*
   * Code and links are welcome on screen and never in speech.
   *
   * An earlier version of this said "no code blocks" and the model obediently
   * explained a function in prose without ever writing it down — so the
   * transcript, which is the whole point of having a screen, had nothing to
   * refer back to. The filter downstream guarantees a fenced block is never
   * spoken, so the instruction should encourage writing one.
   */
  'Do put code in a fenced code block, and do include links, when they are',
  'genuinely useful — the transcript keeps them and the person can read them',
  'later. They are never read aloud, so write the surrounding sentences so',
  'they still make sense to someone who only hears them.',
  '',
  'Stay high level. This is often a coding project, and the person wants to',
  'know what happened and what it means, not to hear source code recited.',
  'Say what you did and why in plain words. Do not narrate identifiers, exact',
  'filenames, version strings or command syntax unless they ask for them.',
  '',
  'Their words reach you through speech-to-text, so expect occasional',
  'mis-transcriptions of technical terms and infer what they meant rather than',
  'querying it.',
  // Spoken length is not written length: a paragraph that scans in two seconds
  // takes twenty to listen to, and cannot be skimmed or re-read.
  'Keep answers to roughly thirty spoken words unless asked for more. Answer',
  'the question first, then stop. Offer detail rather than delivering it.',
].join(' ');

/*
 * A work session is not a voice session wearing a hat.
 *
 * The voice prompt caps replies at about thirty spoken words and forbids code
 * blocks, which is right for a conversation and actively harmful for a build.
 * Work sessions run detached with tools armed and nobody listening in
 * realtime, so what they need instead is to report progress in a form that can
 * be summarised out loud later.
 */
const WORK_PROMPT = [
  'You are doing a piece of engineering work dispatched by voice. Nobody is',
  'watching this run in realtime; they will ask for a status summary later,',
  'possibly while you are still working.',
  'Work autonomously and finish the task. Do not ask clarifying questions you',
  'could reasonably decide yourself — state the assumption and continue.',
  'Begin your reply with a single short line saying what you are about to do,',
  'so a summary read aloud has something useful to quote. End with a short',
  'plain-sentence summary of what changed and anything left undone.',
  // Without this a job writes to an absolute path it invented, the permission
  // system correctly refuses because that is outside its directory, and the
  // run reports success having created nothing. The first dispatch did exactly
  // that: it wrote out the file contents in prose and left an empty folder.
].join(' ');

/*
 * Name the directory rather than describing it.
 *
 * Twice a dispatched job reported success and created nothing. Told only "use
 * relative paths", it resolved `scripts/wordcount.mjs` against a project root
 * it inferred from its surroundings — outside its sandbox — and the write was
 * correctly refused. It never occurred to it that its own directory was
 * somewhere else, because nothing had said so.
 *
 * The permission scope is a real absolute path, so the prompt states that
 * exact path. There is nothing left to infer.
 */
function workPrompt(cwd) {
  if (!cwd) return WORK_PROMPT;
  return [
    WORK_PROMPT,
    `Your working directory is exactly: ${cwd}`,
    'Every file you create or edit must be inside that directory. Writing',
    'anywhere else is blocked and the work is lost, so do not invent a project',
    'root, and do not place files in a subdirectory unless you create it first.',
  ].join(' ');
}

/**
 * Split a token stream into speakable chunks.
 *
 * The first chunk is the one that matters: it is the gap between the user
 * falling silent and hearing anything at all. Waiting for a complete sentence
 * cost 1768 ms on a 25-word sentence, because Kokoro had to synthesise 8.7
 * seconds of audio before the first sample existed. Capped at a natural break
 * inside 12 words it is 504 ms. Later chunks can be whole sentences — by then
 * audio is already playing and the only requirement is that the next chunk is
 * ready before the current one finishes.
 */
export function makeChunker() {
  let buf = '';
  let first = true;
  return {
    push(text) {
      buf += text;
      const out = [];
      for (;;) {
        const chunk = first ? takeFirst(buf) : takeSentence(buf);
        if (!chunk) break;
        out.push(chunk);
        buf = buf.slice(chunk.length);
        first = false;
      }
      return out;
    },
    /**
     * Whatever is left when the turn ends. Returned verbatim rather than
     * trimmed: the leading space belongs to the boundary with the previous
     * chunk, and dropping it silently made the stream lossy.
     */
    flush() {
      const rest = buf;
      buf = '';
      first = true;
      return rest.trim() ? [rest] : [];
    },
  };
}

const BREAK = /[,;:.!?]$/;

/**
 * The part of the buffer whose last word is definitely finished.
 *
 * Tokens arrive mid-word — a delta boundary lands inside "Senso-ji" as easily
 * as between words. Counting words on the raw buffer once cut a chunk at "the
 * Senso" and started the next at "-ji temple", which is not a pronunciation
 * problem, it is two wrong words spoken aloud. Everything that measures length
 * measures this instead, so a trailing partial word is never eligible.
 */
function committed(buf) {
  const at = buf.search(/\s\S*$/);
  return at < 0 ? '' : buf.slice(0, at + 1);
}

function takeFirst(buf) {
  const safe = committed(buf);
  if (!safe) return null;
  let count = 0;
  let taken = '';
  for (const part of safe.split(/(\s+)/).filter(Boolean)) {
    taken += part;
    if (/\s/.test(part)) continue;
    count += 1;
    if (count >= 6 && BREAK.test(part)) return taken;
    if (count >= 12) return taken;
  }
  return null;
}

/**
 * Later chunks: big enough to sound natural, small enough to stay ahead of
 * playback.
 *
 * Returning whole sentences produced a 13.2-second chunk that took 2315 ms to
 * synthesise, while the chunk playing in front of it was only 2.0 seconds
 * long — a third of a second of silence in the middle of a sentence. Kokoro
 * runs about 5x realtime, so a chunk needs to be shorter than five times the
 * audio queued ahead of it. Capping at 20 words keeps synthesis around 600 ms
 * for roughly 3 seconds of speech, which stays comfortably ahead.
 */
function takeSentence(buf) {
  // `\s` and not `$`: a period at the very end of the buffer may be the middle
  // of "3.5" or "Dr." with the rest still arriving.
  const m = /^[\s\S]*?[.!?](?=\s)/.exec(buf);
  if (m && m[0].trim().split(/\s+/).length <= 20) return m[0];
  const safe = committed(buf);
  if (!safe) return null;
  // Long sentence: break at the last punctuation inside the cap, else hard cap.
  let count = 0;
  let taken = '';
  let lastBreak = null;
  for (const part of safe.split(/(\s+)/).filter(Boolean)) {
    taken += part;
    if (/\s/.test(part)) continue;
    count += 1;
    if (count >= 8 && BREAK.test(part)) lastBreak = taken;
    if (count >= 20) return lastBreak ?? taken;
  }
  return null;
}


/**
 * One conversation. Emits `chunk` (speakable text), `text` (raw delta, for the
 * transcript pane), `tool` (a tool call started — the UI must fill the silence,
 * a tool turn was measured at 42 s), `done`, and `error`.
 */
class Session extends EventEmitter {
  constructor({ id, model = 'claude-sonnet-5', tools = false, tier = null, cwd = null, resume = null, kind = 'voice' }) {
    super();
    this.id = id;
    this.kind = kind;
    // `tools` was a boolean before tiers existed; normalise so old clients and
    // stored settings keep working rather than silently getting the default.
    this.tier = normaliseTier(tier ?? tools);
    this.model = model;
    this.cwd = cwd;
    this.claudeSessionId = resume;
    this.proc = null;
    this.busy = false;
    this.lastUsed = Date.now();
    this.title = null;
    /*
     * Progress kept on the session itself, not in the socket watching it.
     *
     * A work session has to survive you switching away from it — that is the
     * entire point of dispatching one. If its state lived in the listener, the
     * moment you tapped back to the voice session it would be building
     * something nobody could see or ask about.
     */
    this.status = 'idle';       // idle | working | done | error
    this.turns = 0;
    this.reply = '';            // text of the current or last reply
    /*
     * What was actually said, so a session can be returned to.
     *
     * The claude process holds the real conversation and `--resume` restores
     * it, but that is invisible: nothing here could redraw the screen. Tapping
     * a session in the rail swapped which process you were talking to and left
     * the previous one's messages on display, so every session looked like
     * whatever you had been reading last. The model remembered; the app did not.
     */
    this.history = [];          // [{ role: 'me' | 'claude', text, at }]
    this.toolLog = [];          // recent tool calls, for "what is it doing"
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.interrupts = 0;
  }

  start() {
    if (this.proc) return;
    let cwd;
    try {
      cwd = this.#workingDirectory();
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      // Asynchronously, so a listener attached right after start() still hears
      // it — and so start() keeps its promise never to throw synchronously.
      queueMicrotask(() => this.emit('error', err));
      return;
    }
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', this.model,
      '--append-system-prompt', this.kind === 'work' ? workPrompt(cwd) : VOICE_PROMPT,
    ];
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);
    // Tools are off unless the session explicitly armed them. A leaked pairing
    // code should not be shell access on a machine that also runs a live site
    // and a logged-in storefront.
    args.push(...tierArgs(this.tier));
    this.proc = spawn(CLAUDE, args, {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    /*
     * Without this the server dies. `spawn` reports failure asynchronously via
     * an `error` event, and an EventEmitter with no `error` listener rethrows
     * it as an uncaught exception. This is the difference between one job
     * failing and everything failing.
     */
    this.proc.on('error', (err) => {
      this.proc = null;
      this.busy = false;
      this.status = 'error';
      this.error = 'could not start: ' + err.message;
      this.emit('error', new Error(this.error));
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderrTail = String(d).slice(-500); });
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.busy) {
        this.busy = false;
        this.emit('error', new Error(`claude exited (${code}): ${this.stderrTail ?? ''}`));
      }
    });
    this.#acc = '';
  }

  /*
   * A working directory that does not exist makes `spawn` fail with ENOENT,
   * and an unhandled `error` event on a ChildProcess takes down the whole
   * process — which it did: one dispatch with a missing directory killed the
   * server, every other session with it, and dropped the phone. Create it if
   * missing, and fall back rather than throw if that is not possible.
   */
  #workingDirectory() {
    if (!this.cwd) return undefined;
    try {
      if (!existsSync(this.cwd)) mkdirSync(this.cwd, { recursive: true });
      if (statSync(this.cwd).isDirectory()) return this.cwd;
    } catch { /* fall through to the throw below */ }
    /*
     * Refuse rather than run somewhere else.
     *
     * This used to return undefined on failure, which means `spawn` inherits
     * the *server's* directory — so a session that asked to be confined to one
     * folder would quietly get write permission over this project's source
     * instead. Failing loudly is the only safe direction when the request was
     * specifically about where it is allowed to write.
     */
    throw new Error(`working directory is unusable: ${this.cwd}`);
  }

  #acc = '';

  #onData(data) {
    this.#acc += data;
    const lines = this.#acc.split('\n');
    this.#acc = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    // Claude reports its session id on init; keep it so this conversation can
    // be resumed after the process is reaped.
    if (msg.session_id && !this.claudeSessionId) this.claudeSessionId = msg.session_id;

    /*
     * The init message reports every tool this installation actually has.
     *
     * Hard-coding that list is how `chat` ended up with a working shell: the
     * deny list named `Bash` and the runtime also had `PowerShell`. Taking it
     * from the runtime means a tool added by a future release is denied by the
     * lower tiers automatically, rather than quietly widening all of them.
     */
    if (msg.type === 'system' && Array.isArray(msg.tools)) setRuntimeTools(msg.tools);

    const delta = msg?.event?.delta?.text ?? msg?.delta?.text;
    if (delta) {
      this.reply += delta;
      // The transcript is the screen channel and gets everything verbatim:
      // links, code, formatting. Only the speech channel is filtered.
      this.emit('text', delta);
      if (this.quiet) return;
      const spoken = this.speech.feed(delta);
      if (spoken) for (const chunk of this.chunker.push(spoken)) this.emit('chunk', chunk);
      return;
    }
    // A tool call means the turn may now take tens of seconds. Say so, loudly,
    // so the client can fill the silence instead of looking crashed.
    const block = msg?.event?.content_block ?? msg?.content_block;
    if (block?.type === 'tool_use') {
      const name = block.name ?? 'tool';
      this.toolLog.push({ name, at: Date.now() });
      if (this.toolLog.length > 40) this.toolLog.shift();
      this.lastUsed = Date.now();
      this.emit('tool', { name });
    }

    if (msg.type === 'result') {
      if (!this.quiet) {
        /*
         * `push` returns chunks, and they were being thrown away.
         *
         * Long replies survived because the speech filter releases them
         * mid-stream, where the return value *is* used. A short reply with no
         * newline in it never triggers that release, so the whole thing
         * arrived here at the end — was consumed by this call — and was
         * silently dropped. Asked to count to ten, the transcript read
         * "1, 2, 3, 4, 5, 6, 7, 8, 9, 10." and the speaker said nothing at all.
         */
        const tail = this.speech.flush();
        if (tail) for (const chunk of this.chunker.push(tail)) this.emit('chunk', chunk);
        for (const chunk of this.chunker.flush()) this.emit('chunk', chunk);
      } else {
        this.speech.flush();
        this.chunker.flush();
      }
      this.busy = false;
      this.lastUsed = Date.now();
      this.finishedAt = Date.now();
      if (this.reply.trim()) this.remember('claude', this.reply.trim());
      /*
       * A cancelled turn reports `error_during_execution`, which is not a
       * failure worth showing anyone — it is what an interruption looks like
       * from the inside.
       */
      const cancelled = msg.subtype === 'error_during_execution';
      this.status = cancelled ? 'done' : (msg.is_error ? 'error' : 'done');
      if (msg.is_error && !cancelled) this.error = String(msg.result ?? 'failed').slice(0, 300);
      this.emit('done', { ms: Date.now() - this.turnStart, error: msg.is_error ?? false });
    }
  }

  ask(text) {
    if (this.busy) throw new Error('session is already answering');
    this.start();
    this.chunker = makeChunker();
    this.speech = makeSpeechFilter();
    this.busy = true;
    this.turnStart = Date.now();
    this.lastUsed = Date.now();
    this.turns += 1;
    this.status = 'working';
    this.reply = '';
    this.error = null;
    this.startedAt = Date.now();
    this.finishedAt = null;
    if (!this.title) this.title = String(text).slice(0, 60);
    this.remember('me', text);
    const frame = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Ask a question whose answer is used, not spoken.
   *
   * Dispatch needs a task brief written from the conversation so far, and the
   * only thing that has that conversation is this session. But the reply is
   * an instruction for another process, not something to read out — hearing
   * your own brief recited back before the work starts is thirty wasted
   * seconds. `quiet` suppresses the speakable chunks while still accumulating
   * the text.
   */
  askQuiet(text, { timeoutMs = 60_000 } = {}) {
    if (this.busy) return Promise.reject(new Error('session is already answering'));
    return new Promise((resolve, reject) => {
      this.quiet = true;
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        this.quiet = false;
        clearTimeout(timer);
        this.off('done', onDone);
        this.off('error', onError);
        fn(arg);
      };
      const onDone = () => finish(resolve, this.reply.trim());
      const onError = (err) => finish(reject, err);
      const timer = setTimeout(() => finish(reject, new Error('timed out writing the brief')), timeoutMs);
      this.once('done', onDone);
      this.once('error', onError);
      try { this.ask(text); } catch (err) { finish(reject, err); }
    });
  }

  /**
   * Stop generating, without destroying the conversation.
   *
   * This used to kill the process and let the next turn resume by session id,
   * on the assumption that stream-json had no in-band cancel. It does: a
   * `control_request` with subtype `interrupt` ends the turn, is acknowledged,
   * and leaves the process running.
   *
   * The assumption was expensive. Killing mid-turn left the saved session
   * holding an unfinished exchange, so the resumed process carried on
   * answering the *abandoned* question — ask "what is my project called"
   * after an interruption and get the middle of the previous answer about TCP
   * congestion control. From the user's side that is indistinguishable from
   * having forgotten the conversation, and one background noise was enough to
   * trigger it.
   */
  interrupt() {
    if (!this.busy || !this.proc) return false;
    this.interrupts += 1;
    const frame = {
      type: 'control_request',
      request_id: `int_${this.id}_${this.interrupts}`,
      request: { subtype: 'interrupt' },
    };
    try {
      this.proc.stdin.write(`${JSON.stringify(frame)}
`);
    } catch {
      // A dead pipe is the one case where the process really has to go.
      this.stop();
    }
    return true;
  }

  /**
   * Add a line to the transcript this session can be restored from.
   *
   * Capped by count and by characters. An unbounded transcript is a slow leak
   * that only shows up after a long day of talking, and nobody scrolls back
   * through two hundred turns on a phone anyway.
   */
  remember(role, text) {
    this.history.push({ role, text: String(text).slice(0, 8000), at: Date.now() });
    while (this.history.length > 120) this.history.shift();
    let total = this.history.reduce((n, h) => n + h.text.length, 0);
    while (total > 60_000 && this.history.length > 1) {
      total -= this.history.shift().text.length;
    }
  }

  /** Everything needed to draw this session on a screen that has never seen it. */
  transcript() {
    return this.history.map(({ role, text }) => ({ role, text }));
  }

  stop() {
    this.busy = false;
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  view() {
    const recent = this.toolLog.slice(-3).map((t) => t.name);
    return {
      id: this.id,
      kind: this.kind,
      title: this.title ?? 'New session',
      model: this.model,
      tools: tierAllows(this.tier, 'build'),
      tier: this.tier,
      warm: Boolean(this.proc),
      busy: this.busy,
      status: this.status,
      turns: this.turns,
      lastUsed: new Date(this.lastUsed).toISOString(),
      // Seconds, because everything that reads this is deciding whether
      // something has stalled, and an ISO string cannot be compared out loud.
      idleSeconds: Math.round((Date.now() - this.lastUsed) / 1000),
      runningSeconds: this.busy && this.startedAt
        ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      recentTools: recent,
      lastTool: recent[recent.length - 1] ?? null,
      error: this.error,
      // Enough of the reply to say what it concluded, without reading an essay.
      summary: this.reply.trim().slice(0, 240),
    };
  }
}

export class SessionStore {
  /**
   * `file` is where the conversation list survives a restart.
   *
   * Sessions used to live only in this Map. Restarting the server - a deploy, a
   * crash, a reboot - silently discarded every one of them, and the rail came
   * back empty, so it looked like nothing was ever saved. The claude process
   * cannot be kept across a restart, but the thing that matters can: the resume
   * id, which hands the whole conversation back to a fresh process on the next
   * question.
   */
  constructor({ idleMs = 15 * 60 * 1000, file = null } = {}) {
    this.sessions = new Map();
    this.idleMs = idleMs;
    this.file = file;
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref?.();
    this.load();
  }

  create(opts = {}) {
    const id = `s_${Math.random().toString(36).slice(2, 10)}`;
    const session = new Session({ id, ...opts });
    this.sessions.set(id, session);
    this.save();
    return session;
  }

  /**
   * Write the conversation list out.
   *
   * Via a temporary file and a rename, because this is written on every turn
   * and a process that dies mid-write would otherwise leave truncated JSON that
   * loses every session rather than the one turn in flight.
   */
  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const sessions = [...this.sessions.values()]
        .filter((s) => s.claudeSessionId || s.history.length)
        .map((s) => ({
          id: s.id,
          kind: s.kind,
          model: s.model,
          tier: s.tier,
          cwd: s.cwd,
          resume: s.claudeSessionId,
          title: s.title,
          turns: s.turns,
          lastUsed: s.lastUsed,
          history: s.history,
        }));
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}
`);
      renameSync(tmp, this.file);
    } catch {
      // Losing the list is bad; refusing to answer because it could not be
      // written would be worse.
    }
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const { sessions = [] } = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const r of sessions) {
        if (!r?.id) continue;
        const session = new Session({
          id: r.id, kind: r.kind, model: r.model, tier: r.tier,
          cwd: r.cwd, resume: r.resume,
        });
        session.title = r.title ?? null;
        session.turns = Number(r.turns ?? 0);
        session.lastUsed = Number(r.lastUsed ?? Date.now());
        session.history = Array.isArray(r.history) ? r.history : [];
        this.sessions.set(session.id, session);
      }
    } catch {
      // A corrupt file starts empty rather than refusing to boot.
    }
  }

  get(id) { return this.sessions.get(String(id ?? '')) ?? null; }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((s) => s.view());
  }

  remove(id) {
    const s = this.get(id);
    if (!s) return false;
    s.stop();
    this.sessions.delete(s.id);
    this.save();
    return true;
  }

  /** Free idle processes. The conversation survives via --resume. */
  reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.proc && !s.busy && now - s.lastUsed > this.idleMs) s.stop();
    }
  }

  stopAll() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) s.stop();
  }
}

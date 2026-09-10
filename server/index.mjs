import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { DeviceStore, parseCookies, sessionCookie, clearCookie } from './devices.js';
import { Log } from './log.js';
import { SessionStore } from './sessions.js';
import { statusReport, spokenModel } from './status.mjs';
import { detectIntent } from '../public/intent.js';
import { normaliseTier, describeTier } from './permissions.mjs';
import { makeFillers } from './fillers.mjs';
import { isJunk } from './junk.mjs';

/**
 * Foovox server.
 *
 * Binds 127.0.0.1 explicitly. Nothing here should ever be on a wildcard —
 * cloudflared is the only thing that faces the world, and on this machine a
 * narrower bind silently winning a port collision once served a stranger's app
 * on a public domain for fourteen hours. See ~/ports.md.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HOST = '127.0.0.1';
/*
 * Who this instance belongs to — shown under the title in the app.
 *
 * This was the string `'redfoo'`, hardcoded, so every install anywhere would
 * have greeted its owner with the name of the person who wrote it. Taken from
 * the account running the server instead, which is right on anyone's machine
 * including the original one, and overridable for a shared box.
 */
const DEFAULT_USER = process.env.FOOVOX_USER
  || (() => { try { return os.userInfo().username; } catch { return 'you'; } })();

const PORT = Number(process.env.FOOVOX_PORT ?? 3210);
const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';

/*
 * Where any session with write permission is allowed to work.
 *
 * Not the server's own directory, which is what a null cwd inherits. A voice
 * session raised to Build wrote a file straight into this project's source
 * tree, because `spawn` with no cwd runs in ours. Sessions get a bounded
 * directory whether they were dispatched or elevated by hand.
 */
const WORK_DIR = process.env.FOOVOX_WORK_DIR ?? path.join(ROOT, 'data', 'work');

const log = new Log(path.join(ROOT, 'data', 'events.log'));
const devices = new DeviceStore({ path: path.join(ROOT, 'data', 'devices.json'), log });
const sessions = new SessionStore({ file: path.join(ROOT, 'data', 'sessions.json') });

/**
 * Bootstrap admin token.
 *
 * Pairing codes live only in the server's memory (they are one-use and
 * short-lived, so persisting them would be a liability, not a feature). That
 * means a separate CLI process cannot mint one — it would write to a Map the
 * server never sees. So minting goes through the server, and the very first
 * device needs some credential before any device exists. This file is it:
 * generated once, mode 600, never leaves the machine.
 */
const ADMIN_TOKEN_PATH = path.join(ROOT, 'data', 'admin-token.txt');
const ADMIN_TOKEN = existsSync(ADMIN_TOKEN_PATH)
  ? readFileSync(ADMIN_TOKEN_PATH, 'utf8').trim()
  : (() => {
      const token = randomBytes(32).toString('hex');
      writeFileSync(ADMIN_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
      return token;
    })();

function isAdmin(req) {
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(auth.slice(7).trim(), 'utf8');
  const expected = Buffer.from(ADMIN_TOKEN, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
});

/** Resolve a request to a device, by cookie or by bearer token. */
function deviceFor(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.foovox_device) {
    const device = devices.authenticate(cookies.foovox_device);
    if (device) return device;
  }
  const auth = String(req.headers.authorization ?? '');
  if (auth.startsWith('Bearer ')) return devices.authenticate(auth.slice(7).trim());
  return null;
}

// ---------------------------------------------------------------- speech

async function transcribe(pcm) {
  const res = await fetch(`${SPEECH}/stt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
  });
  if (!res.ok) throw new Error(`stt failed (${res.status})`);
  return res.json();
}

async function synthesise(text, voice, format = 'mp3') {
  const res = await fetch(`${SPEECH}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, format }),
  });
  if (!res.ok) throw new Error(`tts failed (${res.status})`);
  const pcm = Buffer.from(await res.arrayBuffer());
  return {
    pcm,
    synthMs: Number(res.headers.get('x-synth-ms') ?? 0),
    encodeMs: Number(res.headers.get('x-encode-ms') ?? 0),
    audioMs: Number(res.headers.get('x-audio-ms') ?? 0),
    format: res.headers.get('x-format') ?? format,
  };
}

// ---------------------------------------------------------------- http

const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

/** Serve a file from public/, or return false if there is nothing to serve. */
function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/+/, '') || 'index.html';
  // Resolve first, then confirm it is still inside public/: this is what stops
  // `/../data/admin-token.txt` from being a download link.
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    // The service worker must never be served stale or a bad build sticks.
    'Cache-Control': rel === 'sw.js' ? 'no-cache' : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // Health is reachable without a session because a monitor needs it, so it
  // says only that the process is alive. The model names, the port, and how
  // many conversations are open are all reconnaissance for anyone who finds
  // the tunnel; they are there for someone who has already signed in.
  if (req.method === 'GET' && pathname === '/health') {
    if (!deviceFor(req) && !isAdmin(req)) return json(res, 200, { ok: true });
    let speech = null;
    try { speech = await (await fetch(`${SPEECH}/health`)).json(); } catch { speech = { ok: false }; }
    return json(res, 200, { ok: true, port: PORT, speech, sessions: sessions.sessions.size });
  }

  // Redeem a pairing code. Unauthenticated on purpose — the code IS the
  // credential — which is why it is one-use, short-lived and rate limited.
  if (req.method === 'POST' && pathname === '/api/auth/redeem') {
    const body = await readBody(req);
    try {
      const device = devices.redeemPairing(body.code, {
        userAgent: req.headers['user-agent'],
        source: String(req.headers['cf-connecting-ip'] ?? req.socket?.remoteAddress ?? 'unknown'),
      });
      // Secure only over HTTPS: on plain local HTTP a Secure cookie is silently
      // dropped by the browser, which looks exactly like a broken login.
      const isHttps = String(req.headers['x-forwarded-proto'] ?? '').startsWith('https');
      res.setHeader('Set-Cookie', sessionCookie(device.token, { secure: isHttps }));
      return json(res, 201, {
        deviceId: device.deviceId,
        principalId: device.principalId,
        label: device.label,
        token: device.token, // for non-browser clients; browsers use the cookie
      });
    } catch (error) {
      return json(res, /too many/i.test(error.message) ? 429 : 403, { error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    res.setHeader('Set-Cookie', clearCookie());
    return json(res, 200, { ok: true });
  }

  // Mint a pairing code. Either the admin token (bootstrap, and adding your
  // own next device) or an already-paired device may do this.
  if (req.method === 'POST' && pathname === '/api/auth/pair') {
    const existing = deviceFor(req);
    if (!isAdmin(req) && !existing) return json(res, 401, { error: 'not authorised' });
    const body = await readBody(req);
    const principalId = String(body.principalId ?? existing?.principalId ?? DEFAULT_USER);
    const pairing = devices.createPairing({
      principalId,
      label: body.label ?? 'phone',
      ttlMs: body.ttlMs ?? null,
    });
    return json(res, 201, { ...pairing, principalId });
  }

  // The app shell. Unauthenticated visitors get the pairing screen instead —
  // the assets themselves are not secret, the API behind them is.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (!deviceFor(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    return serveStatic(req, res, '/index.html') || json(res, 404, { error: 'not built' });
  }

  if (req.method === 'GET' && pathname === '/login') {
    return serveStatic(req, res, '/login.html') || json(res, 404, { error: 'not built' });
  }

  if (req.method === 'GET' && serveStatic(req, res, pathname)) return;

  const device = deviceFor(req);
  if (!device) return json(res, 401, { error: 'not authenticated' });

  if (req.method === 'GET' && pathname === '/api/whoami') {
    return json(res, 200, { principalId: device.principalId, device: devices.publicView(device) });
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    return json(res, 200, { sessions: sessions.list() });
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req);
    const session = sessions.create({
      model: body.model ?? 'claude-sonnet-5',
      tier: normaliseTier(body.tier ?? body.tools),
      cwd: body.cwd ?? WORK_DIR,
    });
    log.append('session:created', { id: session.id, principalId: device.principalId, tier: session.tier });
    return json(res, 201, session.view());
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
    const id = pathname.slice('/api/sessions/'.length);
    return json(res, sessions.remove(id) ? 200 : 404, { ok: sessions.get(id) === null });
  }

  if (req.method === 'GET' && pathname === '/api/devices') {
    return json(res, 200, { devices: devices.listFor(device.principalId) });
  }

  return json(res, 404, { error: 'not found' });
});

/**
 * Turn "code it in Opus" into something a fresh process can act on.
 *
 * The instruction the user actually gave is a pronoun. What "it" refers to is
 * in the conversation, and the work session has never seen that conversation —
 * so the voice session is asked to write the brief, and that brief is what
 * gets dispatched. Without this step the job receives the phrase rather than
 * the task.
 */
async function briefFrom(session, hint = '') {
  const brief = await session.askQuiet([
    'Write a task brief for a separate engineer who has not seen this',
    'conversation, capturing the work we have just been discussing.',
    hint ? `Focus on: ${hint}.` : '',
    'First line: one short imperative sentence naming the task.',
    'Then the concrete requirements, any file or directory paths mentioned,',
    'and how to tell when it is done. Be specific and self-contained; they',
    'cannot ask you questions. Output only the brief, no preamble.',
  ].filter(Boolean).join(' '));
  if (!brief) throw new Error('no brief was produced');
  return brief;
}

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ noServer: true });

// Authenticate at the upgrade, so an unauthenticated socket never opens.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const device = deviceFor(req);
  if (!device) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.device = device;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  let session = null;
  let frames = [];
  let bytes = 0;
  /*
   * Transcription started before the turn is over.
   *
   * The endpoint deliberately waits 800 ms of silence before deciding you have
   * finished, and transcription only began after that — so a full second of
   * whisper ran in dead air while the user waited. The client now says
   * "probably finished" after a quarter of a second of quiet, and the work
   * starts then. By the time the endpoint actually fires, the answer is
   * usually already in hand.
   *
   * Safe because the only audio that arrives between the two is the silence
   * itself, and silence adds no words.
   */
  let guess = null;
  const MAX_BYTES = 16_000 * 4 * 120; // two minutes of 16 kHz float32

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  send({ type: 'ready', principalId: ws.device.principalId, sessions: sessions.list() });

  /**
   * Wire a session's events to this socket, speaking each chunk as it lands.
   *
   * TTS is serialised through one promise chain rather than fired per chunk.
   * Two reasons, both found by running it: concurrent synthesis means audio
   * can arrive out of order and the sentences play scrambled, and `done`
   * emitted straight from the session raced ahead of the audio it was
   * supposed to conclude — the first test saw one chunk of a four-sentence
   * answer because the client exited on `done` while chunks two and three
   * were still in the synthesiser.
   *
   * `turn` invalidates work in flight after a barge-in: audio for a sentence
   * the user already talked over must never reach the speaker.
   */
  let chain = Promise.resolve();
  let turn = 0;
  // One per socket: two people on two sessions should not hear their phrasing
  // correlate, and "never repeat the last line" only means anything per
  // conversation.
  const fillers = makeFillers();

  const attach = (s) => {
    s.removeAllListeners();
    s.on('text', (delta) => send({ type: 'text', delta }));
    /*
     * Speak while it works.
     *
     * A tool call has no upper bound — a read is instant, a search is seconds,
     * a shell command was measured at 42. Until it returns there is nothing to
     * say, and silence from something that was talking a moment ago reads as a
     * crash. The line is queued on the same chain as real speech, so it cannot
     * arrive on top of the reply it is covering for.
     */
    s.on('tool', ({ name }) => {
      send({ type: 'tool', name });
      const line = fillers.forTool(name);
      if (line) say(line);
    });
    s.on('error', (err) => send({ type: 'error', message: err.message }));

    s.on('chunk', (text) => {
      const mine = turn;
      if (process.env.FOOVOX_VERBOSE) console.log(`[chunk] turn=${turn} mine=${mine} "${text.slice(0, 40)}"`);
      chain = chain.then(async () => {
        if (mine !== turn || ws.readyState !== 1) {
          if (process.env.FOOVOX_VERBOSE) console.log(`[drop]  mine=${mine} turn=${turn} ready=${ws.readyState}`);
          return;
        }
        try {
          const { pcm, synthMs, encodeMs, audioMs, format } = await synthesise(text, ws.voice, ws.format);
          if (mine !== turn || ws.readyState !== 1) return; // interrupted mid-synthesis
          send({ type: 'speak', text, synthMs, encodeMs, audioMs, format, bytes: pcm.length });
          ws.send(pcm); // binary frame follows its header
        } catch (err) {
          send({ type: 'error', message: `tts: ${err.message}` });
        }
      });
    });

    // Queued behind the audio, so `done` means "you have heard everything".
    s.on('done', ({ ms }) => {
      const mine = turn;
      // Written here rather than on a timer: this is the moment the resume id
      // and the finished exchange both exist, and the moment a restart would
      // otherwise lose them.
      sessions.save();
      chain = chain.then(() => { if (mine === turn) send({ type: 'done', ms }); });
    });
  };

  /**
   * Speak text that did not come from the model.
   *
   * Status reports and dispatch confirmations are generated here, not by
   * Claude — asking a model to read out a number it would have to be told
   * anyway is a needless second of latency and a chance to get it wrong.
   */
  const say = (text) => {
    const mine = turn;
    bubbleNote(text);
    chain = chain.then(async () => {
      if (mine !== turn || ws.readyState !== 1) return;
      try {
        const { pcm, synthMs, audioMs, format } = await synthesise(text, ws.voice, ws.format);
        if (mine !== turn || ws.readyState !== 1) return;
        send({ type: 'speak', text, synthMs, audioMs, format, bytes: pcm.length });
        ws.send(pcm);
      } catch (err) {
        send({ type: 'error', message: `tts: ${err.message}` });
      }
    });
  };
  const bubbleNote = (text) => send({ type: 'note', text });

  /*
   * Answered from the session table rather than by the model. The voice
   * session cannot see the other processes, so it would have to be told the
   * answer before it could say it — reading it directly is a second faster
   * and cannot be embellished.
   */
  const handleStatus = async () => {
    turn += 1;
    const text = statusReport(sessions.list(), session?.id ?? null);
    send({ type: 'status', text, sessions: sessions.list() });
    say(text);
  };

  /*
   * Hand the conversation so far to a work session.
   *
   * What was actually said is "code it in Opus" — the task lives in the
   * preceding conversation, which only this session has. So it is asked for a
   * brief first, and that brief becomes the job's opening instruction. One
   * extra turn, and it is the difference between dispatching the task and
   * dispatching the phrase.
   */
  const handleDispatch = async (intent) => {
    if (!session) return send({ type: 'error', message: 'nothing to dispatch yet' });
    if (session.busy) return send({ type: 'error', message: 'still answering — try again in a moment' });
    const model = String(intent.model ?? 'claude-opus-5');
    turn += 1;
    say(`Writing the brief, then starting ${spokenModel(model)}.`);
    try {
      const brief = await briefFrom(session, intent.hint ?? '');
      const job = sessions.create({
        model,
        // Build, not full: a dispatched job writes files in its own directory.
        // Granting it a shell because it needs to save a file is the kind of
        // convenience that turns a leaked pairing code into a real problem.
        tier: 'build',
        kind: 'work',
        cwd: intent.cwd ?? WORK_DIR,
      });
      job.title = brief.split(String.fromCharCode(10))[0].slice(0, 60);
      job.ask(brief);
      log.append('job:dispatched', {
        id: job.id, model, principalId: ws.device.principalId, brief: brief.slice(0, 200),
      });
      send({ type: 'dispatched', job: job.view(), brief, sessions: sessions.list() });
      say(`Started on ${spokenModel(model)}. ${job.title}. Ask me for a status any time.`);
    } catch (err) {
      send({ type: 'error', message: `dispatch failed: ${err.message}` });
      say(`I could not start that: ${err.message}`);
    }
  };

  /**
   * Spoken commands are classified here, not in the browser.
   *
   * Typing "status" and saying it should do the same thing, and there is only
   * one place both paths pass through. The classifier itself is shared with
   * the client so the rules cannot drift apart.
   */
  const routed = async (text) => {
    const intent = detectIntent(text);
    if (!intent) return false;
    if (intent.type === 'status') { await handleStatus(); return true; }
    if (intent.type === 'dispatch') { await handleDispatch(intent); return true; }
    return false;
  };

  const answer = async (text) => {
    if (await routed(text)) return;
    if (!session) {
      session = sessions.create({});
      attach(session);
      send({ type: 'session', session: session.view() });
    }
    // A new question supersedes anything still in the synthesiser.
    turn += 1;
    fillers.newTurn();
    try { session.ask(text); } catch (err) { send({ type: 'error', message: err.message }); }
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      bytes += data.length;
      if (bytes > MAX_BYTES) { frames = []; bytes = 0; return send({ type: 'error', message: 'utterance too long' }); }
      frames.push(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'hello') {
      ws.voice = msg.voice ?? undefined;
      // Only the Node test harness asks for pcm; it has no audio decoder.
      ws.format = msg.format === 'pcm' ? 'pcm' : 'mp3';
      if (msg.sessionId) {
        const existing = sessions.get(msg.sessionId);
        if (existing) { session = existing; attach(session); }
      }
      if (!session && msg.newSession !== false) {
        session = sessions.create({
          model: msg.model ?? 'claude-sonnet-5',
          tier: normaliseTier(msg.tier ?? msg.tools),
          cwd: msg.cwd ?? WORK_DIR,
        });
        attach(session);
      }
      // Boot the process now rather than on the first question. Starting it
      // costs ~1.7s, and the user is about to spend several seconds talking —
      // spending it during their sentence instead of after makes the first
      // turn of a session as fast as every later one.
      session.start();
      return send({ type: 'session', session: session.view() });
    }

    /*
     * A pause long enough to be worth betting on. Start transcribing now; if
     * they carry on talking, the bet is simply discarded.
     */
    if (msg.type === 'pre-end') {
      const pcm = Buffer.concat(frames);
      // Below about half a second there is nothing worth transcribing, and the
      // overhead would cost more than the head start is worth.
      if (pcm.length > 16000 * 4 * 0.5) {
        guess = { bytes: pcm.length, at: Date.now(), promise: transcribe(pcm).catch(() => null) };
      }
      return;
    }

    // The utterance is over: transcribe what was streamed while they spoke.
    if (msg.type === 'end') {
      const pcm = Buffer.concat(frames);
      frames = []; bytes = 0;
      if (!pcm.length) { guess = null; return send({ type: 'error', message: 'no audio received' }); }
      try {
        /*
         * Use the speculative result if the only thing that arrived after it
         * was silence. More than a second of extra audio means they resumed
         * speaking, and the guess is missing words — transcribe again.
         */
        const extra = guess ? pcm.length - guess.bytes : Infinity;
        const usable = guess && extra >= 0 && extra <= 16000 * 4 * 1.1;
        const started = Date.now();
        const heard = (usable && await guess.promise) || await transcribe(pcm);
        guess = null;
        send({
          type: 'heard',
          text: heard.text,
          ms: Date.now() - started,
          sttMs: heard.ms,
          speculative: Boolean(usable),
          seconds: heard.seconds,
        });
        /*
         * A noise must not become a turn.
         *
         * Whisper does not return nothing for a bird or a door — it returns
         * "Thank you." or "you", every time, because those padded its training
         * clips. Sent on, that puts a sentence into the conversation history
         * that nobody said, and every later answer is conditioned on it. The
         * reported symptom was the assistant losing the thread whenever
         * something rustled in the background.
         */
        const verdict = isJunk(heard.text, heard.seconds);
        if (verdict.junk) {
          log.append('turn:ignored', { text: heard.text, why: verdict.why });
          // Shown, not hidden: silently discarding what someone said is worse
          // than telling them it was not counted.
          send({ type: 'ignored', text: heard.text, why: verdict.why });
          return send({ type: 'done', ms: 0, empty: true });
        }
        await answer(heard.text);
      } catch (err) {
        send({ type: 'error', message: `stt: ${err.message}` });
      }
      return;
    }

    if (msg.type === 'text' && msg.text) return answer(String(msg.text));

    /*
     * "How is it going?" — answered from the session table, not by the model.
     *
     * Deliberately not routed through Claude: the voice session has no way to
     * see the other processes, so it would have to be told the answer before
     * it could say it. Reading it directly is a second faster and cannot be
     * embellished.
     */
    if (msg.type === 'status') return handleStatus();

    /*
     * Hand the conversation so far to a work session.
     *
     * The brief is written by the voice session rather than by the user,
     * because what was actually said is "code it in Opus" — the task lives in
     * the preceding conversation, which only this session has. So it is asked
     * for a brief first, and that brief becomes the work session's opening
     * instruction. One extra turn, and it is the difference between
     * dispatching the task and dispatching the phrase.
     */
    if (msg.type === 'dispatch') return handleDispatch(msg);

    // Switch rails. Bump the turn first so audio still in the synthesiser for
    // the session being left never plays over the one being opened.
    if (msg.type === 'select') {
      const target = sessions.get(msg.sessionId);
      if (!target) return send({ type: 'error', message: 'unknown session' });
      turn += 1;
      session = target;
      attach(session);
      session.start();
      // The transcript goes with it. Without this the screen kept whichever
      // conversation you had been reading, while your words went somewhere else.
      return send({
        type: 'session',
        session: session.view(),
        sessions: sessions.list(),
        history: session.transcript(),
      });
    }

    if (msg.type === 'new') {
      turn += 1;
      session = sessions.create({
        model: msg.model ?? 'claude-sonnet-5',
        tier: normaliseTier(msg.tier ?? msg.tools),
        cwd: msg.cwd ?? WORK_DIR,
      });
      attach(session);
      session.start();
      log.append('session:created', { id: session.id, principalId: ws.device.principalId, tier: session.tier });
      return send({
        type: 'session', session: session.view(), sessions: sessions.list(), history: [],
      });
    }

    // Same shape as arming tools: the model is a process argument, so the
    // process is replaced and resumed on the same claude session id. Switching
    // to Opus mid-conversation keeps everything said so far.
    if (msg.type === 'model' && msg.model) {
      if (!session) return;
      session.model = String(msg.model);
      session.stop();
      session.start();
      log.append('session:model', { id: session.id, model: session.model });
      return send({ type: 'session', session: session.view() });
    }

    /*
     * Changing what a session may do replaces the process, because the
     * permission set is a command-line argument. The conversation survives via
     * --resume, so raising or lowering trust mid-conversation costs a restart,
     * not the context.
     */
    if (msg.type === 'tier' || msg.type === 'tools') {
      if (!session) return;
      session.tier = normaliseTier(msg.type === 'tier' ? msg.tier : msg.enabled);
      session.stop();
      session.start();
      log.append('session:tier', {
        id: session.id, principalId: ws.device.principalId, tier: session.tier,
      });
      send({ type: 'note', text: describeTier(session.tier) });
      return send({ type: 'session', session: session.view() });
    }

    // Barge-in: they started talking over the reply. Stop generating at once,
    // and bump the turn so audio already in the synthesiser is discarded
    // rather than played at someone who has moved on.
    if (msg.type === 'interrupt') {
      turn += 1;
      // The process survives an interrupt now, so there is nothing to respawn
      // and the conversation is never rebuilt from a half-finished turn.
      const stopped = session?.interrupt() ?? false;
      return send({ type: 'interrupted', stopped });
    }
  });

  ws.on('close', () => { session?.removeAllListeners(); });
});

server.listen(PORT, HOST, () => {
  console.log(`[foovox] http://${HOST}:${PORT}  (speech: ${SPEECH})`);
});

const shutdown = () => { sessions.stopAll(); server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

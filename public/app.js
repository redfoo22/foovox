/**
 * Foovox — the phone half.
 *
 * Captures on the phone's microphone, decides when you have stopped talking,
 * ships the audio to the machine at home, and plays back what Claude says.
 * The two things that decide whether this feels like a conversation both live
 * here rather than on the server: how quickly the endpoint fires, and whether
 * you can talk over the reply.
 */

import { EchoModel } from './echo.js';
import { LevelModel } from './level.js';

const MIC_RATE = 16000;
const TTS_RATE = 24000;
const FRAME_MS = 20;
// Frames of confirmation are set per-frame now; see onFrame.

const state = {
  ws: null,
  ctx: null,
  playCtx: null,
  node: null,
  source: null,
  stream: null,
  // In-flight startListening(), so overlapping presses share one attempt
  // rather than each opening their own stream.
  starting: null,
  // addModule only has to happen once per context, and the context now lives
  // as long as the page.
  workletReady: false,
  listening: false,
  speaking: false,      // the user is talking
  /*
   * The Talk button is being held down.
   *
   * While it is, the button *is* the endpoint: every frame is speech, no
   * threshold is consulted, and nothing ends the turn but your thumb. All the
   * machinery that decides where your voice sits relative to the room is a
   * best-effort guess at something you are, in this mode, stating outright.
   */
  held: false,
  heldFrames: 0,
  // Was it already listening hands-free before the press? Decides whether
  // letting go returns to idle (one shot) or back to the conversation.
  heldResume: false,
  playing: false,       // Claude is talking
  session: null,
  sessions: [],
  // Endpoint detection
  floor: 0.005,
  aboveFor: 0,
  belowFor: 0,
  guessed: false,
  preroll: [],
  trace: [],
  settings: {
    // 800, not 600. At 600 a pause at a comma ended the turn and "In one short
    // sentence, what is a mutex?" was sent as "In one short sentence," — the
    // trace showed speech resuming three frames after the endpoint fired.
    // Being cut off mid-sentence is a much worse failure than 200 ms more
    // latency, and the slider is there for anyone who talks without pausing.
    silenceMs: 800,
    /*
     * Where the bar sits between the room and your voice, 0..1.
     *
     * Low is twitchy, high means you have to speak up. This replaced a
     * multiplier applied to the noise floor, which was inert: the threshold
     * was `max(floor * sensitivity, 0.008)` and in a quiet room every slider
     * position landed under that fixed minimum and produced the same number.
     */
    margin: 0.35,
    /*
     * A measured minimum for the noise floor, set by calibration.
     *
     * The continuous floor is an exponential average that settles in about
     * 400 ms, so a calibrated value written straight into it would be erased
     * almost at once. It has to be a *lower bound* instead: the room is never
     * treated as quieter than it was measured to be, while the average can
     * still raise it further if things get louder. Null until calibrated.
     */
    noiseFloor: null,
    bargeIn: false,
    voice: 'af_heart',
    // Measured warm time-to-first-token: Sonnet 833 ms, Opus 891 ms, Haiku
    // 1303 ms, Fable 2647 ms. Opus costs about 60 ms over Sonnet, so there is
    // no latency argument for defaulting away from the smarter model in a
    // conversation. Fable is a different trade and worth choosing knowingly.
    model: 'claude-sonnet-5',
    // Starts at the tier that can do nothing. If a pairing code leaks, this is
    // the difference between a stranger chatting and a stranger with a shell.
    tier: 'chat',
  },
  playhead: 0,
  queued: [],
  // Models how much of our own output comes back through the microphone.
  echo: new EchoModel({ frameMs: FRAME_MS }),
  // Learns the room and, separately, your voice — so the bar can sit between
  // them and stay there while you pause.
  level: new LevelModel({ frameMs: FRAME_MS }),
  lagCheckedAt: 0,
  cutoffs: 0,
  lastMic: 0,
  lastThreshold: 0,
  // Calibration: a few seconds of deliberate silence, sampled, to set the
  // floor from the room you are actually in rather than from whatever
  // happened to be quiet a moment ago.
  calibrating: null,
  decode: Promise.resolve(),
  // Bumped on barge-in so audio still decoding for an abandoned reply is
  // dropped instead of played at someone who has moved on.
  generation: 0,
  /*
   * Audio for an abandoned reply that has not arrived yet.
   *
   * Bumping `generation` only protects chunks already received: a chunk still
   * in flight when you interrupt arrives afterwards, reads the *new*
   * generation, and plays — which is why two more sentences still came out
   * after "stop". So incoming audio is refused outright from the moment you
   * interrupt until you ask something new.
   */
  dropAudio: false,
};

const $ = (id) => document.getElementById(id);
const log = (msg) => { $('status').textContent = msg; };

// ---------------------------------------------------------------- settings

/*
 * Settings are remembered, which means a changed default never reaches anyone
 * already using it. `v` is how a default that turned out to be wrong gets
 * corrected once, without throwing away the rest of someone's preferences.
 */
const SETTINGS_VERSION = 2;
try {
  const saved = JSON.parse(localStorage.getItem('foovox') || '{}');
  const stale = (saved.v ?? 1) < SETTINGS_VERSION;
  Object.assign(state.settings, saved);
  if (stale) {
    // v2: talk-over defaults off. On a speakerphone it was hearing itself and
    // interrupting its own first sentence, which made the app unusable; it is
    // opt-in until it is trustworthy.
    state.settings.bargeIn = false;
  }
  state.settings.v = SETTINGS_VERSION;
} catch { /* defaults are fine */ }
const saveSettings = () => localStorage.setItem('foovox',
  JSON.stringify({ ...state.settings, v: SETTINGS_VERSION }));

// ---------------------------------------------------------------- transcript

function bubble(who, text) {
  // The empty state is instructions, not content: it goes the moment there is
  // anything real to read.
  document.getElementById('empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  $('transcript').append(el);
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return el;
}

let replyEl = null;

// ---------------------------------------------------------------- playback

/**
 * Gapless playback queue. Audio arrives as mp3 and is decoded here.
 *
 * Each chunk is scheduled at an absolute time rather than played on arrival —
 * `start()` on receipt would leave a seam at every boundary equal to the
 * network jitter, which over a tunnel is audible.
 *
 * Decoding is asynchronous, and two chunks decoded concurrently can finish in
 * either order, so decodes are chained. Without that a short second sentence
 * can overtake a long first one and the reply plays back scrambled.
 */
function play(bytes) {
  const generation = state.generation;
  state.decode = state.decode.then(async () => {
    if (generation !== state.generation) return; // barged in while decoding
    const ctx = state.playCtx;
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (err) {
      log(`could not decode audio: ${err.message}`);
      return;
    }
    if (generation !== state.generation) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const at = Math.max(now, state.playhead || now);
    source.start(at);
    // Remember the shape of what we are about to emit, on the same clock the
    // microphone is measured against. This is what lets the echo be
    // subtracted rather than guessed at — see `expectedOutput`.
    state.echo.remember(buffer.getChannelData(0), buffer.sampleRate, at);
    // First chunk of a reply: begin the listening period that measures this
    // room's echo before any of it is judged.
    if (!playingNow()) state.echo.startPlayback(at);
    state.playhead = at + buffer.duration;
    state.queued.push(source);
    document.body.classList.add('speaking');

    // Only for housekeeping. Whether audio is playing is decided by the clock,
    // not by this firing — see `playingNow`.
    source.onended = () => {
      state.queued = state.queued.filter((s) => s !== source);
    };
  }).catch(() => { /* one bad chunk must not stop the queue */ });
}

/**
 * Is our own speaker sounding right now?
 *
 * Derived from the schedule rather than from `onended`. It used to be a flag
 * set true on `start()` and cleared in `onended`, which meant a single
 * `onended` that never fired — not unusual on iOS Safari — left it stuck true
 * forever. From then on the endpoint detector used the echo guard, holding the
 * bar at 1.6x the echo measured during the *previous* reply, and the next
 * thing the user said was cut off after a word or two. Reported as: the first
 * turn was perfect, every turn after it got chopped.
 *
 * `playhead` is the absolute time the last scheduled chunk ends. Comparing it
 * to the clock cannot get stuck, because nothing has to fire for time to pass.
 */
function playingNow() {
  return Boolean(state.ctx) && state.playhead > state.ctx.currentTime + 0.005;
}

function stopPlayback() {
  state.generation += 1;
  for (const source of state.queued) { try { source.stop(); } catch { /* already ended */ } }
  state.queued = [];
  state.playhead = 0;
  state.playing = false;
  state.echo.reset();
  document.body.classList.remove('speaking');
}

// ---------------------------------------------------------------- endpoint

/**
 * Endpoint detection: an adaptive noise floor rather than a fixed threshold.
 *
 * A fixed threshold works in one room. The floor is re-learned from whatever
 * is quiet, so a noisy street and a silent bedroom both end up with speech
 * sitting the same distance above it.
 *
 * This is deliberately not Silero. Silero is better in hard noise, but it is
 * an ONNX model that needs a bundler and about 2 MB before the page can say a
 * word, and this project is meant to be cloned and run without a build step.
 * If the noise robustness ever matters more than that, it is a drop-in swap:
 * everything downstream only needs `onSpeechStart` and `onSpeechEnd`.
 */
function onFrame(pcm, rms) {
  const playing = playingNow();
  // Playback just finished: forget the room measurement so the next reply
  // measures afresh, and never judges the user against a stale echo peak.
  if (state.playing && !playing) {
    state.echo.reset();
    state.playhead = 0;
    document.body.classList.remove('speaking');
  }
  state.playing = playing;

  /*
   * Held down: skip the entire detector.
   *
   * Everything below this line exists to answer "is that you or is that the
   * room" - a question with no certain answer, which is why it has needed so
   * many corrections. Holding the button answers it directly, so none of it
   * runs: no threshold, no echo guard, no confirmation frames, no silence
   * timer. It cannot cut you off mid-sentence because nothing is looking for
   * the end of your sentence.
   */
  if (state.held) {
    if (!state.speaking) startSpeech({ barge: false }); // already barged on press
    send(pcm);
    state.heldFrames += 1;
    // Still worth learning from: this is the cleanest sample of your voice the
    // app ever gets, known to be speech rather than inferred to be. It tunes
    // the bar that hands-free mode uses.
    state.level.observeSpeech(rms);
    state.lastMic = rms;
    state.lastThreshold = 0; // nothing to clear, and the meter should say so

    /*
     * Bet on the end early anyway.
     *
     * People stop talking a moment before they let go, so a quarter second
     * under the hold bar is a good sign the words are finished. Starting
     * transcription then makes release and answer nearly simultaneous. If they
     * carry on, the bet costs one discarded transcription.
     */
    if (rms > state.level.holdThreshold(state.settings.margin)) {
      state.belowFor = 0;
      state.guessed = false;
    } else {
      state.belowFor += FRAME_MS;
      if (!state.guessed && state.belowFor >= 250) {
        state.guessed = true;
        sendJson({ type: 'pre-end' });
      }
    }
    return;
  }

  // What our own speaker is emitting at this instant, from the samples we
  // scheduled — not a guess, and not something the microphone has to work out.
  const clock = state.ctx ? state.ctx.currentTime : 0;
  const output = playing && state.ctx ? state.echo.expected(clock) : 0;

  // Feed the microphone in so the speaker-to-mic delay can be measured, and
  // re-measure about twice a second. Assuming a worst-case delay instead would
  // mean widening the window until it swallowed the gaps between words, which
  // is the one thing this must not do.
  if (state.ctx) {
    state.echo.pushMic(clock, rms);
    if (playing && clock - state.lagCheckedAt > 0.5) {
      state.lagCheckedAt = clock;
      state.echo.estimateLag(clock);
    }
  }
  // Calibration only ever raises the floor; it is a measured lower bound on
  // the room, never a ceiling on what the model may learn.
  if (state.settings.noiseFloor) {
    state.level.floor = Math.max(state.level.floor, state.settings.noiseFloor);
  }
  /*
   * Two bars, not one.
   *
   * Starting a turn is judged against the full threshold; continuing one is
   * judged against a much lower bar. Speech swings between a stressed syllable
   * and an unstressed one at roughly a third of it, so a single bar either
   * lets the room in or cuts you off the moment you stop shouting.
   */
  const base = state.speaking
    ? state.level.holdThreshold(state.settings.margin)
    : state.level.threshold(state.settings.margin);

  // Learn the coupling only from frames echo alone can explain (see echo.js).
  if (!state.speaking) state.echo.observe(rms, output);

  // In a gap in Claude's speech the echo term is zero and this falls straight
  // back to normal sensitivity — which is how an interruption is caught
  // instantly, without transcribing or watermarking anything.
  if (playing && state.echo.inHoldOff(clock)) state.echo.notePeak(rms);
  // The learned voice level is passed in as a ceiling: the bar must never be
  // set higher than the person can actually reach.
  const threshold = playing
    ? state.echo.guard(base, output, clock, state.level.learned ? state.level.speech : 0)
    : state.echo.threshold(base, output);
  // A little more confirmation while audio plays, but nothing like the blanket
  // delay this used to apply, because the echo term now does the real work.
  const confirmMs = output > 0.01 ? 120 : 60;

  state.lastMic = rms;
  state.lastThreshold = threshold;

  // Calibration samples the room while the user deliberately says nothing.
  if (state.calibrating) {
    state.calibrating.samples.push(rms);
    if (Date.now() >= state.calibrating.until) finishCalibration();
    return; // never treat the calibration silence as a turn
  }
  state.trace.push([Math.round(rms * 1e4), Math.round(threshold * 1e4), state.speaking ? 1 : 0]);
  if (state.trace.length > 500) state.trace.shift();

  if (!state.speaking) {
    // Learn the room only when our own speaker is silent, or the echo teaches
    // it that the room is as loud as Claude.
    if (!playing) state.level.observeQuiet(rms);

    state.preroll.push(pcm);
    // ~500 ms of lead-in, so the first consonant is not clipped off.
    if (state.preroll.length > 500 / FRAME_MS) state.preroll.shift();

    // With "let me talk over it" off, do not listen at all while Claude is
    // speaking. Otherwise the setting only stopped the barge-in and still let
    // the microphone hear the loudspeaker, transcribe Claude, and ask Claude
    // about himself — the failure it is meant to be the escape hatch from.
    if (playing && !state.settings.bargeIn) {
      state.aboveFor = 0;
      return;
    }

    if (rms > threshold) {
      state.aboveFor += FRAME_MS;
      if (state.aboveFor >= confirmMs) startSpeech();
    } else {
      state.aboveFor = 0;
    }
    return;
  }

  send(pcm);
  // Learn where this person's voice actually sits, so the bar can be placed
  // below it and held there through the pauses.
  state.level.observeSpeech(rms);
  if (rms > threshold) {
    state.belowFor = 0;
    state.guessed = false;
  } else {
    state.belowFor += FRAME_MS;
    /*
     * Tell the server to start transcribing well before the turn ends.
     *
     * The endpoint waits 800 ms to be sure you have finished, and that whole
     * wait used to be dead air with a second of transcription queued behind
     * it. Betting after 250 ms gives the server a head start on the common
     * case; if you carry on talking, the bet costs nothing but a discarded
     * result.
     */
    if (!state.guessed && state.belowFor >= 250) {
      state.guessed = true;
      sendJson({ type: 'pre-end' });
    }
    if (state.belowFor >= state.settings.silenceMs) endSpeech();
  }
}

/**
 * Set the noise floor from a measured stretch of room, not from whatever was
 * quiet a moment ago.
 *
 * The continuous floor is an average, which lags and gets dragged upward by
 * anything intermittent — a wave breaking, someone in the kitchen. Taking a
 * high percentile of a few seconds of deliberate silence captures the *peaks*
 * of the background rather than its mean, which is what actually has to be
 * cleared to avoid false turns.
 */
function finishCalibration() {
  const { samples } = state.calibrating;
  state.calibrating = null;
  $('calibrate').classList.remove('busy');
  $('calibrate').textContent = 'Calibrate to this room';
  if (samples.length < 10) { log('calibration too short'); return; }
  const sorted = [...samples].sort((a, b) => a - b);
  // 90th percentile, not the maximum: one door slam should not deafen it.
  const noise = sorted[Math.floor(sorted.length * 0.9)];
  state.settings.noiseFloor = noise;
  state.level.floor = Math.max(state.level.floor, noise);
  saveSettings();
  bubble('note', `Calibrated: background ${db(noise)}, bar now at ${db(state.level.threshold(state.settings.margin))}.`);
  log('calibrated');
}

/** dBFS, which is what a level meter should show. */
function db(rms) {
  if (!(rms > 0)) return '-inf dB';
  return `${Math.round(20 * Math.log10(rms))} dB`;
}

/** 0..1 position on the meter for an rms value, over a -60..0 dBFS scale. */
function meterPos(rms) {
  if (!(rms > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}

/**
 * Cut the reply off.
 *
 * Playback stops locally first and the server is told afterwards. Doing it in
 * the other order would leave Claude talking for the length of a round trip
 * after you started speaking.
 *
 * Unconditional, and that is the fix for the worst bug this had. It used to
 * return early unless `state.playing` was true — but that flag is only set
 * while a decoded chunk is actually sounding, so in the gap between two chunks
 * it is false. Starting to talk in that gap sent no interrupt at all: the
 * server happily generated and streamed the rest of the reply, and the phone
 * played it. "I said stop, it said okay I'll stop, and it kept talking."
 *
 * The server treats an interrupt with nothing to interrupt as a no-op, so
 * there is no cost to always sending it.
 */
function bargeIn() {
  // Interrupting while audio is playing is either a real interruption or the
  // phone hearing itself. Counted either way: a number climbing on its own,
  // with nobody talking, is the signature of the echo loop.
  if (playingNow()) state.cutoffs += 1;
  stopPlayback();
  state.dropAudio = true;
  sendJson({ type: 'interrupt' });
  document.body.classList.remove('thinking');
  return true;
}

function startSpeech({ barge = true } = {}) {
  if (barge && state.settings.bargeIn) bargeIn();
  state.speaking = true;
  state.guessed = false;
  state.belowFor = 0;
  state.aboveFor = 0;
  document.body.classList.add('hearing');
  for (const frame of state.preroll) send(frame);
  state.preroll = [];
}

function endSpeech() {
  state.speaking = false;
  state.dropAudio = false;
  state.belowFor = 0;
  document.body.classList.remove('hearing');
  document.body.classList.add('thinking');
  sendJson({ type: 'end' });
}

// ---------------------------------------------------------------- socket

const send = (pcm) => {
  if (state.ws?.readyState === 1) state.ws.send(pcm.buffer ?? pcm);
};
const sendJson = (obj) => {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj));
};

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => log('connected');
  ws.onclose = () => {
    log('disconnected — retrying');
    document.body.classList.remove('thinking', 'hearing', 'speaking');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => log('connection error');

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      if (state.dropAudio) return; // belongs to a reply that was interrupted
      return play(event.data);
    }
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'ready':
        $('who').textContent = msg.principalId;
        state.sessions = msg.sessions ?? [];
        renderRail();
        sendJson({ type: 'hello', tier: state.settings.tier, voice: state.settings.voice, model: state.settings.model });
        break;
      case 'session':
        state.session = msg.session;
        if (msg.session.model) $('model').value = msg.session.model;
        if (msg.session.tier) { tier.value = msg.session.tier; showTier(); }
        if (msg.sessions) state.sessions = msg.sessions;
        refreshSessions();
        log(msg.session.warm ? 'ready' : 'starting…');
        break;
      case 'heard': {
        document.body.classList.remove('thinking');
        bubble('me', msg.text);
        replyEl = null;
        log(`heard in ${msg.ms} ms`);
        break;
      }
      case 'note':
        bubble('note', msg.text);
        break;
      case 'ignored':
        // Visible but not spoken: you should be able to see that a noise was
        // heard and discarded, without it interrupting anything.
        document.body.classList.remove('thinking');
        bubble('note', `Ignored background noise${msg.text ? ` (heard "${msg.text}")` : ''}`);
        log('ignored a noise');
        break;
      case 'status':
        state.sessions = msg.sessions ?? state.sessions;
        renderRail();
        break;
      case 'dispatched':
        state.sessions = msg.sessions ?? state.sessions;
        renderRail();
        bubble('note', `Dispatched to ${msg.job.model}: ${msg.job.title}`);
        break;
      case 'text':
        if (!replyEl) replyEl = bubble('them', '');
        replyEl.textContent += msg.delta;
        $('transcript').scrollTop = $('transcript').scrollHeight;
        break;
      case 'tool':
        // A tool turn was measured at 42 seconds. Silence here reads as a
        // crash, so it gets a visible, and audible, placeholder.
        bubble('note', `running ${msg.name}…`);
        log(`running ${msg.name} — this can take a while`);
        break;
      case 'speak':
        log(`speaking (${msg.synthMs} ms)`);
        break;
      case 'interrupted':
        log('interrupted');
        break;
      case 'done':
        document.body.classList.remove('thinking');
        log(`done in ${msg.ms} ms`);
        replyEl = null;
        break;
      case 'error':
        document.body.classList.remove('thinking');
        bubble('note', msg.message);
        log(msg.message);
        break;
    }
  };
}

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions', { credentials: 'same-origin' });
    if (res.ok) { state.sessions = (await res.json()).sessions; renderRail(); }
  } catch { /* the rail is cosmetic; a failure here is not worth surfacing */ }
}

// ---------------------------------------------------------------- rail

function renderRail() {
  const rail = $('rail');
  rail.innerHTML = '';
  for (const s of state.sessions) {
    const el = document.createElement('button');
    el.className = `rail-item${s.id === state.session?.id ? ' active' : ''}`;
    // A work session's dot says whether it is still going, because that is the
    // only thing you actually want to know at a glance.
    const dot = s.busy ? ' busy' : (s.status === 'error' ? ' bad' : (s.warm ? ' warm' : ''));
    const meta = s.kind === 'work'
      ? `<em>${s.busy ? `working ${s.runningSeconds}s` : s.status}${s.lastTool ? ` · ${escapeHtml(s.lastTool)}` : ''}</em>`
      : '';
    el.innerHTML = `<span class="dot${dot}"></span>
      <span class="rail-title">${escapeHtml(s.title)}${meta}</span>
      ${s.kind === 'work' ? `<span class="badge">${escapeHtml(s.model.replace(/^claude-|-5.*$/g, ''))}</span>` : ''}`;
    el.onclick = () => { sendJson({ type: 'select', sessionId: s.id }); closeRail(); };
    rail.append(el);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const openRail = () => document.body.classList.add('rail-open');
const closeRail = () => document.body.classList.remove('rail-open');

// ---------------------------------------------------------------- mic

/**
 * Fail loudly instead of hanging.
 *
 * Every await below can stall indefinitely on a phone — a suspended audio
 * session, a permission prompt nobody answers, a worklet fetch on a dead
 * connection. A stalled promise leaves the button reading "Starting…" forever
 * with no error anywhere, which is indistinguishable from the app being
 * broken. A rejection at least says which step, and puts the button back.
 */
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
]);

/**
 * The one AudioContext, created once and kept for the life of the page.
 *
 * It used to be created fresh on every start and never closed, which leaked
 * one per start/stop cycle. Safari caps how many a page may have — four, in
 * practice — and the one past the cap neither resolves nor throws: the button
 * sat on "Starting…" and only a reload cleared it. That is the "it hangs, then
 * I reload and it works" report, and it got worse the more the app was used.
 *
 * Reusing it also removes a whole class of iOS problems, because the context
 * that playback is scheduled against no longer changes underneath it.
 */
async function audioContext() {
  if (!state.ctx) {
    state.ctx = new AudioContext();
    state.playCtx = state.ctx;
  }
  // 'interrupted' is iOS-only: a call, Siri, or another app took the audio
  // session. It and 'suspended' both come back with resume().
  if (state.ctx.state !== 'running') {
    await withTimeout(state.ctx.resume(), 4000, 'audio session');
  }
  return state.ctx;
}

async function startListening() {
  if (state.listening) return;
  // Presses arrive faster than the microphone opens. Without this, a second
  // press during a slow start opened a second stream and a second worklet, and
  // the first was never cleaned up.
  if (state.starting) return state.starting;
  state.starting = openMic().finally(() => { state.starting = null; });
  return state.starting;
}

/*
 * Bumped by every stop, so a start that is still in flight can tell that it has
 * been overtaken.
 *
 * Opening the microphone is several awaits long, and Stop can land in the
 * middle of it. The stop finds nothing to tear down - it has not been created
 * yet - and the start then runs to completion and reports itself as listening,
 * leaving a live microphone and the recording indicator on after the user
 * explicitly turned it off.
 */
let micEpoch = 0;

async function openMic() {
  const epoch = micEpoch;
  await audioContext();

  state.stream = await withTimeout(navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,  // without this the phone hears Claude and answers itself
      noiseSuppression: true,
      autoGainControl: true,
    },
  // Generous, because this is the step a person has to answer: it covers
  // finding and tapping Allow, not just the machine's part.
  }), 30_000, 'microphone permission');
  // Survived the prompt. From here on the press can open the microphone on
  // touch-down, because getUserMedia will not ask again.
  const firstTime = !micGranted;
  micGranted = true;
  try { localStorage.setItem(MIC_GRANTED, '1'); } catch { /* private mode */ }
  if (firstTime) {
    bubble('note', 'Microphone on. Just speak — or hold the Talk button and let '
      + 'go to send, which is the one to use in a noisy room.');
  }

  // Registered against the context, so it only needs doing once now that the
  // context is not thrown away between turns.
  if (!state.workletReady) {
    await withTimeout(state.ctx.audioWorklet.addModule('/capture-worklet.js'),
      10_000, 'audio worklet');
    state.workletReady = true;
  }
  if (epoch !== micEpoch) {
    // Stopped while this was opening. Hand the microphone straight back.
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    return;
  }
  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.ctx, 'capture');
  state.node.port.onmessage = (e) => onFrame(e.data.pcm, e.data.rms);
  state.source.connect(state.node);
  // Not connected to destination: routing the mic to the speaker would be a
  // feedback loop, and the worklet runs regardless.

  state.listening = true;
  document.body.classList.add('listening');
  $('mic').textContent = 'Stop';
  log('listening');
}

/*
 * Release the microphone, but keep the audio context.
 *
 * The context is deliberately left alive and running: it is capped per page on
 * Safari, and closing and recreating it is what caused the hang this is paired
 * with. Nothing is leaked by keeping it — the tracks are what hold the
 * microphone open, and stopping them is what turns the recording indicator off.
 */
function stopListening() {
  micEpoch += 1;
  state.listening = false;
  state.speaking = false;
  state.held = false;
  document.body.classList.remove('held');
  state.node?.port.close();
  state.node?.disconnect();
  // The source node was never disconnected, so every stop left one more of
  // them attached to the context feeding a worklet nobody read from.
  state.source?.disconnect();
  state.source = null;
  state.node = null;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  stopPlayback();
  document.body.classList.remove('listening', 'hearing', 'thinking', 'speaking');
  $('mic').textContent = 'Talk';
  log('stopped');
}

// ---------------------------------------------------------------- wiring

/*
 * One button, two ways to use it.
 *
 *   tap and let go   - hands-free. It listens, decides when you have finished,
 *                      answers, and keeps listening. Tap again to stop.
 *   press and hold   - push to talk. It records while your thumb is down and
 *                      sends the moment you lift it, then goes quiet.
 *
 * The hold is the reliable one, and it is worth being clear about why. Every
 * bug here that made the app feel broken - cutting off mid-sentence, taking a
 * turn because someone else spoke, hearing itself through the speaker - came
 * from guessing whether a sound was you. Holding the button removes the guess.
 * On a bus, in a room with other people, or on speakerphone, hold it.
 *
 * The microphone is opened on the press rather than when the hold is
 * recognised. Safari only grants getUserMedia inside a user gesture, and a
 * permission prompt raised from a timer 350 ms later is exactly what it
 * refuses. Opening it immediately is also what a tap wants, so the two paths
 * agree: the press starts the microphone, the release decides what it meant.
 */
const HOLD_MS = 350;
const mic = $('mic');
let holdTimer = null;
let pressedAt = 0;
// The pointer or key is still down. Needed because the microphone can become
// available after the press has already ended.
let pressing = false;
/*
 * The hold was asked for before the microphone existed.
 *
 * This is the first-run case and it is the whole reason this flag exists. On a
 * cold page the first press raises the browser's permission prompt, and
 * reaching **Allow** means lifting your finger off the button. That release
 * used to run the normal end-of-hold path, find no audio, and stop listening —
 * tearing down the very stream that was being granted. The first long press
 * therefore appeared to do nothing at all, while a plain tap first "fixed" it.
 *
 * So a hold is now only ever engaged against a live microphone. If the press
 * outlasts the timer while permission is still pending, the intent is
 * remembered here and honoured the moment the stream arrives — and if they let
 * go before then, it falls through to the tap path and stays listening.
 */
let pendingHold = false;

/*
 * Has this browser ever actually given us the microphone?
 *
 * It decides which of two routes the press takes, and the distinction matters
 * on iOS. Safari only treats a touch as a user gesture at the point the finger
 * *lifts*: a getUserMedia call made while the touch is still down does not
 * raise the permission prompt at all, and fails silently. A tap lifts straight
 * away and prompts fine; a long press does not, so going straight for the hold
 * on a cold page appeared to do nothing, while tapping once first "fixed" it
 * for good. That is exactly the reported symptom.
 *
 * So the first press never asks. It defers to the click that follows the
 * release — which is where the original tap-only version asked, and which is
 * known to work. Once permission exists getUserMedia no longer prompts, so
 * every press after this one can open the microphone immediately on touch-down
 * and lose nothing.
 *
 * Remembered in localStorage because Safari does not implement
 * `permissions.query({name: 'microphone'})`, so there is nothing else to ask.
 */
const MIC_GRANTED = 'foovox-mic-granted';
let micGranted = localStorage.getItem(MIC_GRANTED) === '1';
let needPermission = false;

// Where it is supported, this is better than our own memory: it survives a
// cleared localStorage and notices a permission revoked in browser settings.
navigator.permissions?.query({ name: 'microphone' })
  .then((p) => { micGranted = p.state === 'granted'; })
  .catch(() => { /* Safari, and Firefox for this name — localStorage stands */ });

const micFailed = (e) => {
  pendingHold = false;
  // Whatever we believed about permission was wrong, or it has been revoked.
  // Go back to asking on the click, which is the route that works everywhere.
  micGranted = false;
  localStorage.removeItem(MIC_GRANTED);
  mic.textContent = 'Talk';
  log(`microphone: ${e.message}`);
  bubble('note', `Microphone unavailable: ${e.message}. On iOS this needs HTTPS and a tap.`);
};

function engageHold() {
  holdTimer = null;
  pendingHold = false;
  state.held = true;
  state.heldFrames = 0;
  state.belowFor = 0;
  state.guessed = false;
  // Holding the button down is as explicit as an interruption gets, so this
  // does not wait on the talk-over setting. That setting exists to stop the
  // phone interrupting *itself*, which cannot happen when a thumb is the
  // trigger.
  bargeIn();
  document.body.classList.add('held');
  mic.textContent = 'Release to send';
  log('recording - release to send');
  navigator.vibrate?.(15);
}

function releaseHold() {
  state.held = false;
  document.body.classList.remove('held');
  if (state.heldFrames > 0) {
    endSpeech();
  } else {
    // Let go before the microphone produced anything - usually the very first
    // press, while the permission prompt was still up. Say so, rather than
    // sending an empty turn and surfacing "no audio received".
    state.speaking = false;
    document.body.classList.remove('hearing');
    log('too quick - hold it while you talk');
  }
  // A hold that started from idle is a one-shot and returns to idle. A hold
  // during a hands-free conversation is just a push-to-talk turn within it.
  if (!state.heldResume) stopListening();
  else { mic.textContent = 'Stop'; log('listening'); }
}

/*
 * Set while a press is being handled by pointer or key events, to stop the
 * `click` that follows from being counted as a second, separate tap.
 *
 * A physical interaction fires pointerdown, pointerup and *then* click, and a
 * keyboard one fires keydown, keyup and then click. Both need the click
 * ignored. It cannot simply be dropped, though — see the click handler.
 */
let pressHandled = false;
const handled = () => {
  pressHandled = true;
  // pointercancel is not always followed by a click, and a flag left set would
  // swallow the next keyboard activation. Long enough for the click, short
  // enough to be gone before anyone presses the key again.
  setTimeout(() => { pressHandled = false; }, 700);
};

function beginPress() {
  pressedAt = Date.now();
  pressing = true;
  pendingHold = false;
  needPermission = false;
  state.heldResume = state.listening;

  if (!state.listening && !micGranted) {
    /*
     * First time in this browser. Do not touch the microphone yet and do not
     * start the hold timer — asking now would not prompt on iOS, and a button
     * reading "Release to send" over a permission sheet is a lie either way.
     * The release hands this to the click handler, which asks properly.
     */
    needPermission = true;
    mic.textContent = 'Enable microphone';
    return;
  }

  if (!state.listening) {
    // Permission already exists, so this opens silently and instantly. Still
    // done on the press rather than a timer: Safari only grants getUserMedia
    // inside a gesture and would refuse one raised 350 ms later.
    mic.textContent = 'Starting…';
    startListening()
      // Permission may have taken a while to answer. If they are still holding
      // the button, that is still a hold, and it starts now.
      .then(() => { if (pressing && pendingHold) engageHold(); })
      .catch(micFailed);
  }
  holdTimer = setTimeout(() => {
    holdTimer = null;
    // Only ever hold against a live microphone; otherwise remember the intent.
    if (state.listening) engageHold();
    else pendingHold = true;
  }, HOLD_MS);
}

function endPress() {
  pressing = false;
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

  if (needPermission) {
    /*
     * Deliberately does *not* mark the press handled, so the click that
     * follows this release is allowed through to the click handler, which asks
     * for the microphone. On iOS that click is the first moment Safari will
     * raise the prompt at all.
     */
    needPermission = false;
    mic.textContent = 'Talk';
    return;
  }

  handled();
  if (state.held) { releaseHold(); return; }
  if (pendingHold) {
    /*
     * Held the button, but the microphone was still being authorised — so the
     * release was almost certainly them reaching for **Allow**, not them
     * finishing a sentence. There is nothing recorded to send, and stopping
     * would throw away the permission they just granted.
     *
     * Leave it listening. That is what the tap path would have done, and it
     * means going straight for the long press on a cold page ends somewhere
     * useful instead of doing nothing.
     */
    pendingHold = false;
    log('microphone ready — hold to talk, or just speak');
    return;
  }
  // A tap. If the press opened the microphone, that is the whole action and it
  // is now listening hands-free; if it was already listening, the tap stops it.
  if (state.heldResume && Date.now() - pressedAt < HOLD_MS) stopListening();
}

mic.addEventListener('pointerdown', (e) => {
  // Keep the release even if the thumb slides off the button, which over a
  // long hold it invariably does.
  mic.setPointerCapture?.(e.pointerId);
  beginPress();
});
mic.addEventListener('pointerup', endPress);
mic.addEventListener('pointercancel', endPress);

/*
 * The keyboard gets both modes too.
 *
 * A focused button turns Enter and Space into a `click`, and nothing else —
 * moving to pointer events alone silently made this button unusable without a
 * mouse, and unreachable to a screen reader. Holding the key repeats keydown,
 * so `repeat` is what separates a press from an autorepeat.
 */
mic.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  if (e.repeat) return;
  e.preventDefault(); // Space would scroll the transcript out from under it
  beginPress();
});
mic.addEventListener('keyup', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  endPress();
});

/*
 * The click after a release, and anything that reaches click without a press
 * behind it at all: assistive technology, and `element.click()` from a script
 * or a test. Treated as a tap, which is the only thing a click can reasonably
 * mean — and, on a first run, it is where the permission prompt comes from.
 */
mic.addEventListener('click', () => {
  if (pressHandled) { pressHandled = false; return; }
  if (state.listening) stopListening();
  else startListening().catch(micFailed);
});

/*
 * iOS suspends the audio session when the app goes to the background and does
 * not restore it on the way back. Without this, returning to the app left the
 * microphone wired to a context that had quietly stopped running: the meter
 * sat at zero and nothing was ever heard again until a reload.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.ctx && state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
});

// A long press on a button raises the selection callout on iOS and the context
// menu on Android, either of which lands on top of the thing being held.
mic.addEventListener('contextmenu', (e) => e.preventDefault());

$('new-session').onclick = () => {
  sendJson({ type: 'new', tier: state.settings.tier, model: state.settings.model });
  $('transcript').innerHTML = '';
  closeRail();
};

$('rail-toggle').onclick = () => document.body.classList.toggle('rail-open');
$('rail-scrim').onclick = closeRail;

const TIER_NOTES = {
  chat: 'It can talk, and nothing else. It cannot read, write or run anything.',
  read: 'It can read files on this machine and search the web. It changes nothing.',
  build: 'It can create and edit files inside its working directory.',
  full: 'It can run any command your user account can. Only on a machine where that is fine.',
};

const tier = $('tier');
const showTier = () => {
  $('tier-note').textContent = TIER_NOTES[tier.value] ?? '';
  $('tier-note').classList.toggle('danger', tier.value === 'full');
};
tier.value = state.settings.tier;
showTier();
tier.onchange = () => {
  state.settings.tier = tier.value;
  saveSettings();
  showTier();
  sendJson({ type: 'tier', tier: tier.value });
  bubble('note', `Permission set to ${tier.options[tier.selectedIndex].text}. ${TIER_NOTES[tier.value]}`);
};

$('send').onclick = () => {
  const text = $('typed').value.trim();
  if (!text) return;
  bubble('me', text);
  replyEl = null;
  state.dropAudio = false;
  document.body.classList.add('thinking');
  sendJson({ type: 'text', text });
  $('typed').value = '';
};
$('typed').onkeydown = (e) => { if (e.key === 'Enter') $('send').click(); };

const silence = $('silence');
silence.value = state.settings.silenceMs;
$('silence-value').textContent = `${state.settings.silenceMs} ms`;
silence.oninput = () => {
  state.settings.silenceMs = Number(silence.value);
  $('silence-value').textContent = `${silence.value} ms`;
  saveSettings();
};

const sens = $('sens');
sens.value = Math.round(state.settings.margin * 100);
$('sens-value').textContent = `${Math.round(state.settings.margin * 100)}%`;
sens.oninput = () => {
  state.settings.margin = Number(sens.value) / 100;
  // Show what it means, not just the number — "35%" told nobody anything.
  $('sens-value').textContent = Number(sens.value) <= 25 ? `${sens.value}% · easy`
    : Number(sens.value) >= 65 ? `${sens.value}% · speak up` : `${sens.value}%`;
  saveSettings();
};

// Long-press clears it: a calibration taken next to a blender should not be
// permanent, and there is no obvious other way back.
$('calibrate').oncontextmenu = (e) => {
  e.preventDefault();
  state.settings.noiseFloor = null;
  saveSettings();
  bubble('note', 'Calibration cleared.');
};

$('calibrate').onclick = async () => {
  if (state.calibrating) return;
  if (!state.listening) {
    try { await startListening(); } catch (e) { bubble('note', `Microphone: ${e.message}`); return; }
  }
  bubble('note', 'Stay quiet for three seconds.');
  $('calibrate').classList.add('busy');
  $('calibrate').textContent = 'Listening — stay quiet…';
  state.calibrating = { samples: [], until: Date.now() + 3000 };
};

const model = $('model');
model.value = state.settings.model;
model.onchange = () => {
  state.settings.model = model.value;
  saveSettings();
  // Changing the model replaces the process; the conversation survives via
  // --resume, so this is a swap of mind rather than a loss of memory.
  sendJson({ type: 'model', model: model.value });
  bubble('note', `Switched to ${model.options[model.selectedIndex].text.split(' —')[0]}. The conversation carries over.`);
};

const barge = $('barge');
barge.checked = state.settings.bargeIn;
barge.onchange = () => { state.settings.bargeIn = barge.checked; saveSettings(); };

/**
 * Control surface.
 *
 * The same actions the buttons perform, callable from the console or from a
 * test. Debugging voice on a phone is otherwise miserable — there is no
 * devtools on the device you are actually holding — and it lets the browser
 * tests drive the real paths rather than re-implementing them.
 */
window.foovox = {
  start: () => startListening(),
  stop: () => stopListening(),
  bargeIn,
  ask: (text) => {
    bubble('me', text);
    replyEl = null;
    state.dropAudio = false;
    sendJson({ type: 'text', text });
  },
  state,
};

// The meter needs to track speech, so it runs faster than the text readouts.
setInterval(() => {
  const level = meterPos(state.lastMic);
  const mark = state.lastThreshold === Infinity ? 1 : meterPos(state.lastThreshold);
  $('meter-fill').style.width = `${level * 100}%`;
  $('meter-thr').style.left = `${mark * 100}%`;
  $('meter-db').textContent = state.calibrating ? 'calibrating…' : db(state.lastMic);
  $('meter').classList.toggle('hot', level >= mark);
}, 50);

// Jobs run detached, so the rail has to poll to stay honest about them.
setInterval(() => { if (document.body.classList.contains('rail-open')) refreshSessions(); }, 3000);

setInterval(() => {
  $('d-mic').textContent = db(state.lastMic);
  $('d-thr').textContent = state.lastThreshold === Infinity ? 'holding' : db(state.lastThreshold);
  $('d-floor').textContent = db(state.level.floor);
  $('d-hold').textContent = db(state.level.holdThreshold(state.settings.margin));
  // Blank until enough speech has been heard for the estimate to mean
  // anything — showing a number that is not yet real is worse than a dash.
  $('d-voice').textContent = state.level.learned ? db(state.level.speech) : 'learning…';
  $('d-cpl').textContent = state.echo.coupling.toFixed(2);
  $('d-lag').textContent = `${Math.round(state.echo.lag * 1000)} ms`;
  $('d-cut').textContent = String(state.cutoffs);
}, 200);

connect();
refreshSessions();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
}

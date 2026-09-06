/**
 * Double-talk detection from the reference signal.
 *
 * The problem this solves: on speakerphone the microphone hears the
 * loudspeaker, so a plain loudness threshold cannot tell Claude's voice from
 * yours. It interrupts itself, transcribes its own sentence and answers it —
 * a feedback loop that from the outside is "choppy, and I could not get a word
 * in".
 *
 * Two tempting fixes are worse than they look:
 *
 *   - **Match the transcript.** Transcribing the microphone and comparing it
 *     to what Claude is saying needs a full pass of speech-to-text before it
 *     can decide, about a second, and has nothing to compare against when
 *     somebody cuts in mid-word.
 *   - **Watermark the speech.** A high-frequency mark cannot survive this
 *     pipeline at all: the microphone is downsampled to 16 kHz for Whisper, so
 *     by Nyquist nothing above 8 kHz exists to be detected. Lower than that
 *     and a phone's noise suppression and automatic gain remove it.
 *
 * Neither is needed, because the exact samples being played are already in
 * hand. Record their loudness envelope against the audio clock, then judge the
 * microphone relative to what the speaker is known to be emitting right then:
 *
 *   output loud  -> demand the microphone exceed the echo it could produce
 *   output quiet -> the echo term vanishes, so normal sensitivity
 *
 * The second case is the one that makes it fast. Speech is full of gaps —
 * between every word and sentence the output is silent — and energy heard in
 * a gap cannot be echo. Interruptions land in those gaps constantly, so they
 * are caught at full sensitivity within a frame, with no added latency.
 *
 * `coupling`, the fraction of output that returns, is learned rather than
 * assumed: a hand-held phone on speaker leaks far more than AirPods, and the
 * same code should suit both without a setting.
 */

export const ECHO_MARGIN = 1.8;   // how far above predicted echo counts as a person
export const ECHO_MEMORY = 3;     // seconds of envelope worth keeping
// Opening of a reply spent measuring the room instead of judging it. Long
// enough to catch a few syllables of echo; short enough that interrupting the
// first sentence still feels possible.
export const HOLD_OFF = 0.7;
// How far above the measured echo peak a person has to be.
export const PEAK_MARGIN = 1.6;
/*
 * The loudest the bar may ever be, as a fraction of the user's own voice.
 *
 * Without a ceiling the bar is set by the echo, and on a speakerphone that can
 * be louder than the person — at which point interrupting is impossible at any
 * volume. Below their normal level, so a slightly raised voice always clears
 * it.
 */
export const REACHABLE = 0.75;

export class EchoModel {
  constructor({ margin = ECHO_MARGIN, frameMs = 20 } = {}) {
    this.margin = margin;
    this.frameMs = frameMs;
    this.clips = [];
    // Start pessimistic: assume a leaky speakerphone until measurement says
    // otherwise. Guessing low would let the first reply trigger a false
    // interruption before anything had been learned.
    this.coupling = 0.6;
    // Measured delay from emitting a sound to hearing it back. Starts at a
    // typical mobile output latency and is corrected by measurement.
    this.lag = 0.06;
    this.micLog = [];
    this.startedAt = null;
    this.peak = 0;
    /*
     * Whether the lag has actually been measured for this reply.
     *
     * The two safety properties pull against each other. Letting the guard
     * relax in the gaps is what makes interruption possible; keeping it flat is
     * what survives a badly wrong lag, because with the wrong offset a "gap" is
     * exactly where the microphone is hearing a syllable. So the gaps only open
     * once correlation has found the delay — until then, the flat guard holds.
     */
    this.lagMeasured = false;
  }

  reset() {
    this.clips = [];
    this.micLog = [];
    this.startedAt = null;
    this.peak = 0;
    this.lagMeasured = false;
  }

  /** Record the loudness envelope of a buffer scheduled to start at `at`. */
  remember(samples, sampleRate, at) {
    const step = Math.max(1, Math.round(sampleRate * (this.frameMs / 1000)));
    const env = new Float32Array(Math.ceil(samples.length / step));
    for (let i = 0; i < env.length; i += 1) {
      const from = i * step;
      const to = Math.min(from + step, samples.length);
      let sum = 0;
      for (let j = from; j < to; j += 1) sum += samples[j] * samples[j];
      env[i] = Math.sqrt(sum / Math.max(1, to - from));
    }
    this.clips.push({ at, env, step: step / sampleRate });
  }

  /** Envelope value at an absolute time, or 0 if nothing is scheduled then. */
  at(t) {
    for (const clip of this.clips) {
      const i = Math.floor((t - clip.at) / clip.step);
      if (i >= 0 && i < clip.env.length) return clip.env[i];
    }
    return 0;
  }

  /**
   * What our own speaker is emitting, as the microphone hears it now.
   *
   * Narrow, and offset by a measured lag. The first version of this took the
   * maximum across a 180 ms window to cover an unknown delay, and that was
   * self-defeating: gaps between words are 50–200 ms, so a window that wide
   * smears across them and always finds a loud syllable. The gaps are the
   * entire point — energy heard in one cannot be echo — so a window that
   * erases them erases the mechanism. Measure the lag instead of padding for
   * it, and keep the window tight enough that a gap survives.
   */
  expected(now) {
    const centre = now - this.lag;
    let peak = 0;
    for (let d = -0.03; d <= 0.03; d += 0.01) {
      const v = this.at(centre + d);
      if (v > peak) peak = v;
    }
    this.clips = this.clips.filter((c) => c.at + c.env.length * c.step > now - ECHO_MEMORY);
    return peak;
  }

  /**
   * Learn how much of our output returns, by tracking the *minimum* ratio.
   *
   * An earlier version moved an average towards whatever it saw, and a person
   * talking over the reply taught it that the echo was enormous — after which
   * they could never be heard again. A person can only ever *add* energy to
   * the microphone, never remove it, so the smallest ratio observed while our
   * speaker is loud is the cleanest available estimate of echo alone.
   *
   * Falls quickly and rises very slowly: a quiet moment reveals the true
   * coupling and should be believed, while someone shouting over it should
   * barely move the estimate at all.
   */
  observe(micRms, output) {
    if (!(output > 0.01)) return this.coupling;
    const observed = micRms / output;
    const rate = observed < this.coupling ? 0.25 : 0.002;
    this.coupling += (observed - this.coupling) * rate;
    this.coupling = Math.min(2, Math.max(0.01, this.coupling));
    return this.coupling;
  }

  /**
   * Measure the delay between emitting a sound and hearing it.
   *
   * Output buffering, the speaker, the air and the microphone together add
   * anywhere from about 20 ms to well over 100 ms, and it differs per device —
   * `outputLatency` is not reported by every browser. Rather than assume a
   * worst case and blur the gaps away, correlate the microphone's recent
   * loudness against our own and take the lag that lines them up.
   */
  estimateLag(now) {
    if (this.micLog.length < 40) return this.lag;
    let bestLag = this.lag;
    let best = 0;
    for (let lag = 0; lag <= 0.2; lag += 0.01) {
      let score = 0;
      for (const { t, rms } of this.micLog) {
        if (t < now - 1.5) continue;
        score += rms * this.at(t - lag);
      }
      if (score > best) { best = score; bestLag = lag; }
    }
    // Move gently: a single bad estimate should not swing the whole model.
    if (best > 0) {
      this.lag += (bestLag - this.lag) * 0.4;
      this.lagMeasured = true;
    }
    return this.lag;
  }

  /** Feed the microphone's loudness in, for lag estimation. */
  pushMic(t, rms) {
    this.micLog.push({ t, rms });
    while (this.micLog.length && this.micLog[0].t < t - 2) this.micLog.shift();
  }

  /** The loudness a frame must exceed to count as a person, not our own echo. */
  threshold(base, output) {
    return Math.max(base, output * this.coupling * this.margin);
  }

  /**
   * A new reply has begun. Start a fresh measurement of the room.
   *
   * Everything above depends on knowing the lag between emitting a sound and
   * hearing it, and at the instant playback starts that is exactly what is not
   * known yet — the estimator has no correlated history to work from. A wrong
   * lag predicts silence where the microphone is hearing a syllable, and the
   * first word Claude says is read as an interruption. Reported from a real
   * phone as "the moment it started talking it cut itself off".
   *
   * So the opening of every reply is a listening period rather than a
   * decision: barge-in is held off, and whatever the microphone picks up is
   * taken as a clean sample of echo alone, since the person cannot yet be
   * responding to a sentence they have not heard.
   */
  startPlayback(now) {
    this.startedAt = now;
    this.peak = 0;
    // The delay is re-confirmed per reply; the device may have changed.
    this.lagMeasured = false;
  }

  /** Loudest thing heard while it could only have been echo. */
  notePeak(rms) {
    if (rms > this.peak) this.peak = rms;
  }

  inHoldOff(now) {
    return this.startedAt !== null && (now - this.startedAt) < HOLD_OFF;
  }

  /**
   * The bar for calling something a person, while our own speaker is going.
   *
   * Two corrections here, both from being unable to interrupt at all on a
   * speakerphone.
   *
   * **The peak guard only applies while sound is actually coming out.** It
   * used to be a flat floor for the whole reply, which quietly destroyed the
   * one property the whole design rests on: in a gap between words there is no
   * echo to guard against, so the bar must fall back to normal. A constant
   * floor meant the gaps stopped being openings.
   *
   * **The bar can never exceed a level the person can reach.** On speaker the
   * echo peak is loud, and 1.6x it can sit above the user's own voice — so the
   * bar was set by how loud *Claude* is, and no amount of shouting could clear
   * it. Now that the user's speaking level is measured, it is a ceiling:
   * whatever the echo is doing, a normal raised voice always gets through.
   * Interrupting a loud reply in a quiet room may then be a false positive
   * occasionally, which is a far better failure than not being able to
   * interrupt at all.
   *
   * `voice` is the learned level of the user's own speech, or 0 if unknown.
   */
  guard(base, output, now, voice = 0) {
    if (this.inHoldOff(now)) return Infinity; // not a decision yet

    // Only relax in the gaps once the delay is known. With an unmeasured lag a
    // "gap" may be exactly where the microphone is hearing a syllable.
    const emitting = output > 0.01 || !this.lagMeasured;
    const measured = emitting ? this.peak * PEAK_MARGIN : 0;
    let bar = Math.max(this.threshold(base, output), measured);

    if (voice > 0) bar = Math.min(bar, Math.max(base, voice * REACHABLE));
    return bar;
  }
}

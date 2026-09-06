/**
 * Where the bar sits between the room and your voice.
 *
 * The first version had one number: a noise floor, and a threshold some
 * multiple above it. Two things were wrong with that, and both showed up
 * immediately on a real phone in a real room.
 *
 * **The floor fell back the moment you stopped talking.** It was an
 * exponential average with a 400 ms time constant, so half a second after your
 * last word it had settled back onto room noise and the bar came down with it.
 * Someone talking across the room then cleared it and took a turn.
 *
 * **The sensitivity control did nothing.** The threshold was
 * `max(floor * sensitivity, 0.008)`. In a quiet room the floor is around
 * 0.001, so `floor * sensitivity` was below the 0.008 hard minimum across
 * almost the whole slider — every position produced the same threshold.
 *
 * So this tracks *two* levels: the room when nobody is talking, and **you**
 * when you are. The bar sits between them, which is what someone means when
 * they say "put it just below where I'm talking and leave it there".
 *
 *   quiet room ──────────── bar ──────────── your voice
 *                          ▲
 *                  margin decides where
 *
 * The point of measuring your voice is that it does not fall away between
 * sentences: it decays over about a minute, not half a second, so the bar
 * stays where your speech put it while you pause to think.
 */

/** Learned levels are meaningless until this much speech has been heard. */
const MIN_SPEECH_FRAMES = 15; // 300 ms

/*
 * How much lower the bar sits once you are already talking.
 *
 * A quiet syllable in ordinary speech runs around a third of the peak of the
 * same sentence, so the bar that keeps a turn open has to be well under the one
 * that opens it — otherwise every unstressed word looks like you stopping.
 */
const HOLD_RATIO = 0.35;

export class LevelModel {
  constructor({ frameMs = 20 } = {}) {
    this.frameMs = frameMs;
    this.floor = 0.005;
    this.speech = 0;
    this.speechFrames = 0;
    // A hard minimum so digital silence cannot produce a zero threshold that
    // every sample clears. Deliberately low: it is a backstop, not the design.
    this.absoluteMin = 0.002;
  }

  /**
   * A frame with nobody talking.
   *
   * Falls quickly and rises slowly, so the estimate follows the quiet parts of
   * the room rather than being dragged up by every passing noise. A floor that
   * chased the loudest thing it heard would raise the bar until nothing could
   * trigger it, which is the opposite failure.
   */
  observeQuiet(rms) {
    const rate = rms < this.floor ? 0.08 : 0.01;
    this.floor += (rms - this.floor) * rate;
    this.floor = Math.max(this.floor, 1e-5);
    // Speech is remembered across pauses, but not across a whole conversation.
    // ~0.999 per 20 ms frame is a little under a minute to fall by half.
    if (this.speech > 0) this.speech *= 0.9993;
    return this.floor;
  }

  /**
   * A frame that is confirmed to be the user talking.
   *
   * Rises quickly and holds: the loud parts of speech are what the bar should
   * sit below, and one quiet syllable should not drag the estimate down to
   * where the room can reach it.
   */
  observeSpeech(rms) {
    const rate = rms > this.speech ? 0.2 : 0.01;
    this.speech += (rms - this.speech) * rate;
    this.speechFrames = Math.min(this.speechFrames + 1, 10_000);
    return this.speech;
  }

  /** Has enough speech been heard for the learned level to mean anything? */
  get learned() {
    return this.speechFrames >= MIN_SPEECH_FRAMES && this.speech > this.floor * 1.5;
  }

  /**
   * The loudness a frame must exceed to *continue* an utterance already under
   * way.
   *
   * Speech has enormous dynamic range. The learned level tracks the loud parts
   * — that is what makes it a useful reference — but the quiet syllables in the
   * same sentence sit far below it, often under a third of the peak. Judging
   * continuation against the same bar that starts a turn meant that speaking at
   * anything less than full volume dropped under it mid-sentence and ended the
   * turn.
   *
   * So it takes more to begin than to keep going. Standard hysteresis, and the
   * two failures it resolves are the two that were reported: background noise
   * starting a turn, and a normal speaking voice being cut off part-way
   * through one.
   */
  holdThreshold(margin = 0.35) {
    return this.threshold(margin * HOLD_RATIO);
  }

  /**
   * The loudness a frame must exceed to *start* being counted as speech.
   *
   * `margin` is 0..1 — how far from the room towards your voice the bar sits.
   * Low means twitchy, high means you have to speak up. Before your voice has
   * been measured there is nothing to interpolate towards, so it falls back to
   * a multiple of the floor, and that multiple is derived from the same
   * control so the slider still does something on the very first utterance.
   */
  threshold(margin = 0.35) {
    const m = Math.min(0.95, Math.max(0.05, margin));
    if (!this.learned) {
      // 2x at the low end, 9x at the high end — a usable range in a quiet room,
      // where the old fixed floor made every slider position identical.
      return Math.max(this.floor * (2 + m * 8), this.absoluteMin);
    }
    return Math.max(this.floor + (this.speech - this.floor) * m, this.absoluteMin);
  }

  /** Everything the meter and the diagnostics need, in one call. */
  view(margin) {
    return {
      floor: this.floor,
      speech: this.speech,
      learned: this.learned,
      threshold: this.threshold(margin),
      hold: this.holdThreshold(margin),
    };
  }

  /** Forget the learned voice — a different room, or a different person. */
  reset() {
    this.speech = 0;
    this.speechFrames = 0;
  }
}

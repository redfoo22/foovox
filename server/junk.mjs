/**
 * Was that actually somebody talking?
 *
 * The endpoint detector decides *something* made a noise. Whisper then has to
 * turn that noise into words, and on silence or a non-speech sound it does not
 * return nothing — it hallucinates, and it hallucinates the same handful of
 * phrases every time, because they are what padded the end of its training
 * clips. "Thank you." "you" "Thanks for watching!" A bird outside becomes a
 * turn, that turn goes to the model, and the conversation is now about
 * something nobody said.
 *
 * That is worse than it sounds. It is not just a wasted turn: it puts a
 * sentence into the conversation history that the person never uttered, and
 * every later answer is conditioned on it. From their side the assistant
 * appears to lose the thread for no reason.
 *
 * So a transcript has to clear a bar before it is allowed to become a turn.
 * The bar is deliberately low — the cost of dropping a real short utterance is
 * that they say "yes" again, and the cost of accepting a hallucinated one is a
 * derailed conversation.
 */

/*
 * Whisper's silence hallucinations, which are remarkably consistent.
 *
 * Matched whole-string only. "Thank you" alone is noise; "thank you, that
 * worked" is a person, and the length check below lets it through anyway.
 */
const HALLUCINATIONS = [
  'thank you', 'thanks', 'thanks for watching',
  'you', 'oh', 'um', 'uh', 'hmm', 'mm', 'mhm',
  // "Bye." is one of Whisper's most frequent inventions on silence, and
  // nothing is lost by ignoring a real one — this is a coding assistant, not a
  // phone call.
  'bye', 'goodbye',
  'so', 'the', 'a', 'i', 'and', 'but', 'well',
  'please subscribe', 'like and subscribe', 'see you next time',
  'subtitles by the amara.org community', 'transcription by castingwords',
  'copyright', 'music', 'applause', 'silence', 'blank_audio',
];

/*
 * Words that are both common hallucinations and real answers.
 *
 * "okay" means "yes, go ahead" as often as it means nothing, so it is never
 * dropped outright — only when the audio is far longer than the word, which is
 * the signature of noise being mis-heard rather than someone agreeing.
 */
const AMBIGUOUS = ['okay', 'ok', 'yeah', 'yep', 'right', 'sure'];

/** Punctuation-only, or bracketed sound tags like [BLANK_AUDIO] and (music). */
const NON_SPEECH = /^[\s\p{P}\p{S}]*$|^[[(<][^\])>]*[\])>]$/u;

const normalise = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[\p{P}\p{S}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Should this transcript be allowed to become a turn?
 *
 * `seconds` is how much audio produced it, which is the strongest signal
 * available: a real sentence takes time, and a quarter-second of bird is not
 * one however confidently it was transcribed.
 */
export function isJunk(text, seconds = 0) {
  const raw = String(text ?? '').trim();
  if (!raw) return { junk: true, why: 'nothing was transcribed' };
  if (NON_SPEECH.test(raw)) return { junk: true, why: 'no words, only punctuation or a sound tag' };

  const clean = normalise(raw);
  if (!clean) return { junk: true, why: 'no words after punctuation was removed' };

  const words = clean.split(' ').filter(Boolean);

  /*
   * Too short to have been a sentence, whatever the words were.
   *
   * Half a second is under a syllable and a half of natural speech. Anything
   * transcribed from less than that was invented.
   */
  if (seconds > 0 && seconds < 0.5) {
    return { junk: true, why: `only ${seconds.toFixed(2)}s of audio` };
  }

  // A known hallucination, exactly and entirely.
  if (words.length <= 4 && HALLUCINATIONS.includes(clean)) {
    return { junk: true, why: `"${raw}" is what Whisper says about silence` };
  }

  /*
   * A single filler word out of several seconds of audio is a mis-hearing.
   *
   * Restricted to the hallucination list, and that restriction matters: the
   * first version dropped any short word from long audio, which threw away a
   * real "yes" — the single worst thing to lose, since it is how someone
   * agrees to something. "yes", "no", "go" and "stop" are never dropped on
   * length, whatever the audio.
   *
   * Two seconds, not one and a half, for the same reason: a drawn-out "okaaay"
   * is a real answer.
   */
  if (words.length === 1 && (HALLUCINATIONS.includes(clean) || AMBIGUOUS.includes(clean))
    && seconds > 2.0) {
    return { junk: true, why: `"${raw}" alone out of ${seconds.toFixed(1)}s of audio` };
  }

  return { junk: false };
}

export const NOISE_PHRASES = HALLUCINATIONS;

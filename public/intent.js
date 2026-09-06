/**
 * The two spoken commands that are not questions for Claude.
 *
 * Deliberately a short list of explicit phrases rather than anything
 * open-ended. Getting a status wrong costs a wasted sentence; getting a
 * dispatch wrong starts a Claude with tools armed on the wrong task, on the
 * machine that also runs a live website. So the bar is: it must be something
 * you would not say by accident in the middle of a normal conversation.
 *
 * "Build me a parser" is a request to Claude, not a dispatch. "Code that in
 * Opus" is a dispatch. The difference is the explicit naming of a model, or
 * an explicit word like "dispatch".
 */

const MODELS = [
  [/\bopus\b/i, 'claude-opus-5'],
  [/\bfable\b/i, 'claude-fable-5'],
  [/\bsonnet\b/i, 'claude-sonnet-5'],
  [/\bhaiku\b/i, 'claude-haiku-4-5-20251001'],
];

// "how's it going", "status", "what's the status", "how are the jobs"
const STATUS = [
  /^\s*(?:hey[, ]+)?(?:give me (?:a|the) )?status\b/i,
  /^\s*what'?s? (?:the )?status\b/i,
  // "how's it going" and "how are the jobs coming" — both verbs, both subjects.
  /^\s*how(?:'?s|\s+is|\s+are)?\s+(?:it|that|things|the jobs?|everything|we|you)\s+(?:going|coming|doing|getting on)\b/i,
  /^\s*(?:are (?:you|we)|is it) (?:still )?(?:working|running|going)\b/i,
  /^\s*what (?:are you|is it) (?:working on|doing)\b/i,
];

/*
 * A dispatch must (a) name a model and (b) say something that means "go and
 * do this". Both, not either: "let's use Opus for this" is a preference, and
 * "go build it" without a model is a request to the session you are talking to.
 */
const DO_IT = /\b(code|build|write|implement|make|do|run|start|work on|knock out|dispatch|kick off)\b/i;
const REFERS = /\b(it|this|that|the project|the thing|those)\b/i;
const IN_MODEL = /\b(?:in|with|using|on)\s+(opus|fable|sonnet|haiku)\b/i;

export function detectIntent(text) {
  const said = String(text ?? '').trim();
  if (!said) return null;

  for (const re of STATUS) if (re.test(said)) return { type: 'status' };

  // "code it in Opus", "build that with Fable", "dispatch this to Opus"
  if (IN_MODEL.test(said) && DO_IT.test(said) && REFERS.test(said)) {
    return { type: 'dispatch', model: modelFrom(said), hint: hintFrom(said) };
  }
  // "dispatch this" — explicit enough on its own; defaults to Opus.
  if (/\b(dispatch|kick off a job|start a job|new job)\b/i.test(said)) {
    return { type: 'dispatch', model: modelFrom(said) ?? 'claude-opus-5', hint: hintFrom(said) };
  }
  return null;
}

export function modelFrom(said) {
  for (const [re, id] of MODELS) if (re.test(said)) return id;
  return null;
}

/** Anything after "to"/"for" that narrows the task, e.g. "…in Opus, focus on the parser". */
function hintFrom(said) {
  const m = /(?:focus(?:ing)? on|especially|specifically|and)\s+(.{4,120})$/i.exec(said);
  return m ? m[1].replace(/[.!?]+$/, '').trim() : '';
}

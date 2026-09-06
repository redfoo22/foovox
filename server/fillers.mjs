/**
 * Something to say while it goes and does something.
 *
 * A tool call is the one part of a turn with no upper bound. Reading a file is
 * instant; a web search is seconds; a shell command was measured at 42. Until
 * it finishes there is nothing to speak, so the line goes quiet — and silence
 * from something that was talking a moment ago reads as a crash, not as work.
 *
 * Every voice assistant fills that gap, and they all randomise it, because the
 * same six words on every single tool call stops sounding like a person within
 * about three turns.
 *
 * Two rules that matter more than the wording:
 *
 *   1. **Never repeat the last one.** Randomness that can immediately repeat
 *      is heard as a stuck loop, not as variety.
 *   2. **Say it once per turn.** A turn with four tool calls should not
 *      narrate all four; the first one sets the expectation and the rest are
 *      just noise over the top of thinking.
 */

/** Generic, for tools with nothing interesting to say about them. */
const GENERIC = [
  'Let me check that.',
  'One moment.',
  'Give me a second.',
  'Let me look that up.',
  'Checking now.',
  'Hang on, looking into it.',
  'Let me find out.',
  'On it.',
];

/*
 * Per-tool lines, so it says something true rather than something vague.
 *
 * "Let me search the web" while it searches the web is worth more than "one
 * moment", because it tells you what the wait is for — and therefore roughly
 * how long to expect.
 */
const BY_TOOL = {
  WebSearch: ['Let me search for that.', 'Searching the web now.', 'Let me look that up online.'],
  WebFetch: ['Let me pull that page up.', 'Fetching that now.'],
  Read: ['Let me read that.', 'Opening the file now.', 'Let me take a look.'],
  Glob: ['Let me find those files.', 'Having a look through the files.'],
  Grep: ['Let me search through the code.', 'Searching the files now.'],
  Write: ['Writing that now.', 'Let me put that together.'],
  Edit: ['Making that change now.', 'Let me edit that.'],
  NotebookEdit: ['Updating the notebook now.'],
  Bash: ['Running that now.', 'Let me run that.', 'Give me a second, running it.'],
  PowerShell: ['Running that now.', 'Let me run that.'],
  Task: ['Let me work through that.', 'Starting on that now.'],
  Agent: ['Let me work through that.', 'Starting on that now.'],
};

/**
 * A source of filler lines that does not repeat itself.
 *
 * One per session rather than one global: two people talking to two sessions
 * should not hear their phrasing correlate, and "never repeat the last one"
 * only means anything per conversation.
 */
export function makeFillers({ random = Math.random } = {}) {
  let last = null;
  let saidThisTurn = false;

  return {
    /**
     * A line for a tool that has just started, or null if one has already been
     * said this turn.
     */
    forTool(name) {
      if (saidThisTurn) return null;
      saidThisTurn = true;

      const pool = BY_TOOL[name] ?? GENERIC;
      // Fall back to the generic set rather than repeat, when a per-tool list
      // is a single line and that line was the last thing said.
      const choices = pool.filter((line) => line !== last);
      const from = choices.length ? choices : GENERIC.filter((line) => line !== last);
      const picked = from[Math.floor(random() * from.length)] ?? GENERIC[0];
      last = picked;
      return picked;
    },

    /** A new turn: the next tool call may speak again. */
    newTurn() {
      saidThisTurn = false;
    },

    /** Exposed for tests. */
    get lastSaid() { return last; },
  };
}

export const FILLER_LINES = { GENERIC, BY_TOOL };

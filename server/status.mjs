/**
 * Turning what the machine is doing into a sentence someone can hear.
 *
 * A status readout has a hard constraint a dashboard does not: it is *spoken*,
 * so it cannot be skimmed, scrolled or glanced at. Three work sessions read out
 * in full is thirty seconds of talking to learn one thing. So this reports the
 * shape first — how many, how many still going — and detail only for what is
 * actually running.
 */

const AGO = (seconds) => {
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
};

const FOR = (seconds) => {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.round(seconds / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
};

/** Model names as a person says them, not as the CLI spells them. */
export function spokenModel(id) {
  if (/opus/.test(id)) return 'Opus';
  if (/fable/.test(id)) return 'Fable';
  if (/haiku/.test(id)) return 'Haiku';
  if (/sonnet/.test(id)) return 'Sonnet';
  return id;
}

/**
 * Make a work session's own words safe to read aloud.
 *
 * A job's output is written for a screen. Quoted into speech unchanged it
 * produced: "the write to backtick C colon backslash Users backslash alex…"
 * — a full Windows path spelled out one character at a time. Paths, code
 * spans and backticks all have to go before anything is spoken.
 */
function speakable(text) {
  return String(text)
    // Absolute paths, Windows or POSIX, become just the filename. The
    // character class has to include a literal backslash or the Windows case —
    // the one that actually happened — slips straight through.
    .replace(/(?:[A-Za-z]:)?[\\/][\w.@$%~+-]+(?:[\\/][\w.@$%~+-]+)*/g,
      (m) => m.split(/[\\/]/).filter(Boolean).pop() || 'a file')
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/[—–]/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short quotable phrase from a session's own words, ending in a full stop. */
function gist(view) {
  const source = speakable(view.summary || view.title || '');
  if (!source) return null;
  const sentence = /^[\s\S]{0,160}?[.!?](?=\s|$)/.exec(source);
  let out = (sentence ? sentence[0] : source.slice(0, 120)).trim();
  // Truncation leaves a fragment, and a fragment with no stop runs straight
  // into whatever is said next — "It said: I'll create Finished 2 minutes ago".
  if (!/[.!?]$/.test(out)) out = `${out.replace(/[,;:]$/, '')}.`;
  return out;
}

/**
 * Build the spoken status report.
 *
 * `current` is the session doing the asking; it is excluded, because "and
 * you are talking to me" is not news.
 */
export function statusReport(views, currentId = null) {
  const jobs = views.filter((v) => v.kind === 'work' && v.id !== currentId);
  if (!jobs.length) return 'Nothing is running. No work sessions have been started.';

  const working = jobs.filter((v) => v.busy);
  const failed = jobs.filter((v) => v.status === 'error');
  const finished = jobs.filter((v) => !v.busy && v.status === 'done');

  const parts = [];
  const count = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
  parts.push(working.length
    ? `${count}, ${working.length} still running.`
    : `${count}, all finished.`);

  for (const job of working) {
    const bits = [`${spokenModel(job.model)} has been working for ${FOR(job.runningSeconds)}`];
    if (job.lastTool) bits.push(`last used ${job.lastTool}`);
    const what = gist(job);
    parts.push(`${bits.join(', ')}.${what ? ` It said: ${what}` : ''}`);
  }

  for (const job of failed) {
    parts.push(`One job on ${spokenModel(job.model)} failed${job.error ? `: ${job.error.slice(0, 120)}` : '.'}`);
  }

  // Finished work is the thing you actually wanted; say what it concluded.
  for (const job of finished.slice(-2)) {
    const what = gist(job);
    parts.push(`Finished ${AGO(job.idleSeconds)} on ${spokenModel(job.model)}.${what ? ` ${what}` : ''}`);
  }

  return parts.join(' ');
}

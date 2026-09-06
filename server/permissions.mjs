/**
 * What a session is allowed to do.
 *
 * This started as one boolean — tools on or off — which is the wrong shape.
 * "Read my code and tell me what is wrong with it" and "rewrite my code" are
 * very different levels of trust, and collapsing them means anyone who wants
 * the first has to grant the second.
 *
 * The tiers are ordered and each is a superset of the one before, so a person
 * can reason about them without reading this file: chat cannot touch anything,
 * read cannot change anything, build cannot leave its directory, full can run
 * commands.
 *
 * The default is `chat`, and that is deliberate. This runs on somebody's own
 * machine, reachable from their phone. If a pairing code leaks, the difference
 * between the default being `chat` and the default being `full` is the
 * difference between a stranger having a conversation and a stranger having a
 * shell.
 */

/*
 * Allow-lists, and everything else is denied.
 *
 * This was a deny-list of ten tool names, and it was dangerously wrong. The
 * real installation exposes **32** tools, including `PowerShell` — a shell
 * that is not called `Bash`. Denying `Bash,Task` left PowerShell untouched, so
 * the `chat` tier, documented as unable to read, write or run anything, had a
 * working shell: it read a file and ran a command in testing.
 *
 * A deny-list has exactly the wrong default. Anything it has not heard of is
 * permitted, so every tool added to Claude Code silently widens every tier.
 * These are allow-lists instead, and the deny list handed to the CLI is
 * computed as *everything the runtime reports minus what this tier allows* —
 * so an unknown tool is denied by construction.
 */
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

/*
 * The fallback used if the runtime has not been asked what it has.
 *
 * Only a safety net: `discoverTools()` replaces it with the truth. Kept
 * deliberately broad — naming shells and delegation tools that have actually
 * been seen — because if discovery fails, over-denying costs a feature and
 * under-denying costs a shell.
 */
export const KNOWN_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Write', 'Edit', 'NotebookEdit',
  'Bash', 'PowerShell', 'Task', 'Agent', 'Skill', 'Workflow', 'ToolSearch',
  'EnterWorktree', 'ExitWorktree', 'Monitor', 'DesignSync',
  'CronCreate', 'CronDelete', 'CronList',
  'PushNotification', 'RemoteTrigger', 'SendMessage', 'ReportFindings',
  'ScheduleWakeup', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput',
  'TaskStop', 'TaskUpdate', 'TodoWrite', 'ExitPlanMode', 'BashOutput', 'KillShell',
];

/** Replaced at startup by whatever the CLI actually reports. */
let runtimeTools = [...KNOWN_TOOLS];

export function setRuntimeTools(names) {
  if (Array.isArray(names) && names.length) {
    // Union, never replace: a tool the runtime omits today but exposes under
    // some other configuration should still be denied by the lower tiers.
    runtimeTools = [...new Set([...KNOWN_TOOLS, ...names])];
  }
  return runtimeTools;
}

export const allTools = () => [...runtimeTools];

export const TIERS = {
  chat: {
    order: 0,
    label: 'Chat',
    summary: 'Conversation only. It cannot read, write or run anything.',
    detail: 'Safe to expose to anyone you would let use your phone. Good for '
      + 'thinking out loud, rubber-ducking, and asking questions.',
    allow: [],
  },
  read: {
    order: 1,
    label: 'Read',
    summary: 'It can look at files and search the web. It cannot change anything.',
    detail: 'Good for "what does this code do" and "why is this failing". '
      + 'Nothing on disk is modified, but be aware it can read any file the '
      + 'account running it can read.',
    allow: [...READ_TOOLS, ...WEB_TOOLS],
  },
  build: {
    order: 2,
    label: 'Build',
    summary: 'It can create and edit files inside its working directory.',
    detail: 'The level dispatched jobs use. Edits are auto-approved because '
      + 'nobody is at the keyboard to approve them, so the working directory '
      + 'is the boundary that matters — point it at a project, not your home '
      + 'folder.',
    allow: [...READ_TOOLS, ...WEB_TOOLS, ...WRITE_TOOLS],
    // `acceptEdits` auto-approves file changes and nothing else, which is
    // exactly this tier: it can write, and it still cannot run a command.
    mode: 'acceptEdits',
  },
  full: {
    order: 3,
    label: 'Full',
    summary: 'Everything, including running shell commands.',
    detail: 'It can run any command your user account can run: install things, '
      + 'delete things, reach the network, read your credentials. Only grant '
      + 'this on a machine where that is genuinely acceptable, and remember '
      + 'that a leaked pairing code inherits it.',
    allow: null, // everything; see tierArgs
    /*
     * `bypassPermissions`, not `acceptEdits`.
     *
     * This tier claimed to allow everything while passing `acceptEdits`, which
     * only auto-approves file edits. Bash, WebSearch and WebFetch still hit the
     * permission gate, and with nobody at a keyboard to approve them they were
     * denied — so a user who deliberately chose Full was told "I don't have
     * permission to use WebSearch". A permission tier that does not grant what
     * it says it grants is worse than one that grants too little, because the
     * person has already decided to trust it.
     */
    mode: 'bypassPermissions',
    dangerous: true,
  },
};

export const TIER_NAMES = Object.keys(TIERS);
export const DEFAULT_TIER = 'chat';

export function isTier(name) {
  return Object.prototype.hasOwnProperty.call(TIERS, name);
}

export function normaliseTier(name) {
  if (isTier(name)) return name;
  // The old boolean, so existing clients and stored settings keep working.
  if (name === true) return 'build';
  if (name === false || name == null) return DEFAULT_TIER;
  return DEFAULT_TIER;
}

/**
 * The command-line arguments a tier implies.
 *
 * Denying by name rather than allowing by name, deliberately: a future version
 * of Claude Code that adds a new tool should have it *denied* under `chat`
 * rather than silently permitted because our allow-list had not heard of it.
 */
export function tierArgs(name) {
  const tier = TIERS[normaliseTier(name)];
  // `allow: null` means no restriction at all — the only tier that gets it.
  const denied = tier.allow === null
    ? []
    : allTools().filter((t) => !tier.allow.includes(t));
  const args = [];

  /*
   * Both lists, deliberately, because they do different jobs.
   *
   * The deny list is a hard block: those tools cannot run whatever the mode
   * says. The allow list is what stops the permitted ones from needing an
   * approval nobody is present to give — without it, a tier that says it can
   * search the web hits the permission gate and reports "I don't have
   * permission to use WebSearch". That happened twice: once on Full, once on
   * Read. Naming both is what makes a tier mean what it claims.
   */
  if (tier.allow?.length) args.push('--allowed-tools', tier.allow.join(','));
  if (denied.length) args.push('--disallowed-tools', denied.join(','));
  if (tier.mode) args.push('--permission-mode', tier.mode);
  return args;
}

/** True if `name` grants at least as much as `atLeast`. */
export function tierAllows(name, atLeast) {
  return TIERS[normaliseTier(name)].order >= TIERS[normaliseTier(atLeast)].order;
}

/** A sentence describing a tier, for speaking aloud or showing in the UI. */
export function describeTier(name) {
  const tier = TIERS[normaliseTier(name)];
  return `${tier.label}: ${tier.summary}`;
}

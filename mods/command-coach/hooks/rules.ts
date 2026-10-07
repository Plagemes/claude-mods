/** What the session has shown so far; every rule reads these and nothing else. */
export type Signals = {
  /** Commands whose output was very long. */
  longOutputs: number
  /** `git commit` commands Claude ran. */
  commits: number
  /** Prompts asking Claude to run the tests, the linter or the build. */
  testPrompts: number
  /** Permission dialogs shown. */
  permissionPrompts: number
  /** Different files Claude changed. */
  editedFiles: number
  /** Tool calls that failed. */
  failures: number
  /** How full the context window is, 0 to 100, when known. */
  contextPercent?: number
  /** How long the session has been running. */
  minutes: number
}

export type Rule = {
  id: string
  /** The mod the tip recommends; the rule is skipped when it is already installed. */
  mod?: string
  /** Commands that mod registers, another sign it is installed. */
  commands?: readonly string[]
  isDue: (signals: Signals) => boolean
  tip: (signals: Signals) => string
}

export const THRESHOLDS = {
  contextPercent: 70,
  longOutputs: 3,
  commits: 3,
  testPrompts: 3,
  minutes: 120,
  permissionPrompts: 6,
  editedFiles: 10,
  failures: 5,
} as const

const LONG_OUTPUT_CHARS = 6000
const LONG_OUTPUT_LINES = 120

const hours = (minutes: number): string => {
  const whole = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  if (whole === 0) return `${rest} min`
  return rest === 0 ? `${whole} h` : `${whole} h ${rest} min`
}

/** In priority order: when several rules are due, the first one speaks. */
export const RULES: readonly Rule[] = [
  {
    id: 'compact',
    isDue: s => (s.contextPercent ?? 0) >= THRESHOLDS.contextPercent,
    tip: s =>
      `The context window is ${Math.round(s.contextPercent ?? 0)}% full. /compact summarizes the conversation and frees space; add instructions after it to say what to keep.`,
  },
  {
    id: 'output-trimmer',
    mod: 'output-trimmer',
    isDue: s => s.longOutputs >= THRESHOLDS.longOutputs,
    tip: s => `${s.longOutputs} commands printed very long output and all of it went into the context. The output-trimmer mod keeps the head, tail and error lines.`,
  },
  {
    id: 'commit-composer',
    mod: 'commit-composer',
    commands: ['commit', 'compose-commit'],
    isDue: s => s.commits >= THRESHOLDS.commits,
    tip: s => `${s.commits} commits so far. The commit-composer mod's /commit writes a Conventional Commit message from your staged diff and commits it.`,
  },
  {
    id: 'quick-commands',
    mod: 'quick-commands',
    commands: ['t'],
    isDue: s => s.testPrompts >= THRESHOLDS.testPrompts,
    tip: s => `You have asked Claude to run the tests, linter or build ${s.testPrompts} times. The quick-commands mod gives you /t, /l and /b, which run them and fix what fails.`,
  },
  {
    id: 'long-session',
    mod: 'resume-brief',
    commands: ['resume-brief'],
    isDue: s => s.minutes >= THRESHOLDS.minutes,
    tip: s => `This session has run for ${hours(s.minutes)}. A fresh start with /clear is cheaper and sharper than a very long conversation; the resume-brief mod then shows what you were working on.`,
  },
  {
    id: 'permissions',
    isDue: s => s.permissionPrompts >= THRESHOLDS.permissionPrompts,
    tip: s => `Claude has asked for approval ${s.permissionPrompts} times. /permissions pre-allows the commands you trust, and shift+tab switches to accept-edits mode.`,
  },
  {
    id: 'diff',
    isDue: s => s.editedFiles >= THRESHOLDS.editedFiles,
    tip: s => `Claude has changed ${s.editedFiles} files. /diff shows all uncommitted changes in one place.`,
  },
  {
    id: 'error-feed',
    mod: 'error-feed',
    isDue: s => s.failures >= THRESHOLDS.failures,
    tip: s => `${s.failures} tool calls have failed so far. The error-feed mod collects every failure in one pane, and /rewind goes back if Claude took a wrong turn.`,
  },
]

export const installLine = (mod: string): string => `Install it: /plugin marketplace add plagemes/claude-mods, then /plugin install ${mod}@claude-mods`

/** The rules whose condition holds, in priority order. */
export const dueRules = (signals: Signals): Rule[] => RULES.filter(rule => rule.isDue(signals))

/** The tip as shown: its sentence, and for a mod the line that installs it. */
export const messageOf = (rule: Rule, signals: Signals): string =>
  rule.mod === undefined ? rule.tip(signals) : `${rule.tip(signals)} ${installLine(rule.mod)}`

export type Installed = { plugins: ReadonlySet<string>; commands: ReadonlySet<string> }

export const isInstalled = (rule: Rule, installed: Installed): boolean =>
  rule.mod !== undefined && (installed.plugins.has(rule.mod) || (rule.commands ?? []).some(name => installed.commands.has(name)))

const TEST_PROMPT =
  /\b(?:run|rerun|re-run|execute)\s+(?:(?:the|all|my|those|these|our|unit|integration|e2e|test|tests|again)\s+)*(?:tests?|test\s+suite|specs?|lint(?:er|ing)?|build|type-?check(?:er|ing)?)\b/i

/** Does a prompt ask Claude to run the tests, the linter or the build? */
export const isTestPrompt = (text: string): boolean => TEST_PROMPT.test(text)

const GIT_COMMIT = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit(?![\w-])/

export const isGitCommit = (command: string): boolean => GIT_COMMIT.test(command)

/** Is this command output long enough to matter for the context? */
export const isLongOutput = (text: string): boolean => text.length >= LONG_OUTPUT_CHARS || text.split('\n').length >= LONG_OUTPUT_LINES

/** A one-line summary of the signals, for /coach. */
export const summary = (s: Signals): string =>
  [
    `${s.longOutputs} long outputs`,
    `${s.commits} commits`,
    `${s.testPrompts} test-run prompts`,
    `${s.permissionPrompts} approvals`,
    `${s.editedFiles} files changed`,
    `${s.failures} failures`,
    s.contextPercent === undefined ? 'context unknown' : `context ${Math.round(s.contextPercent)}%`,
    hours(s.minutes),
  ].join(' · ')

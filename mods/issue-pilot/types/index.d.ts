/** Where the issues come from. Pull requests always go through the GitHub CLI. */
export type IssuePilotProvider = 'github' | 'jira' | 'linear'

/** How much model the work needs, as smart-router names it: light → haiku, standard → sonnet, deep → opus. */
export type IssuePilotTier = 'light' | 'standard' | 'deep'

/** How much work: a few lines, a small feature, several areas, a project. */
export type IssuePilotSize = 'S' | 'M' | 'L' | 'XL'

export type IssuePilotEstimate = {
  tier: IssuePilotTier
  size: IssuePilotSize
  /** Rough wall time with Claude doing the work, in minutes. */
  minutes: number
  /** Rough model spend on the tier's model, in US dollars. */
  usd: number
  tokens: number
  /** The model smart-router would pick for the tier. */
  model: string
  /** Why: the signals that decided the tier. */
  reason: string
}

export type IssuePilotIssue = {
  provider: IssuePilotProvider
  /** The tracker's id for API calls: the GitHub number, the Jira key, the Linear uuid. */
  id: string
  /** What people call it: `#12`, `SHOP-12`, `ENG-42`. */
  ref: string
  /** The number part a branch carries: `12`, `shop-12`, `eng-42`. */
  number: string
  title: string
  body: string
  url: string
  labels: string[]
  milestone: string | null
  state: string
  /** Story points or a Linear estimate, when the tracker has one. */
  points: number | null
  estimate: IssuePilotEstimate
}

export type IssuePilotFilters = { isMine: boolean; label: string; milestone: string }

export type IssuePilotList = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  provider: IssuePilotProvider | null
  /** The trackers this project can use, for the switch. */
  available: IssuePilotProvider[]
  items: IssuePilotIssue[]
  error: string | null
}

export type IssuePilotTestRun = {
  command: string
  outcome: 'passed' | 'failed' | 'error' | 'skipped'
  passed: number | null
  failed: number | null
  /** `✓ 12 passed`, `no test command found`. */
  summary: string
  /** The last lines of the output, for a failure. */
  tail: string
}

/**
 * working: Claude has the prompt; testing: the finish runs the tests; ready: the PR is composed and waits for
 * a click; shipping: commit, push, PR; done: the draft PR is open; failed: a step failed (see `error`).
 */
export type IssuePilotPhase = 'working' | 'testing' | 'ready' | 'shipping' | 'done' | 'failed'

export type IssuePilotActive = {
  issue: IssuePilotIssue
  branch: string
  /** The id its task.started / task.finished events carry. */
  taskId: string
  startedAt: number
  phase: IssuePilotPhase
  /** What happened, newest last: shown in the tab. */
  log: string[]
  /** What finished it: the person's click or autopilot. */
  signal: 'click' | 'autopilot' | null
  tests: IssuePilotTestRun | null
  prTitle: string
  prBody: string
  commitMessage: string
  prUrl: string | null
  error: string | null
  /** The latest CI outcome for the branch, from ci-watch through the hub. */
  ci: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'issue-pilot': {
      list: IssuePilotList
      filters: IssuePilotFilters
      active: IssuePilotActive | null
      /** The issue whose details are unfolded in the list. */
      selected: string | null
      /** The last action's outcome or problem, one line. */
      note: string
    }
  }
}

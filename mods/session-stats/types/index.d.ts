/** Token counts summed over every model request of the session, subagents included. */
export type SessionStatsTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** What the session has done so far, as the /session-stats dashboard shows it. */
export type SessionStatsData = {
  /** Prompts submitted, by the person or for them. */
  prompts: number
  /** Main-loop turns that ended. */
  turns: number
  /** Calls per tool name. */
  tools: Record<string, number>
  toolErrors: number
  tokens: SessionStatsTokens
  /** Files changed by Edit, Write, MultiEdit or NotebookEdit, absolute. */
  filesEdited: string[]
  /** What /usage reports the session has cost; null where the host keeps no ledger. */
  costUsd: number | null
  /** When the session began and when the figures were last taken, from `$.clock.now()`. */
  startedAt: number | null
  takenAt: number | null
  /** Time spent inside main-loop turns. */
  busyMs: number
}

/** What mods-hub's events add to the dashboard: test runs, the hub's turn and tool counts, and its priced session cost. */
export type SessionStatsHub = {
  /** `test.result` events seen, and how many of them were not a pass. */
  runs: number
  failedRuns: number
  lastRun: { runner: string; outcome: string; passed: number | null; failed: number | null } | null
  /** `turn.finished` events seen, and the tool calls they report. */
  turns: number
  tools: number
  /** The latest `cost.update`: the session's cost and the last turn's, as the hub priced them. */
  sessionUsd: number | null
  turnUsd: number | null
  isEstimate: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: SessionStatsData; hub: SessionStatsHub }
  }
}

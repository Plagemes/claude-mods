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

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: SessionStatsData }
  }
}

export type BashHistoryOutcome = 'ok' | 'failed' | 'denied'

export type BashHistoryEntry = {
  /** When the command was started, in milliseconds since the epoch. */
  at: number
  command: string
  outcome: BashHistoryOutcome
  /** How long the Bash tool call took, in milliseconds. */
  ms: number
}

declare module 'claude-code' {
  interface PluginState {
    'bash-history': { entries: BashHistoryEntry[] }
  }
}

export type TurnTimerStats = {
  /** Finished (not interrupted) turns of the main conversation. */
  count: number
  totalMs: number
  lastMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'turn-timer': { stats: TurnTimerStats }
  }
}

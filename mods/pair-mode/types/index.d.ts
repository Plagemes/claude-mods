/** Pair mode for this session, as the band and the guards read it. */
export type PairModeSession = {
  isOn: boolean
  /** The worktree snapshot (a git tree id) the next `/pair check` diffs against; null outside git or before one is taken. */
  baseline: string | null
  /** What the baseline is: when pair mode started, the last review, or none yet (HEAD is used). */
  since: 'start' | 'review' | 'head'
  /** A check is gathering the diff. */
  isChecking: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pair-mode': { session: PairModeSession }
  }
}

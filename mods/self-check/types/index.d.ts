/** The verdict on one editing turn, shown in the band above the prompt while it has gaps. */
export type SelfCheckFinding = {
  turnId: string
  /** The request that turn answered, cut to one line. */
  request: string
  /** What is still missing, one short sentence each. */
  gaps: string[]
  /** The gaps were already sent back to Claude (auto mode). */
  isSentToFix: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'self-check': { finding: SelfCheckFinding | null }
  }
}

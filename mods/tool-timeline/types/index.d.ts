/** How a recorded tool call stands. */
export type ToolTimelineOutcome = 'running' | 'ok' | 'error' | 'denied'

/** One tool call on the timeline. */
export type ToolTimelineCall = {
  id: string
  tool: string
  /** The input in a few words: the command, the path, the pattern. */
  summary: string
  /** Milliseconds since the epoch, from `$.clock.now()`. */
  startedAt: number
  endedAt: number | null
  outcome: ToolTimelineOutcome
  /** Set when a subagent made the call. */
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'tool-timeline': {
      calls: ToolTimelineCall[]
      /** When the timeline began: the session's start, or its last clear. */
      origin: number | null
      isErrorsOnly: boolean
    }
  }
}

/** One failed tool call as the feed keeps it. */
export type ToolError = {
  /** The call's tool_use_id. */
  id: string
  tool: string
  /** The call's input in one line: a command, a path, a pattern. */
  summary: string
  /** The start of the error as the model read it. */
  error: string
  exitCode?: number
  at: number
  agentId?: string
  isSent?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'error-feed': { errors: ToolError[] }
  }
}

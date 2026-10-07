/** Where a subagent stands: the engine's AgentStatus, or `ended` once the engine dropped it. */
export type AgentRowStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'ended'

/** One subagent as the pane lists it. */
export type AgentRow = {
  id: string
  type: string
  description: string
  status: AgentRowStatus
  name?: string
  model?: string
  startedAt: number
  endedAt?: number
  lastActivity?: string
  lastActivityAt?: number
  toolCount: number
  tokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': { agents: AgentRow[]; now: number }
  }
}

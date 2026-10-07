export type CompactCoachMilestone = 'commit' | 'tests'

export type CompactCoachState = {
  /** Finished turns of the main conversation. */
  turns: number
  /** The turn number a suggestion was last shown on. */
  lastCoachedTurn: number | null
  /** What the last substantive tool call of the current turn was, when it ended a task. */
  milestone: CompactCoachMilestone | null
  /** Items of the last TodoWrite list that are not completed. */
  openTodos: number
  /** Ids of tasks (TaskCreate) not yet completed or deleted. */
  openTasks: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'compact-coach': { coach: CompactCoachState }
  }
}

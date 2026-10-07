/** One of the three lines of investigation, and the agent working on it. */
export type ParallelExploreAngle = {
  title: string
  focus: string
  status: 'waiting' | 'running' | 'done' | 'failed'
  agentId?: string
  /** The agent type that took it: the built-in `Explore`, or this mod's read-only scout. */
  agentType?: string
  startedAt?: number
  finishedAt?: number
  report?: string
  error?: string
}

/** The latest /explore of this session. */
export type ParallelExploreRun = {
  id: number
  question: string
  phase: 'planning' | 'exploring' | 'merging' | 'done' | 'failed'
  angles: ParallelExploreAngle[]
  startedAt: number
  finishedAt?: number
  /** The merged answer, Markdown with file references. */
  answer?: string
  /** True when the answer is the reports side by side because merging failed. */
  isUnmerged?: boolean
  error?: string
  showReports: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'parallel-explore': {
      run: ParallelExploreRun | null
      /** Ids of the agents this mod started, held to read-only tools. */
      agents: string[]
    }
  }
}

// project-brain's session state: what the Brain panel (its own pane, or its tab in the Claude Mods panel) draws.

/** One memory that fired on the last recall, as the panel's "Active now" shows it. */
export type BrainActive = { id: string; kind: string; text: string; activation: number; score: number }

/** The headline numbers of the brain. */
export type BrainStatsView = {
  isLoaded: boolean
  nodes: number
  edges: number
  knowledge: number
  pinned: number
  /** Feedback samples the ranker learnt from, and its accuracy over the last ones (null before any). */
  samples: number
  accuracy: number | null
  /** Whether the learnt network takes part in ranking yet (after enough samples). */
  isLearnt: boolean
  lastSleep: number
  /** Memories told to Claude this session. */
  injected: number
}

declare module 'claude-code' {
  interface PluginState {
    'project-brain': {
      active: BrainActive[]
      stats: BrainStatsView
      /** Bumped when the graph changes, so the panel redraws. */
      rev: number
      query: string
      editing: string | null
      focus: string | null
    }
  }
}

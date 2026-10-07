// context-optimizer's session state: what the Context tab (or the /ctx pane without mods-hub) and the band draw.

export type ContextOptimizerFill = { percent: number; tokens: number; window: number; at: number }

export type ContextOptimizerSaved = {
  /** Estimated tokens kept out of the context, all session. */
  tokens: number
  trimmed: number
  trimmedTokens: number
  deduped: number
  dedupedTokens: number
}

/** Estimated tokens each tool, and each file read, added since the last compaction. */
export type ContextOptimizerContributors = { byTool: Record<string, number>; byFile: Record<string, number> }

export type ContextOptimizerCompaction = {
  at: number
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute'
  tokensBefore?: number
  tokensAfter?: number
  /** The boundary it was suggested at, when context-optimizer suggested it. */
  reason?: string
  hasCarry: boolean
}

export type ContextOptimizerSuggestion = { reason: string; focus: string; percent: number; at: number }

export type ContextOptimizerCarry = {
  at: number
  turn: number
  decisions: string[]
  todos: string[]
  files: string[]
  tests?: string
  branch?: string
}

/** The tab's switches for this session (the mod's settings stay the default). */
export type ContextOptimizerPrefs = { autoCompact: boolean; trim: boolean; dedupe: boolean; carryOver: boolean }

export type ContextOptimizerCategory = { name: string; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'context-optimizer': {
      fill: ContextOptimizerFill | null
      saved: ContextOptimizerSaved
      contributors: ContextOptimizerContributors
      history: ContextOptimizerCompaction[]
      suggestion: ContextOptimizerSuggestion | null
      /** The carry-over taken before the last compaction, and whether it still waits for the next prompt. */
      carry: ContextOptimizerCarry | null
      isCarryPending: boolean
      prefs: ContextOptimizerPrefs | null
      /** The window by category, as /context counts it, read when the tab was opened. */
      categories: ContextOptimizerCategory[] | null
    }
  }
}

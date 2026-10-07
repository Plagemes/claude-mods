/** One file the last editing turn changed. */
export type ExplainFile = {
  /** Relative to the project root. */
  path: string
  status: 'modified' | 'added' | 'deleted'
  added: number
  removed: number
  /** The unified diff from its first hunk on (`@@ ...`), cut when very long; '' for a file too large to diff. */
  diff: string
}

/** The last turn that changed files: what was asked, what Claude said, and the diffs. */
export type ExplainChange = {
  id: string
  request: string
  answer: string
  endedAt: number
  files: ExplainFile[]
}

export type ExplainLevel = 'beginner' | 'expert'

export type ExplainFileNote = { what: string; why: string; risks: string; test: string }

/** The explanation shown in the pane, for one change at one level. */
export type Explanation = {
  /** Identifies one request, so a slower, older answer never overwrites a newer one. */
  requestId: string
  changeId: string
  level: ExplainLevel
  status: 'working' | 'ready' | 'failed'
  summary: string
  /** Per file, by path. */
  notes: Record<string, ExplainFileNote>
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'explain-diff': {
      change: ExplainChange | null
      explanation: Explanation | null
      /** Paths whose diff is unfolded in the pane. */
      shown: string[]
    }
  }
}

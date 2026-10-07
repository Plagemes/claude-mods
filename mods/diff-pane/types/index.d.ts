/** One changed file against HEAD: `?` is untracked. */
export type DiffPaneFile = {
  path: string
  status: 'M' | 'A' | 'D' | 'T' | '?'
  adds: number
  dels: number
  isBinary: boolean
}

/** What the Changes pane draws. */
export type DiffPaneView = {
  repo: string | null
  files: DiffPaneFile[]
  /** The file whose diff is shown, and that diff (unified, possibly cut at a hunk). */
  selected: string | null
  diff: string | null
  updatedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'diff-pane': { view: DiffPaneView }
  }
}

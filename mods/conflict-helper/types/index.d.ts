/** One unmerged file and how many conflict blocks are still in it. */
export type ConflictHelperFile = { path: string; hunks: number }

/** A one-line outcome the pane shows. */
export type ConflictHelperNotice = { text: string; tone: 'info' | 'success' | 'error' }

/** What the Conflicts pane draws, and what the system prompt section reads. */
export type ConflictHelperView = {
  repo: string | null
  /** `merge`, `rebase`, `cherry-pick` or `revert` while one is stopped on conflicts. */
  operation: string | null
  files: ConflictHelperFile[]
  notice: ConflictHelperNotice | null
}

declare module 'claude-code' {
  interface PluginState {
    'conflict-helper': { view: ConflictHelperView }
  }
}

/** The pull request description being drafted, as the pane draws it. */
export type PrDescriberDraft = {
  phase: 'idle' | 'generating' | 'ready' | 'error'
  /** The repository's top-level folder; null before /pr-desc ran. */
  repo: string | null
  /** The base the branch is compared with (`origin/main`). */
  base: string
  branch: string
  commitCount: number
  /** `git diff --stat`'s last line. */
  summary: string
  title: string
  /** GitHub Markdown. */
  body: string
  error: string | null
  /** The pull request template followed, if any. */
  templateSource: string | null
  hasUncommitted: boolean
  /** When the description was written (ms); a later `git.commit` on the branch makes it stale (mods-hub). */
  draftedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-describer': { draft: PrDescriberDraft }
  }
}

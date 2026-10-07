/** The commit being composed, as the Commit pane draws it. */
export type CommitComposerDraft = {
  phase: 'idle' | 'generating' | 'ready' | 'editing' | 'committing' | 'done' | 'error'
  /** The repository's top-level folder; null before /commit ran. */
  repo: string | null
  /** "4 files · +120 −14" */
  summary: string
  /** `git diff --cached --name-status` lines, the first few. */
  files: string[]
  message: string
  /** What commitlint would likely reject; shown, never blocking. */
  problems: string[]
  error: string | null
  /** "<short sha> <subject>" once committed. */
  committed: string | null
  /** The commitlint config the rules came from, if any. */
  rulesSource: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'commit-composer': { draft: CommitComposerDraft }
  }
}

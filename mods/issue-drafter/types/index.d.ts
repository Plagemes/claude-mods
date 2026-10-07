export type IssueDraftState = {
  status: 'drafting' | 'ready' | 'creating' | 'created' | 'error'
  kind: 'bug' | 'feature'
  title: string
  /** The issue body, Markdown. */
  body: string
  /** What the person asked the draft to focus on, kept for Redraft. */
  focus: string
  /** Progress or the error from gh. */
  note: string
  /** The created issue's URL. */
  url?: string
}

declare module 'claude-code' {
  interface PluginState {
    'issue-drafter': { draft: IssueDraftState | null }
  }
}

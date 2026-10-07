/** One prompt as sent: its text (cut past a length, then `isCut`), when, and from which project root. */
export type PromptHistoryEntry = { text: string; at: number; project: string; isCut?: true }

/** What the pane shows: the search, its scope, and the newest matches. */
export type PromptHistoryView = {
  query: string
  scope: 'all' | 'project'
  project: string
  results: PromptHistoryEntry[]
  matched: number
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-history': { view: PromptHistoryView | null }
  }
}

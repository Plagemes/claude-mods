export type HandoffView = {
  status: 'writing' | 'ready' | 'error'
  /** The note as saved. */
  text: string
  /** Where it was saved, relative to the project root. */
  path: string
  isCopied: boolean
  /** Progress, the error, or a warning about missing sections. */
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { view: HandoffView | null }
  }
}

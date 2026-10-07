export type StandupView = {
  status: 'working' | 'ready' | 'empty' | 'error'
  /** The paste-ready standup, or the message for empty and error. */
  text: string
  /** What it was built from, e.g. "5 commits since Mon 6 Oct · written by haiku". */
  detail: string
  /** The window it covers, so Regenerate asks for the same. */
  days: number
}

declare module 'claude-code' {
  interface PluginState {
    standup: { view: StandupView | null }
  }
}

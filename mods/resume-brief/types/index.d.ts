/** Where a session left off, saved per project and shown when the next one starts. */
export type Brief = {
  /** The session it describes; not shown again when that same session is resumed. */
  sessionId: string
  /** When it was saved, in milliseconds since the epoch. */
  savedAt: number
  /** The git branch at the time, '' outside a repository. */
  branch: string
  /** The person's last requests, oldest first (at most three). */
  prompts: string[]
  /** Files edited, relative to the project root, most recent last. */
  files: string[]
  /** Todos still open in the last todo list. */
  todos: string[]
  /** The opening line of Claude's last answer. */
  lastAnswer: string
}

declare module 'claude-code' {
  interface PluginState {
    'resume-brief': { brief: Brief | null; isHidden: boolean }
  }
}

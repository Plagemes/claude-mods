export type TodoTrackerItem = {
  /** The main-conversation turn that added it. */
  turn: number
  /** Project-relative path when the file is inside the project. */
  file: string
  /** 1-based line in the file after the change; null when it could not be located. */
  line: number | null
  marker: string
  /** The line's text, trimmed and cut. */
  text: string
}

export type TodoTrackerState = {
  /** Main-conversation turns started so far. */
  turn: number
  items: TodoTrackerItem[]
}

declare module 'claude-code' {
  interface PluginState {
    'todo-tracker': { tracker: TodoTrackerState }
  }
}

/** One line of a followed log, colors stripped: its place in the stream and how it reads. */
export type LogTailLine = { n: number; text: string; kind: 'error' | 'warning' | 'info' }

/** What a tail follows: a file, a container, or a compose service. */
export type LogTailSource = 'file' | 'docker' | 'compose'

/** Where a tail is in its life. */
export type LogTailStatus = 'following' | 'ended' | 'stopped' | 'failed'

/** One tail as its pane draws it, beside its lines. */
export type LogTailView = {
  id: string
  source: LogTailSource
  /** What was followed, as the person named it: a path, a container, a service. */
  target: string
  /** The command that follows it, for the header. */
  command: string
  status: LogTailStatus
  /** How it ended, or a hint (a file that does not exist yet). */
  note: string | null
  /** The text the lines are filtered by: a substring, or /regex/flags. */
  filter: string
  isErrorsOnly: boolean
  isPaused: boolean
  /** Lines read since it started, and how many of them were errors. */
  total: number
  errors: number
  /** Lines read while paused, not drawn yet. */
  unseen: number
}

/** A tail in the list `/tail` prints and the status line counts. */
export type LogTailEntry = { id: string; target: string; source: LogTailSource; status: LogTailStatus }

declare module 'claude-code' {
  interface PluginState {
    'log-tail': { tails: LogTailEntry[]; view: StateFamily<LogTailView | null>; lines: StateFamily<LogTailLine[]> }
  }
}

/** A task waiting for the shift. */
export type ShiftTask = { id: string; text: string }

export type ShiftOutcome = 'done' | 'interrupted' | 'failed' | 'timed-out'

/** How one task of a shift went. */
export type ShiftResult = {
  id: string
  text: string
  outcome: ShiftOutcome
  startedAt: number
  durationMs: number
  /** Files the task changed, relative to the project root. */
  files: string[]
  /** The start of Claude's last answer for the task. */
  summary: string
}

/** The task Claude is working on now. */
export type ShiftCurrent = { id: string; text: string; startedAt: number; turnId?: string }

/** A shift under way. */
export type ShiftRun = {
  startedAt: number
  /** YYYY-MM-DD of the start, local time: the report's name. */
  date: string
  /** The report file, relative to the project root. */
  reportPath: string
  /** HEAD when the shift started, to diff the night's work against; '' outside git. */
  base: string
  tasks: ShiftTask[]
  results: ShiftResult[]
  current: ShiftCurrent | null
  /** Set once the shift is to end after the current task, with why. */
  stopReason: string
}

/** What the morning toast and the pane say of the last shift. */
export type ShiftReport = {
  path: string
  startedAt: number
  endedAt: number
  done: number
  total: number
  /** Why it ended: all tasks ran, a limit, you took over, it could not start. */
  reason: string
  results: ShiftResult[]
  isSeen: boolean
}

export type ShiftView = {
  tasks: ShiftTask[]
  /** When the next shift starts (epoch ms), or null when none is scheduled. */
  at: number | null
  run: ShiftRun | null
  last: ShiftReport | null
}

declare module 'claude-code' {
  interface PluginState {
    'night-shift': { view: ShiftView }
  }
}

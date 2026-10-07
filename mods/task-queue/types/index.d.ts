/** A prompt waiting its turn. */
export type QueueItem = { id: string; text: string; addedAt: number }

/** The queued prompt Claude is working on now. */
export type QueueRunning = QueueItem & {
  startedAt: number
  /** The main-loop turn it runs as, once that turn started. */
  turnId?: string
}

export type QueueOutcome = 'done' | 'interrupted' | 'failed' | 'dropped'

/** A queued prompt that has run (or could not). */
export type QueueFinished = { id: string; text: string; outcome: QueueOutcome; endedAt: number; durationMs?: number }

export type QueueView = {
  items: QueueItem[]
  isPaused: boolean
  /** Why the queue paused, shown in the pane and the status line. */
  pauseReason: string
  running: QueueRunning | null
  /** The last few finished prompts, newest first. */
  recent: QueueFinished[]
  /** Queued prompts run since the person last typed one: the runaway limit counts these. */
  streak: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-queue': { view: QueueView }
  }
}

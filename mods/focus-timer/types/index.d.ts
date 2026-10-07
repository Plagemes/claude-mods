/** A running timer: which phase, when it ends (ms since the epoch), how long it was set for, and which round. */
export type FocusTimer = {
  phase: 'focus' | 'break'
  endsAt: number
  minutes: number
  round: number
  /** This focus round turned mods-hub's Silent on (it was off), so its end turns it off again. */
  isSilencing?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'focus-timer': {
      timer: FocusTimer | null
      /** Focus rounds finished this session; every fourth earns the long break. */
      completed: number
    }
  }
}

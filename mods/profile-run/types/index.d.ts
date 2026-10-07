/** One function of a profile: where it is, the time spent in it alone, and with what it calls. */
export type ProfileFunction = {
  name: string
  /** `src/app.js:12`, a module path, or `(native)` / `(built-in)`. */
  location: string
  selfMs: number
  selfPercent: number
  totalPercent: number
}

/** What the /profile pane draws. */
export type ProfileView = {
  phase: 'idle' | 'running' | 'done' | 'error'
  command: string
  profiler: 'node' | 'python' | 'go' | null
  startedAt: number
  functions: ProfileFunction[]
  sortBy: 'self' | 'total'
  /** The time the profile covers (samples, or the profiler's own total), in milliseconds. */
  coveredMs: number
  /** A short line under the title: how many processes were profiled, where the profile file is. */
  detail: string
  /** Why there is nothing to show, or a hint for what cannot be profiled. */
  message: string
  /** The end of the command's output, when it failed. */
  output: string
}

declare module 'claude-code' {
  interface PluginState {
    'profile-run': { view: ProfileView }
  }
}

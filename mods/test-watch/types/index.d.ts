/** One runner invocation: what runs, where. */
export type TestWatchPlan = { runner: 'vitest' | 'jest' | 'pytest' | 'go' | 'cargo'; argv: string[]; cwd: string }

/** The last test run, as the status line and the /tests-last pane show it. */
export type TestWatchRun = {
  plans: TestWatchPlan[]
  /** What ran, as shown: test files relative to their project, Go packages, the crate. */
  targets: string[]
  outcome: 'passed' | 'failed' | 'error'
  passed: number | null
  failed: number | null
  /** Why the run could not finish, for an `error` outcome. */
  reason?: string
  durationMs: number
  /** The runners' output, colors stripped, its tail when long. */
  output: string
}

declare module 'claude-code' {
  interface PluginState {
    'test-watch': { last: TestWatchRun | null; isRunning: boolean }
  }
}

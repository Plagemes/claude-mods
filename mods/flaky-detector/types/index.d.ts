/** One outcome of a tracked test, with the code fingerprint it ran on. */
export type FlakyOutcome = { at: number; outcome: 'pass' | 'fail'; fingerprint: string; command: string }

/** A test that has failed at least once in this project. */
export type FlakyRecord = {
  id: string
  runner: 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'rspec'
  /** Its file, or Go package. */
  scope: string | null
  outcomes: FlakyOutcome[]
  /** Changes of outcome with no change of code between them. */
  flips: number
  lastFlipAt: number | null
  lastFailAt: number
}

/** A recent run, kept to tell whether a test that now fails passed on the same code before. */
export type FlakyRun = {
  runner: FlakyRecord['runner']
  command: string
  fingerprint: string
  at: number
  passed: string[]
  passedScopes: string[]
}

/** What the /flaky pane draws. */
export type FlakyView = { project: string; flaky: FlakyRecord[]; watching: FlakyRecord[] }

declare module 'claude-code' {
  interface PluginState {
    'flaky-detector': { view: FlakyView }
  }
}

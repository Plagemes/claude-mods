/** Where the TDD cycle stands: tests failing, passing, or code changing under passing tests. */
export type TestFirstPhase = 'red' | 'green' | 'refactor'

/** The last test command Claude ran, as the band shows it. */
export type TestFirstRun = { command: string; isPassed: boolean }

export type TestFirstStatus = {
  isOn: boolean
  phase: TestFirstPhase
  /** A test file was edited in the current turn, which opens production code. */
  hasTestThisTurn: boolean
  lastRun: TestFirstRun | null
}

declare module 'claude-code' {
  interface PluginState {
    'test-first': { status: TestFirstStatus }
  }
}

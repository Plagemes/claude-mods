/** A test's outcome the first time this session saw it run. */
export type GuardOutcome = 'pass' | 'fail'

/** A test that passed at its first run this session and fails now. */
export type GuardRegression = {
  /** The test as its runner names it (file, describe blocks and title). */
  name: string
  /** The file or package it belongs to, when the runner said. */
  group?: string
  /** When it was first seen failing, in milliseconds since the epoch. */
  since: number
  /** The command whose run showed it failing, shortened. */
  command: string
}

/** The last test run seen, for `/baseline`. */
export type GuardRun = {
  at: number
  command: string
  passed: number
  failed: number
}

declare module 'claude-code' {
  interface PluginState {
    'regression-guard': {
      baseline: Record<string, GuardOutcome>
      regressions: GuardRegression[]
      lastRun: GuardRun | null
      dismissed: string
      edited: string[]
    }
  }
}

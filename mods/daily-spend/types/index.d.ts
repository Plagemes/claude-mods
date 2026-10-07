/** Dollars spent per project root on one day. */
export type DailySpendDay = Record<string, number>

/** The days the pane draws, by local date (`2026-10-07`), and when they were read. */
export type DailySpendSnapshot = { asOf: number; days: Record<string, DailySpendDay> }

declare module 'claude-code' {
  interface PluginState {
    'daily-spend': { snapshot: DailySpendSnapshot | null }
  }
}

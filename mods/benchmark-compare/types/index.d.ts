/** One benchmark's number: time per operation in nanoseconds (lower is better) or operations per second (higher is better). */
export type BenchResult = { name: string; value: number; unit: 'ns' | 'ops' }

/** A benchmark run kept as the baseline of one project and branch. */
export type BenchBaseline = {
  command: string
  results: BenchResult[]
  at: number
  branch: string
  commit: string
}

/** One row of the comparison: a benchmark before and after. */
export type BenchRow = {
  name: string
  before: BenchResult | null
  after: BenchResult | null
  /** How much faster the new run is, in percent (negative is slower); null when either side is missing or units differ. */
  speedup: number | null
  verdict: 'faster' | 'slower' | 'same' | 'new' | 'gone'
}

/** What the /bench pane draws. */
export type BenchView = {
  phase: 'idle' | 'running' | 'done' | 'error'
  mode: 'baseline' | 'compare'
  command: string
  branch: string
  startedAt: number
  /** The baseline compared against (or just saved); null when there is none. */
  baseline: Omit<BenchBaseline, 'results'> | null
  rows: BenchRow[]
  message: string
  /** The end of the output, when nothing could be read from it. */
  output: string
}

declare module 'claude-code' {
  interface PluginState {
    'benchmark-compare': { view: BenchView }
  }
}

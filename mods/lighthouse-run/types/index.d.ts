/** A failing audit worth fixing, as the pane lists it. */
export type LighthouseRunAudit = {
  id: string
  title: string
  description: string
  category: string
  /** Lighthouse's own summary, e.g. `Est savings of 263 KiB`. */
  displayValue: string | null
  savingsMs: number | null
  /** URLs, selectors or HTML snippets the audit points at. */
  items: string[]
}

/** One Lighthouse report, read down to what the pane shows. */
export type LighthouseRunResult = {
  url: string
  formFactor: 'mobile' | 'desktop'
  version: string
  /** Category id → score 0–100, null when Lighthouse could not score it. */
  scores: Record<string, number | null>
  metrics: { label: string; value: string; score: number | null }[]
  audits: LighthouseRunAudit[]
  warnings: string[]
}

/** The run the pane shows, and the scores of the run before it on the same URL and device. */
export type LighthouseRunView = {
  phase: 'running' | 'ready' | 'error'
  url: string
  formFactor: 'mobile' | 'desktop'
  startedAt: number
  result: LighthouseRunResult | null
  previous: Record<string, number | null> | null
  previousAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'lighthouse-run': { view: LighthouseRunView | null }
  }
}

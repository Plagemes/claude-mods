export type QueryExplainMode = 'EXPLAIN' | 'EXPLAIN ANALYZE' | 'EXPLAIN QUERY PLAN'

/** Something the plan shows at a glance: a full scan, a sort on disk, stale estimates. */
export type QueryExplainFinding = { level: 'warn' | 'info'; text: string }

/** The last query explained, as the pane draws it. */
export type QueryExplainRun = {
  phase: 'running' | 'explaining' | 'ready' | 'error'
  sql: string
  /** `postgres · app @ localhost:5432`, never a password. */
  label: string
  mode: QueryExplainMode
  plan: string
  findings: QueryExplainFinding[]
  /** Existing indexes on the tables the query reads. */
  indexes: string[]
  explanation: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'query-explain': { run: QueryExplainRun | null }
  }
}

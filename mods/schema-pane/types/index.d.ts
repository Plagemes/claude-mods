/** One column, with the keys that touch it. */
export type SchemaPaneColumn = {
  name: string
  type: string
  isNullable: boolean
  defaultValue: string
  isPrimary: boolean
  isUnique: boolean
  /** `orgs.id` for a foreign key, null otherwise. */
  references: string | null
}

export type SchemaPaneTable = { name: string; columns: SchemaPaneColumn[]; indexes: string[] }

/** The schema the pane shows, read from the local database by its CLI. */
export type SchemaPaneSnapshot = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  /** `postgres · app @ localhost:5432`, never a password. */
  label: string
  /** Where the connection came from: `.env`, `the environment`, a fallback file. */
  source: string
  tables: SchemaPaneTable[]
  error: string | null
  loadedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'schema-pane': { snapshot: SchemaPaneSnapshot; expanded: string[]; filter: string; isInjected: boolean }
  }
}

/** The ORM whose schema is watched. */
export type SchemaSyncKind = 'prisma' | 'drizzle'

/** The last `prisma generate`: running, done, or failed with its error. */
export type SchemaSyncGenerate = { status: 'running' | 'ok' | 'failed'; error: string | null }

/** What the band and the status line show for the project whose schema changed last. */
export type SchemaSyncView = {
  kind: SchemaSyncKind
  /** The folder with the project's package.json. */
  root: string
  /** The schema file(s) that changed, relative to the root. */
  schema: string
  generate: SchemaSyncGenerate | null
  /** The models or tables changed since the last migration this session saw; null when none is missing. */
  missing: string[] | null
  /** Dismissed, or already handed to Claude: shows again when the changes differ. */
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'schema-sync': { view: SchemaSyncView | null }
  }
}

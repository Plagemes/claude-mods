/** One app's migration that `makemigrations --dry-run` would write, with its operations. */
export type DjangoMigrateApp = { app: string; file: string | null; operations: string[] }

/** Model changes that have no migration yet, as the last check found them. */
export type DjangoMigratePending = {
  /** The folder holding manage.py. */
  root: string
  /** The python the check ran with (a virtualenv's, or python3). */
  python: string
  apps: DjangoMigrateApp[]
  /** Dismissed, or already handed to Claude: the band shows again when the pending set changes. */
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'django-migrate-watch': { pending: DjangoMigratePending | null }
  }
}

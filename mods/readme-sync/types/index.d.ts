export type ReadmeSyncKind = 'export' | 'flag' | 'env'
export type ReadmeSyncChangeKind = 'added' | 'removed' | 'changed'

/** One change to documented surface: an export, a CLI flag or an env var, in one file. */
export type ReadmeSyncChange = {
  kind: ReadmeSyncKind
  name: string
  change: ReadmeSyncChangeKind
  /** The file, relative to the project root. */
  file: string
}

declare module 'claude-code' {
  interface PluginState {
    'readme-sync': { pending: ReadmeSyncChange[] }
  }
}

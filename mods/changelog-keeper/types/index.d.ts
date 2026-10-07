export type ChangelogView = {
  /** The changelog's path as configured (relative to the repository root). */
  path: string
  status: 'ok' | 'missing' | 'no-unreleased' | 'no-repo'
  /** The Unreleased section's body, markdown. */
  unreleased: string
  entries: number
}

declare module 'claude-code' {
  interface PluginState {
    'changelog-keeper': { view: ChangelogView | null }
  }
}

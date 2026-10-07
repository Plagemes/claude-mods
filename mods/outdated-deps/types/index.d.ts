export type OutdatedManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo' | 'go'

/** How big a version jump is, read as semver (0.x minors count as major). */
export type OutdatedKind = 'major' | 'minor' | 'patch'

/** One stale dependency. */
export type OutdatedPackage = {
  manager: OutdatedManager
  name: string
  current: string
  latest: string
  kind: OutdatedKind
  /** The newest version without a major jump, where there is one (npm's `wanted`, cargo's `compat`). */
  safe?: { version: string; kind: OutdatedKind }
  isDev?: boolean
  /** False for a package only installed as another one's dependency; undefined when unknown. */
  isDirect?: boolean
  /** The deprecation notice, when the package (or the installed version) is deprecated. */
  deprecated?: string
}

/** One manager's check: what it found, or why it could not run. */
export type OutdatedCheck = { manager: OutdatedManager; tool: string; packages: OutdatedPackage[]; error?: string; note?: string }

/** What the /outdated pane draws. */
export type OutdatedView = { phase: 'idle' | 'checking' | 'done'; running: string | null; checks: OutdatedCheck[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'outdated-deps': { view: OutdatedView }
  }
}

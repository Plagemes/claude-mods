// guardian's session state: what the Guardian tab (or the /guardian pane without mods-hub) draws.

export type GuardianLevel = 'permissive' | 'standard' | 'strict'
export type GuardianPolicyLevel = GuardianLevel | 'custom'
export type GuardianOptionValue = string | number | boolean

/** One option a policy would write to settings.json `pluginConfigs`. */
export type GuardianChange = { key: string; guard: string; option: string; before: GuardianOptionValue | undefined; after: GuardianOptionValue }

/** One row of the guard matrix. */
export type GuardianRow = {
  name: string
  title: string
  isRecommended: boolean
  isRelevant: boolean
  isInstalled: boolean
  /** Options that differ from the policy (0 when configured, or not installed). */
  pending: number
  isCoveredByFallback: boolean
  lastBlockAt: number | null
}

/** One risky action a guard stopped: from the hub's risk.blocked, guardian's fallback, or a deny guardian saw. */
export type GuardianBlock = {
  id: string
  at: number
  /** The guard that blocked it (`guardian` for its own fallback). */
  guard: string
  /** For guardian's own blocks: the guard mod it stood in for. */
  for?: string
  tool: string
  reason: string
  severity: 'low' | 'medium' | 'high'
  command?: string
  path?: string
  source: 'hub' | 'guardian' | 'observed'
}

export type GuardianScore = {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  parts: { label: string; points: number; max: number; detail: string }[]
  fixes: { text: string; gain: number; action?: { kind: 'install'; name: string } | { kind: 'apply' } | { kind: 'level'; level: GuardianLevel } }[]
}

export type GuardianSnapshot = {
  level: GuardianPolicyLevel
  base: GuardianLevel
  /** Where the level comes from: the project's .claude/guardian.json, or the mod's setting. */
  source: 'project' | 'setting'
  project: string
  isFallbackOn: boolean
  isInstalledKnown: boolean
  rows: GuardianRow[]
  score: GuardianScore
  blocks: GuardianBlock[]
  changes: GuardianChange[]
  settingsPath: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    guardian: {
      snapshot: GuardianSnapshot | null
      /** The Apply diff is on screen, waiting for Confirm. */
      isConfirming: boolean
      /** The outcome of the last action (apply, install, level), shown under the gauge. */
      notice: string | null
      /** An action in flight ("Installing rm-rf-guard…"). */
      busy: string | null
    }
  }
}

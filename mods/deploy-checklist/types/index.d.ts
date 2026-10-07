/** One line of the checklist: `skip` when it does not apply (no git, no changelog). */
export type DeployChecklistItem = {
  /** `ci` only with mods-hub: the latest CI run of the branch (`ci.result`). */
  id: 'branch' | 'tree' | 'tests' | 'changelog' | 'ci'
  label: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  detail: string
}

/** The deploy command waiting for the person, and their answer. */
export type DeployChecklistPending = {
  command: string
  kind: string
  items: DeployChecklistItem[]
  checkedAt: number
  status: 'waiting' | 'approved'
  approvedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'deploy-checklist': { pending: DeployChecklistPending | null; isChecking: boolean }
  }
}

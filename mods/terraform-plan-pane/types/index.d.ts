/** What a plan does to one resource. */
export type TfPlanAction = 'create' | 'update' | 'destroy' | 'replace' | 'read' | 'import' | 'move'

/** One resource in a plan: its address, the action, and why when the plan says (forces replacement: ami). */
export type TfPlanResource = { address: string; action: TfPlanAction; detail: string | null }

/** The last plan Claude ran, as the /tfplan pane draws it. */
export type TfPlan = {
  tool: 'terraform' | 'tofu'
  /** The Bash command that ran the plan. */
  command: string
  /** Where the plan ran (the session's folder, a `cd` or `-chdir`). */
  dir: string
  /** `json` when read from `show -json <planfile>`, `text` when read from the plan's output. */
  source: 'json' | 'text'
  at: number
  resources: TfPlanResource[]
  /** The counts the plan's own summary line gave, when it printed one. */
  summary: { add: number; change: number; destroy: number; import: number } | null
  isNoChanges: boolean
  /** The plan's error, when it failed. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'terraform-plan-pane': { plan: TfPlan | null }
  }
}

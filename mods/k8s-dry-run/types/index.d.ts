/** One object a held kubectl command would change, as the server-side dry run reported it. */
export type K8sDryRunObject = {
  /** `Deployment default/web`, or `deployment.apps/web` for a delete. */
  name: string
  change: 'create' | 'update' | 'delete'
  adds: number
  dels: number
  /** The object's diff hunks (empty for a delete). */
  diff: string
}

/** A kubectl command held until the person approves it. */
export type K8sDryRunPreview = {
  command: string
  verb: 'apply' | 'replace' | 'delete'
  context: string | null
  namespace: string | null
  isProd: boolean
  objects: K8sDryRunObject[]
  /** True when the diff was cut to fit. */
  isCut: boolean
}

/** A one-time approval: the exact command on that context, until it expires. */
export type K8sDryRunApproval = { key: string; until: number }

declare module 'claude-code' {
  interface PluginState {
    'k8s-dry-run': { pending: K8sDryRunPreview | null; approvals: K8sDryRunApproval[] }
  }
}

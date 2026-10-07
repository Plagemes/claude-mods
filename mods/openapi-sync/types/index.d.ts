/** A route the code and the spec disagree on. */
export type OpenapiSyncIssue = {
  /** Upper case, or `ANY` when the code does not say (Django, Next pages/api). */
  method: string
  /** Normalized: `{param}` placeholders, no trailing slash. */
  path: string
  /** Where the route was changed, relative to the project root. */
  file: string
  /** `undocumented`: in the code, not in the spec. `stale`: removed from the code, still in the spec. */
  kind: 'undocumented' | 'stale'
}

declare module 'claude-code' {
  interface PluginState {
    'openapi-sync': {
      issues: OpenapiSyncIssue[]
      /** The spec file the issues were checked against, relative to the root. */
      spec: string | null
    }
  }
}

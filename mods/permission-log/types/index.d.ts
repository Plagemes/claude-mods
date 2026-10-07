export type PermissionLogEntry = {
  /** The tool call's id, so one call is logged once however many hooks see its refusal. */
  id: string
  /** When the refusal was seen, in milliseconds since the epoch. */
  at: number
  tool: string
  /** The command, path, URL or query the call was about. */
  summary: string
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'permission-log': { denied: PermissionLogEntry[] }
  }
}

/** What the session did to one file, by count. */
export type FilesTouchedEntry = {
  /** Absolute path. */
  path: string
  reads: number
  edits: number
  creates: number
  /** When it was last touched, from `$.clock.now()`. */
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'files-touched': { files: FilesTouchedEntry[]; isChangedOnly: boolean }
  }
}

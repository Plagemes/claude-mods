/** Where the dev server is in its life. */
export type DevServerStatus = 'idle' | 'running' | 'exited' | 'stopped' | 'failed'

/** One line of the server's output, colors stripped, read as an error, a warning or plain output. */
export type DevServerLine = { text: string; stream: 'stdout' | 'stderr'; kind: 'error' | 'warning' | 'info' }

/** The dev server this session started, as the pane and the status line show it. */
export type DevServerRun = {
  status: DevServerStatus
  command: string | null
  /** Where the command came from: `package.json "dev" script`, `/dev argument`, ... */
  source: string | null
  cwd: string | null
  /** The address the server printed it listens on. */
  url: string | null
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  signal: string | null
  /** Why it failed to start, or how it ended. */
  note: string | null
  /** Error lines seen since it started. */
  errors: number
}

declare module 'claude-code' {
  interface PluginState {
    'dev-server-pane': { run: DevServerRun; lines: DevServerLine[] }
  }
}

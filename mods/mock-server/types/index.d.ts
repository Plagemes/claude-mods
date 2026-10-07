/** One request the mock answered. */
export type MockServerRequest = { at: number; method: string; path: string; status?: number; ms?: number }

/** The mock server of this session, as the pane and status line show it. */
export type MockServerState = {
  id: number
  status: 'starting' | 'running' | 'stopped' | 'failed'
  engine: 'prism' | 'builtin'
  /** The spec as given or found, relative to the project root when inside it. */
  spec: string
  port: number
  url: string
  /** The operations it serves (the built-in mock's from the spec, Prism's from its start-up listing). */
  routes: { method: string; path: string; status?: number }[]
  requests: MockServerRequest[]
  /** Recent output lines that are not requests: Prism's notes, errors, Node.js messages. */
  log: string[]
  error?: string
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'mock-server': { server: MockServerState | null }
  }
}

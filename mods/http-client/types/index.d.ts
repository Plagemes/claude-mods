/** A request as /http sends it. */
export type HttpClientRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

/** One request and what came back, as the pane shows it. */
export type HttpClientExchange = {
  id: number
  request: HttpClientRequest
  phase: 'sending' | 'done' | 'failed'
  startedAt: number
  response?: {
    status: number
    /** Lower-cased names, as the host returns them. */
    headers: Record<string, string>
    /** The body as text, cut at the size the pane keeps. */
    text: string
    /** UTF-8 bytes of the whole body. */
    bytes: number
    ms: number
    isCut: boolean
  }
  error?: string
}

/** A past request kept across sessions; secret header and query values are masked. */
export type HttpClientHistoryEntry = {
  request: HttpClientRequest
  at: number
  status?: number
  ms?: number
  error?: string
  /** True when a value was masked, so the entry cannot be resent as is. */
  isRedacted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'http-client': {
      exchange: HttpClientExchange | null
      view: 'response' | 'history'
      showHeaders: boolean
      history: HttpClientHistoryEntry[]
    }
  }
}

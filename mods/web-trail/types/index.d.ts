export type WebTrailVisit = {
  /** When the call was made, in milliseconds since the epoch. */
  at: number
  kind: 'fetch' | 'search'
  /** The URL fetched or the query searched. */
  target: string
  /** True when the tool reported an error. */
  isFailed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'web-trail': { visits: WebTrailVisit[] }
  }
}

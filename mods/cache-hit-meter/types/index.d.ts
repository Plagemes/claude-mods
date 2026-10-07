export type CacheHitMeterStats = {
  /** Input tokens served from the prompt cache, summed over the session's turns. */
  read: number
  /** All input tokens (uncached + cache read + cache written), summed likewise. */
  total: number
  turns: number
  /** Cache share of the most recent turn, in percent. */
  lastPercent: number | null
  hasWarned: boolean
  /** What those cache reads saved against paying the input rate, in US dollars (shown when mods-hub is installed). */
  savedUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-hit-meter': { stats: CacheHitMeterStats }
  }
}

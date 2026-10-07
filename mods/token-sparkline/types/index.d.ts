/** Tokens of each of the last turns, oldest first. */
export type TokenPoints = number[]

declare module 'claude-code' {
  interface PluginState {
    'token-sparkline': { points: TokenPoints; isHidden: boolean }
  }
}

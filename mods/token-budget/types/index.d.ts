/** What the session has spent so far, from the usage of every finished turn. */
export type TokenBudgetSpend = { usd: number; tokens: number; turns: number }

/** A limit per unit; null means no limit on that unit. */
export type TokenBudgetLimits = { usd: number | null; tokens: number | null }

/** How close the spend is to the limits: under the warning line, past it, or at 100%. */
export type TokenBudgetLevel = 'ok' | 'warn' | 'over'

declare module 'claude-code' {
  interface PluginState {
    'token-budget': {
      spend: TokenBudgetSpend
      /** Limits set for this session with /budget; null follows the configuration. */
      limits: TokenBudgetLimits | null
      /** The highest level already announced, so each threshold toasts once. */
      announced: TokenBudgetLevel
      isBandHidden: boolean
    }
  }
}

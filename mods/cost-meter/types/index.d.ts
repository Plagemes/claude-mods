export type Spend = {
  /** Estimated dollars so far. */
  usd: number
  /** Every token counted: input, output, cache reads and cache writes. */
  tokens: number
  /** Completed turns counted, subagents' included. */
  turns: number
  /** True once a turn ran on a model the price table does not know (priced as an Opus 5.5). */
  hasUnpricedModel: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cost-meter': { spend: Spend }
  }
}

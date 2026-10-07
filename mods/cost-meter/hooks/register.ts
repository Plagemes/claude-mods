import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { costOf, formatSpend, parseOverrides, type PriceTable } from './pricing'
import type { Spend } from '../types'

const EMPTY: Spend = { usd: 0, tokens: 0, turns: 0, hasUnpricedModel: false }
const spend = atom({ plugin: 'cost-meter', key: 'spend' } as const, EMPTY)

async function showSpend($: EngineInterface, showTokens: boolean): Promise<void> {
  $.ui.status(formatSpend(await read($, spend), showTokens))
}

export const register: Register = (on, options) => {
  const overrides: PriceTable = parseOverrides(String(options.pricing ?? ''))
  const showTokens = options.showTokens !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cost-reset', description: 'Reset the cost-meter counters to zero' })
    await showSpend($, showTokens)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const { usage } = e
    if (usage !== undefined) {
      const cost = costOf(usage.model, usage, overrides)
      await update($, spend, total => ({
        usd: total.usd + cost.usd,
        tokens: total.tokens + cost.tokens,
        turns: total.turns + 1,
        hasUnpricedModel: total.hasUnpricedModel || !cost.isKnownModel,
      }))
      await showSpend($, showTokens)
    }
    return next(e)
  })

  on('command.run', { command: 'cost-reset' }, async $ => {
    const before = formatSpend(await read($, spend), showTokens)
    await update($, spend, () => EMPTY)
    await showSpend($, showTokens)
    return { text: `cost-meter: counters reset (they read ${before}).` }
  })
}

import { atom, update } from 'claude-code'
import type { ModelUsage, Register } from 'claude-code'

import type { CacheHitMeterStats } from '../types'

const EMPTY: CacheHitMeterStats = { read: 0, total: 0, turns: 0, lastPercent: null, hasWarned: false }
const stats = atom({ plugin: 'cache-hit-meter', key: 'stats' } as const, EMPTY)

const DEFAULT_WARN_BELOW = 30
const DEFAULT_AFTER_TURNS = 5

const inputTokens = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

const percentOf = (read: number, total: number): number => Math.round((read / total) * 100)

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const statusLine = ({ read, total, turns, lastPercent }: CacheHitMeterStats): string =>
  turns > 1 && lastPercent !== null
    ? `cache ${percentOf(read, total)}% · last ${lastPercent}%`
    : `cache ${percentOf(read, total)}%`

export const register: Register = (on, options) => {
  const warnBelow = asNumber(options.warnBelow, DEFAULT_WARN_BELOW)
  const afterTurns = asNumber(options.afterTurns, DEFAULT_AFTER_TURNS)

  on('turn.complete', async ($, e, next) => {
    const { usage } = e
    const total = usage === undefined ? 0 : inputTokens(usage)

    // Subagents run on their own context; only the main conversation is measured.
    if (usage !== undefined && total > 0 && e.agentId === undefined) {
      const session = await update($, stats, previous => ({
        ...previous,
        read: previous.read + usage.cache_read_input_tokens,
        total: previous.total + total,
        turns: previous.turns + 1,
        lastPercent: percentOf(usage.cache_read_input_tokens, total),
      }))
      $.ui.status(statusLine(session))

      const sessionPercent = percentOf(session.read, session.total)
      if (!session.hasWarned && session.turns >= afterTurns && sessionPercent < warnBelow) {
        await update($, stats, previous => ({ ...previous, hasWarned: true }))
        $.ui.toast(`cache-hit-meter: only ${sessionPercent}% of input came from the prompt cache (${session.turns} turns)`)
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, stats, () => EMPTY)
      $.ui.status(undefined)
    }

    return next(e)
  })
}

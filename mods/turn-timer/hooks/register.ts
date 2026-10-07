import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TurnTimerStats } from '../types'

const EMPTY: TurnTimerStats = { count: 0, totalMs: 0, lastMs: 0 }
const stats = atom({ plugin: 'turn-timer', key: 'stats' } as const, EMPTY)

const DEFAULT_THRESHOLD_SECONDS = 120
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

const pad = (n: number): string => String(n).padStart(2, '0')

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)

  if (minutes === 0) {
    return `${seconds}s`
  }

  const rest = seconds % SECONDS_PER_MINUTE
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)

  return hours === 0
    ? `${minutes}m ${pad(rest)}s`
    : `${hours}h ${pad(minutes % MINUTES_PER_HOUR)}m`
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const register: Register = (on, options) => {
  const thresholdMs = asNumber(options.thresholdSeconds, DEFAULT_THRESHOLD_SECONDS) * 1000

  on('turn.complete', async ($, e, next) => {
    // Subagent turns and interrupted turns would skew the average.
    if (e.agentId === undefined && !e.isAborted) {
      const { count, totalMs, lastMs } = await update($, stats, previous => ({
        count: previous.count + 1,
        totalMs: previous.totalMs + e.durationMs,
        lastMs: e.durationMs,
      }))
      $.ui.status(`last ${formatDuration(lastMs)} · avg ${formatDuration(totalMs / count)}`)

      if (thresholdMs > 0 && e.durationMs > thresholdMs) {
        $.ui.toast(`turn-timer: that turn took ${formatDuration(e.durationMs)}`)
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

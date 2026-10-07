import type { Register } from 'claude-code'

import { externalHosts, loopOfFetches } from './requests'

const DEFAULT_MAX_CALLS = 20
const DEFAULT_WINDOW_SEC = 60
const TOAST_MS = 8_000

/** The recent requests to one host, and until when it is paused. */
type HostLog = { hits: number[]; pausedUntil: number }

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

const counts = (hosts: readonly string[]): Map<string, number> => {
  const result = new Map<string, number>()
  for (const host of hosts) result.set(host, (result.get(host) ?? 0) + 1)
  return result
}

const HOW_TO_GO_ON = 'Wait for the pause to end, get what you need in fewer requests (pagination, a bulk endpoint, one script with a delay between calls), or reuse results you already have.'

const loopWarning = (iterations: number | undefined, maxCalls: number, windowSec: number): string =>
  `rate-limit-guard: this command fetches in a loop${iterations === undefined ? '' : ` (about ${iterations} rounds)`} with nothing slowing it down, so every round is a separate request. ` +
  `External hosts are limited to ${maxCalls} calls per ${windowSec} s here. Add a sleep between rounds, respect Retry-After, or use a bulk endpoint.`

export const register: Register = (on, options) => {
  const maxCalls = Math.floor(positive(options.maxCalls, DEFAULT_MAX_CALLS))
  const windowMs = positive(options.windowSec, DEFAULT_WINDOW_SEC) * 1000
  const logs = new Map<string, HostLog>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const wanted = counts(externalHosts(e.command))
    const loop = loopOfFetches(e.command)
    if (wanted.size === 0 && loop === undefined) return next(e)

    const now = await $.clock.now()
    for (const [host, log] of logs) if (log.pausedUntil <= now && log.hits.every(hit => hit <= now - windowMs)) logs.delete(host)

    // Judge every host first, so a refused command records nothing against the others.
    for (const [host, wantedNow] of wanted) {
      const log = logs.get(host) ?? { hits: [], pausedUntil: 0 }
      if (log.pausedUntil > now) {
        const seconds = Math.ceil((log.pausedUntil - now) / 1000)
        return { deny: `rate-limit-guard: requests to ${host} are paused for ${seconds} more s (the limit of ${maxCalls} per ${windowMs / 1000} s was reached). ${HOW_TO_GO_ON}` }
      }
      const recent = log.hits.filter(hit => hit > now - windowMs)
      if (recent.length + wantedNow > maxCalls) {
        logs.set(host, { hits: [], pausedUntil: now + windowMs })
        $.ui.toast(`paused requests to ${host} for ${windowMs / 1000} s (${recent.length} in the last ${windowMs / 1000} s)`, { timeoutMs: TOAST_MS })
        return { deny: `rate-limit-guard: ${recent.length} requests to ${host} in the last ${windowMs / 1000} s, and the limit is ${maxCalls}. Requests to ${host} are paused for ${windowMs / 1000} s. ${HOW_TO_GO_ON}` }
      }
    }
    for (const [host, wantedNow] of wanted) {
      const log = logs.get(host) ?? { hits: [], pausedUntil: 0 }
      logs.set(host, { hits: [...log.hits.filter(hit => hit > now - windowMs), ...Array<number>(wantedNow).fill(now)], pausedUntil: 0 })
    }

    const ran = await next(e)
    if (loop === undefined || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), loopWarning(loop.iterations, maxCalls, windowMs / 1000)] }
  }).catch(($, e, next) => next(e))
}

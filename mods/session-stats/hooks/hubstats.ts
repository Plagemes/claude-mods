import type { SessionStatsHub } from '../types'

export const EMPTY_HUB: SessionStatsHub = { runs: 0, failedRuns: 0, lastRun: null, turns: 0, tools: 0, sessionUsd: null, turnUsd: null, isEstimate: false }

type BusEvent = { topic: string; data: unknown }

const asRecord = (data: unknown): Record<string, unknown> => (typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {})
const asCount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** Folds the hub's events (`test.result`, `turn.finished`, `cost.update`) into the totals the dashboard adds; other topics and malformed payloads change nothing. */
export const foldEvents = (stats: SessionStatsHub, events: readonly BusEvent[]): SessionStatsHub =>
  events.reduce<SessionStatsHub>((total, { topic, data }) => {
    const body = asRecord(data)
    if (topic === 'test.result' && typeof body.outcome === 'string') {
      return {
        ...total,
        runs: total.runs + 1,
        failedRuns: total.failedRuns + (body.outcome === 'passed' ? 0 : 1),
        lastRun: { runner: typeof body.runner === 'string' ? body.runner : 'tests', outcome: body.outcome, passed: asCount(body.passed), failed: asCount(body.failed) },
      }
    }
    if (topic === 'turn.finished' && asCount(body.tools) !== null) return { ...total, turns: total.turns + 1, tools: total.tools + (asCount(body.tools) ?? 0) }
    if (topic === 'cost.update' && asCount(body.sessionUsd) !== null) {
      return { ...total, sessionUsd: asCount(body.sessionUsd), turnUsd: asCount(body.turnUsd), isEstimate: body.isEstimate === true }
    }
    return total
  }, stats)

/** `passed · 120 passed · 2 failed`: the last test run in words. */
export const describeRun = (run: NonNullable<SessionStatsHub['lastRun']>): string => {
  const counts = [run.passed === null ? '' : `${run.passed} passed`, run.failed === null || run.failed === 0 ? '' : `${run.failed} failed`].filter(part => part !== '')
  return [run.outcome, ...counts].join(' · ')
}

/** `3.2 tools per turn` from the hub's finished turns; undefined before the first. */
export const toolsPerTurn = (stats: SessionStatsHub): string | undefined =>
  stats.turns === 0 ? undefined : `${(stats.tools / stats.turns).toFixed(1)} tools per turn`

// Outcome learning, the opus quota and the daily summary file. Pure: no `$` here.

import type { SmartRouterFamily, SmartRouterMix, SmartRouterProject, SmartRouterReliability, SmartRouterTier } from '../types'

/** How much one new outcome moves a score (an exponential moving average). */
const OUTCOME_WEIGHT = 0.35
/** A failure's weight halves every week: old trouble fades. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60_000
/** Below this score, after at least MIN_RUNS outcomes, a kind of task is routed one tier up. */
export const LOW_RELIABILITY = 0.5
const MIN_RUNS = 2
/** A score at or above this is not worth listing. */
const SHOWN_BELOW = 0.85

export const EMPTY_PROJECT: SmartRouterProject = { reliability: {}, tokens: {} }

export const reliabilityKey = (category: string, tier: SmartRouterTier): string => `${category}|${tier}`

/** The score now: a past score drifts back toward 1 (no evidence) as it ages. */
export const scoreNow = (entry: SmartRouterReliability, now: number): number =>
  1 - (1 - entry.score) * 0.5 ** (Math.max(0, now - entry.at) / HALF_LIFE_MS)

/** One outcome of a kind of task on a tier: a success (true) or a failure. */
export function recordOutcome(project: SmartRouterProject, category: string, tier: SmartRouterTier, isOk: boolean, now: number): SmartRouterProject {
  const key = reliabilityKey(category, tier)
  const before = project.reliability[key]
  const current = before === undefined ? 1 : scoreNow(before, now)
  const entry: SmartRouterReliability = { score: current * (1 - OUTCOME_WEIGHT) + (isOk ? OUTCOME_WEIGHT : 0), runs: (before?.runs ?? 0) + 1, at: now }
  return { ...project, reliability: { ...project.reliability, [key]: entry } }
}

/** Whether this kind of task has failed often enough on this tier to start one tier up. */
export function isUnreliable(project: SmartRouterProject, category: string, tier: SmartRouterTier, now: number): boolean {
  const entry = project.reliability[reliabilityKey(category, tier)]
  return entry !== undefined && entry.runs >= MIN_RUNS && scoreNow(entry, now) < LOW_RELIABILITY
}

export type ReliabilityRow = { category: string; tier: SmartRouterTier; score: number; runs: number; isLow: boolean }

/** The scores worth showing, weakest first. */
export function weakSpots(project: SmartRouterProject, now: number): ReliabilityRow[] {
  return Object.entries(project.reliability)
    .map(([key, entry]) => {
      const [category = '', tier = 'standard'] = key.split('|')
      const score = scoreNow(entry, now)
      return { category, tier: tier as SmartRouterTier, score, runs: entry.runs, isLow: entry.runs >= MIN_RUNS && score < LOW_RELIABILITY }
    })
    .filter(row => row.score < SHOWN_BELOW)
    .sort((a, b) => a.score - b.score)
}

const STRONG: ReadonlySet<SmartRouterFamily> = new Set(['opus', 'fable'])

/** The share (0-1) of this project's subagent tokens that ran on opus-class models. */
export function opusShareOf(tokens: Partial<Record<SmartRouterFamily, number>>): number {
  const all = Object.values(tokens).reduce((sum, value) => sum + (value ?? 0), 0)
  if (all <= 0) return 0
  const strong = Object.entries(tokens).filter(([family]) => STRONG.has(family as SmartRouterFamily)).reduce((sum, [, value]) => sum + (value ?? 0), 0)
  return strong / all
}

/** A Bash command that runs a test suite. */
export const TEST_COMMAND = /(^|[\s;&|(])(npm (run )?test|pnpm (run )?test|yarn test|bun test|npx (jest|vitest|mocha|playwright)|jest|vitest|mocha|pytest|python3? -m (pytest|unittest)|go test|cargo test|mvn test|gradle test|\.\/gradlew test|rspec|phpunit|dotnet test|make test|deno test)\b/

// The daily summary file other mods read (~/.claude/claude-mods/smart-router/daily.json).

export type FamilyDay = { calls: number; tokens: number; usd: number }
export type DailySummary = { date: string; saved: number; spent: number; byModel: Partial<Record<SmartRouterFamily, FamilyDay>> }
/** What this session has already written into the file, so the next write adds only what is new. */
export type Flushed = { saved: number; spent: number; byModel: Partial<Record<SmartRouterFamily, FamilyDay>> }

export const NOTHING_FLUSHED: Flushed = { saved: 0, spent: 0, byModel: {} }

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000

/** This session's figures now, in the file's shape. */
export function sessionFigures(mix: SmartRouterMix, saved: number, spent: number): Flushed {
  const byModel: Partial<Record<SmartRouterFamily, FamilyDay>> = {}
  for (const [family, stats] of Object.entries(mix.models) as [SmartRouterFamily, { calls: number; tokens: number; usd: number }][]) {
    byModel[family] = { calls: stats.calls, tokens: stats.tokens, usd: stats.usd }
  }
  return { saved, spent, byModel }
}

/** Today's summary: the file's (when it is today's) plus what changed since the last write. */
export function mergeDaily(previous: unknown, date: string, now: Flushed, flushed: Flushed): DailySummary {
  const base = previous as Partial<DailySummary> | null
  const today: DailySummary =
    base !== null && typeof base === 'object' && base.date === date && typeof base.saved === 'number' && typeof base.spent === 'number'
      ? { date, saved: base.saved, spent: base.spent, byModel: { ...(base.byModel ?? {}) } }
      : { date, saved: 0, spent: 0, byModel: {} }
  const byModel = { ...today.byModel }
  for (const [family, figures] of Object.entries(now.byModel) as [SmartRouterFamily, FamilyDay][]) {
    const before = flushed.byModel[family] ?? { calls: 0, tokens: 0, usd: 0 }
    const day = byModel[family] ?? { calls: 0, tokens: 0, usd: 0 }
    byModel[family] = { calls: day.calls + figures.calls - before.calls, tokens: day.tokens + figures.tokens - before.tokens, usd: round(day.usd + figures.usd - before.usd) }
  }
  return { date, saved: round(today.saved + now.saved - flushed.saved), spent: round(today.spent + now.spent - flushed.spent), byModel }
}

/** The local calendar date, YYYY-MM-DD. */
export const dateOf = (now: number): string => {
  const day = new Date(now)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

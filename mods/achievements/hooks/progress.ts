import type { AchievementsProgress } from '../types'
import { ACHIEVEMENTS, MAX_COUNTERS, SUM_COUNTERS } from './table'
import type { Achievement, MaxCounter, Stat, SumCounter } from './table'

export type Progress = AchievementsProgress
/** One day's tool calls and failures, for Flawless day. */
export type DayCount = { tools: number; errors: number }

/** What this session added to the sum counters and day counts since the last save. */
export type Pending = { sums: Partial<Record<SumCounter, number>>; daily: Record<string, DayCount> }

const KEPT_ACTIVE_DAYS = 60
const KEPT_DAILY = 7
const FLAWLESS_TOOLS = 25
const SUMS = new Set<string>(SUM_COUNTERS)
const MAXES = new Set<string>(MAX_COUNTERS)

export const emptyProgress = (): Progress => ({ counters: {}, unlocked: {}, languages: [], activeDays: [], daily: {}, flawlessDays: [] })
export const emptyPending = (): Pending => ({ sums: {}, daily: {} })

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local calendar date of `ms`, `YYYY-MM-DD`. */
export function localDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The calendar date before `day` (`YYYY-MM-DD`). */
export function dayBefore(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  const before = new Date(year, month - 1, date - 1)
  return `${before.getFullYear()}-${pad(before.getMonth() + 1)}-${pad(before.getDate())}`
}

const sortedUnion = (a: readonly string[], b: readonly string[], keep = Infinity): string[] =>
  [...new Set([...a, ...b])].sort().slice(-keep)

const numberOr0 = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The progress the store held, every field checked; anything unreadable starts at zero. */
export function readProgress(value: unknown): Progress {
  const record = recordOf(value)
  const counters: Record<string, number> = {}
  for (const [key, count] of Object.entries(recordOf(record.counters))) {
    if (SUMS.has(key) || MAXES.has(key)) counters[key] = numberOr0(count)
  }
  const unlocked: Record<string, number> = {}
  for (const [id, at] of Object.entries(recordOf(record.unlocked))) unlocked[id] = numberOr0(at)
  const daily: Record<string, DayCount> = {}
  for (const [day, entry] of Object.entries(recordOf(record.daily))) {
    const counts = recordOf(entry)
    daily[day] = { tools: numberOr0(counts.tools), errors: numberOr0(counts.errors) }
  }

  return {
    counters,
    unlocked,
    languages: strings(record.languages),
    activeDays: strings(record.activeDays),
    daily,
    flawlessDays: strings(record.flawlessDays),
  }
}

/** Adds `by` to a sum counter, in the progress and in what the next save adds. */
export function bump(progress: Progress, pending: Pending, counter: SumCounter, by = 1): void {
  progress.counters[counter] = (progress.counters[counter] ?? 0) + by
  pending.sums[counter] = (pending.sums[counter] ?? 0) + by
}

/** Raises a max counter to `value` when it is higher. */
export function raise(progress: Progress, counter: MaxCounter, value: number): void {
  progress.counters[counter] = Math.max(progress.counters[counter] ?? 0, value)
}

/** Counts one tool call toward its day (and a failure, when it failed). */
export function noteToolCall(progress: Progress, pending: Pending, day: string, hasFailed: boolean): void {
  for (const target of [progress.daily, pending.daily]) {
    const counts = target[day] ?? { tools: 0, errors: 0 }
    target[day] = { tools: counts.tools + 1, errors: counts.errors + (hasFailed ? 1 : 0) }
  }
}

export function noteLanguage(progress: Progress, language: string): void {
  if (!progress.languages.includes(language)) progress.languages = sortedUnion(progress.languages, [language])
}

/** The run of consecutive active days that ends on `today` or yesterday. */
export function currentStreak(activeDays: readonly string[], today: string): number {
  const days = new Set(activeDays)
  let day = days.has(today) ? today : dayBefore(today)
  let streak = 0
  while (days.has(day)) {
    streak += 1
    day = dayBefore(day)
  }
  return streak
}

/** Marks `day` active and keeps the best streak. */
export function noteActiveDay(progress: Progress, day: string): void {
  progress.activeDays = sortedUnion(progress.activeDays, [day], KEPT_ACTIVE_DAYS)
  raise(progress, 'bestStreak', currentStreak(progress.activeDays, day))
}

/** Every finished day (before `today`) with enough tool calls and none failing becomes a flawless day. */
export function settleDays(progress: Progress, today: string): void {
  const flawless = Object.entries(progress.daily)
    .filter(([day, counts]) => day < today && counts.tools >= FLAWLESS_TOOLS && counts.errors === 0)
    .map(([day]) => day)
  progress.flawlessDays = sortedUnion(progress.flawlessDays, flawless)
  progress.daily = Object.fromEntries(Object.entries(progress.daily).sort(([a], [b]) => a.localeCompare(b)).slice(-KEPT_DAILY))
}

/**
 * Folds this session's progress into what the store holds now, so sessions
 * running side by side add up instead of overwriting each other: sum
 * counters add what this session `sent`, the rest keep the larger value or
 * the union.
 */
export function merge(stored: Progress, memory: Progress, sent: Pending): Progress {
  const counters: Record<string, number> = {}
  for (const counter of SUM_COUNTERS) {
    const total = (stored.counters[counter] ?? 0) + (sent.sums[counter] ?? 0)
    if (total > 0) counters[counter] = total
  }
  for (const counter of MAX_COUNTERS) {
    const best = Math.max(stored.counters[counter] ?? 0, memory.counters[counter] ?? 0)
    if (best > 0) counters[counter] = best
  }
  const unlocked: Record<string, number> = { ...memory.unlocked }
  for (const [id, at] of Object.entries(stored.unlocked)) unlocked[id] = Math.min(at, unlocked[id] ?? at)
  const daily: Record<string, DayCount> = { ...stored.daily }
  for (const [day, counts] of Object.entries(sent.daily)) {
    const known = daily[day] ?? { tools: 0, errors: 0 }
    daily[day] = { tools: known.tools + counts.tools, errors: known.errors + counts.errors }
  }
  for (const [day, counts] of Object.entries(memory.daily)) daily[day] ??= counts

  return {
    counters,
    unlocked,
    languages: sortedUnion(stored.languages, memory.languages),
    activeDays: sortedUnion(stored.activeDays, memory.activeDays, KEPT_ACTIVE_DAYS),
    daily: Object.fromEntries(Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).slice(-KEPT_DAILY)),
    flawlessDays: sortedUnion(stored.flawlessDays, memory.flawlessDays),
  }
}

/** Every stat an achievement can measure, as of `today`. */
export function statsOf(progress: Progress, today: string): Record<Stat, number> {
  const stats = {} as Record<Stat, number>
  for (const counter of [...SUM_COUNTERS, ...MAX_COUNTERS]) stats[counter] = progress.counters[counter] ?? 0
  stats.languages = progress.languages.length
  stats.streak = Math.max(progress.counters.bestStreak ?? 0, currentStreak(progress.activeDays, today))
  stats.flawless = progress.flawlessDays.length
  stats.unlocked = Object.keys(progress.unlocked).length
  return stats
}

/** Unlocks every achievement whose goal the progress now meets (at `now`) and returns them, in table order. */
export function unlockReached(progress: Progress, today: string, now: number): Achievement[] {
  const reached: Achievement[] = []
  for (let isMore = true; isMore; ) {
    isMore = false
    const stats = statsOf(progress, today)
    for (const achievement of ACHIEVEMENTS) {
      if (progress.unlocked[achievement.id] !== undefined || stats[achievement.stat] < achievement.goal) continue
      progress.unlocked[achievement.id] = now
      reached.push(achievement)
      isMore = true
    }
  }
  return reached
}

/** A progress bar of `width` cells: `█████░░░░░`. */
export function bar(value: number, goal: number, width: number): string {
  const filled = goal <= 0 ? width : Math.min(width, Math.floor((Math.min(value, goal) / goal) * width))
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

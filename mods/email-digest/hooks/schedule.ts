/** When a digest is due and which days it covers. Pure: the clock, the schedule and what was already sent in. */
import type { Period } from './compose'
import { addDays, atTime, dateKey, epochToWall, startOfDay, weekdayOf } from './zones'

export type Frequency = 'off' | 'daily' | 'weekly' | 'both'

export type Schedule = {
  frequency: Frequency
  sendAt: { h: number; mi: number }
  /** 0 = Sunday. */
  weeklyDay: number
  skipWeekends: boolean
}

/** What was sent for which day, and how often a slot was tried. Written by the leader alone. */
export type SchedState = {
  /** The local date (YYYY-MM-DD) a daily / weekly digest was last sent for. */
  daily: string
  weekly: string
  attempt: { slot: string; count: number; at: number } | null
  /** What smart-router's daily.json said was spent each day (all projects), for the cost line of a week. */
  costs: Record<string, number>
}

export const EMPTY_SCHED: SchedState = { daily: '', weekly: '', attempt: null, costs: {} }

/** A session opened this long after the send time still sends; later, that day's digest is skipped. */
export const GRACE_MS = 6 * 3_600_000
export const RETRY_MS = 30 * 60_000
export const MAX_ATTEMPTS = 3

const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const parseWeekday = (text: string, fallback: number): number => {
  const index = DAY_CODES.indexOf(text.trim().toLowerCase().slice(0, 3))
  return index < 0 ? fallback : index
}

export type Due = { period: Period; key: string }

/** The digest to send now, if any. On the weekly day with `both`, the weekly one replaces the daily. */
export function dueNow(now: number, zone: string, schedule: Schedule, state: SchedState): Due | undefined {
  if (schedule.frequency === 'off') return undefined
  const today = epochToWall(now, zone)
  const key = dateKey(today)
  const sendTime = atTime(startOfDay(now, zone), schedule.sendAt, zone)
  if (now < sendTime || now > sendTime + GRACE_MS) return undefined
  const weekday = weekdayOf(today)
  const isWeeklyDay = weekday === schedule.weeklyDay
  const wantsWeekly = (schedule.frequency === 'weekly' || schedule.frequency === 'both') && isWeeklyDay && state.weekly !== key
  const wantsDaily =
    (schedule.frequency === 'daily' || schedule.frequency === 'both') &&
    !(schedule.frequency === 'both' && isWeeklyDay) &&
    !(schedule.skipWeekends && (weekday === 0 || weekday === 6)) &&
    state.daily !== key
  const due: Due | undefined = wantsWeekly ? { period: 'weekly', key } : wantsDaily ? { period: 'daily', key } : undefined
  if (due === undefined) return undefined
  const slot = `${due.period}:${due.key}`
  if (state.attempt?.slot === slot && (state.attempt.count >= MAX_ATTEMPTS || now - state.attempt.at < RETRY_MS)) return undefined
  return due
}

/** The state after trying a slot: sent for good, or one more attempt counted. */
export function afterAttempt(state: SchedState, due: Due, isSent: boolean, now: number): SchedState {
  const slot = `${due.period}:${due.key}`
  if (isSent) return { ...state, [due.period]: due.key, attempt: null }
  const count = state.attempt?.slot === slot ? state.attempt.count + 1 : 1
  return { ...state, attempt: { slot, count, at: now } }
}

/** The days a digest covers, up to now: today so far, or the last seven days including today. */
export function windowFor(period: Period, now: number, zone: string): { from: number; to: number } {
  const today = startOfDay(now, zone)
  return { from: period === 'daily' ? today : addDays(today, -6, zone), to: now }
}

export const parseSchedState = (value: unknown): SchedState => {
  if (typeof value !== 'object' || value === null) return EMPTY_SCHED
  const state = value as Partial<SchedState>
  const attempt = state.attempt
  const isAttempt = typeof attempt === 'object' && attempt !== null && typeof attempt.slot === 'string' && typeof attempt.count === 'number' && typeof attempt.at === 'number'
  const costs: Record<string, number> = {}
  for (const [day, usd] of Object.entries(typeof state.costs === 'object' && state.costs !== null ? state.costs : {})) if (typeof usd === 'number' && Number.isFinite(usd)) costs[day] = usd
  return { daily: typeof state.daily === 'string' ? state.daily : '', weekly: typeof state.weekly === 'string' ? state.weekly : '', attempt: isAttempt ? attempt : null, costs }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** "Daily at 18:00 on weekdays" / "Weekly on Fri at 18:00" / "Off", for the preview header. */
export function scheduleText(schedule: Schedule): string {
  const at = `${two(schedule.sendAt.h)}:${two(schedule.sendAt.mi)}`
  const day = `${(DAY_CODES[schedule.weeklyDay] ?? 'fri').replace(/^./, c => c.toUpperCase())}`
  if (schedule.frequency === 'off') return 'Off (send by hand)'
  if (schedule.frequency === 'daily') return `Daily at ${at}${schedule.skipWeekends ? ' on weekdays' : ''}`
  if (schedule.frequency === 'weekly') return `Weekly on ${day} at ${at}`
  return `Daily at ${at}${schedule.skipWeekends ? ' on weekdays' : ''}, weekly on ${day}`
}

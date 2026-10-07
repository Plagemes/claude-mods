import type { WaPrefs, WaPriority } from '../types'
import { inWindow } from './settings'

const HOUR_MS = 60 * 60 * 1000
/** Critical messages bypass the hourly cap up to this many per hour, so a loop cannot flood the phone. */
const CRITICAL_PER_HOUR = 10

export type Delivery = { action: 'send' | 'digest' | 'drop'; reason: string }

export type DecideInput = {
  priority: WaPriority
  now: number
  prefs: WaPrefs
  notifyMode: 'away' | 'always' | 'off'
  /** The newest keystroke or prompt across every session (ms). */
  lastActiveAt: number
  /** When this machine's sends happened in the last hour (ms each). */
  sentTimes: readonly number[]
  maxPerHour: number
}

/** Whether the owner counts as away: said so, or no keystroke or prompt for the away minutes. */
export const isAway = (prefs: WaPrefs, lastActiveAt: number, now: number): boolean => {
  if (prefs.presence === 'away') return true
  if (prefs.presence === 'here') return false
  return now - lastActiveAt >= prefs.awayMinutes * 60_000
}

/**
 * Decides what to do with one notification: critical goes now (even in quiet hours or while paused),
 * normal goes now when away and outside quiet hours, info waits for the digest. Over the hourly cap,
 * normal waits for the digest too. At the keyboard nothing but critical is sent.
 */
export const decide = (input: DecideInput): Delivery => {
  const { priority, now, prefs } = input
  const recent = input.sentTimes.filter(at => now - at < HOUR_MS)
  if (priority === 'critical') {
    if (input.notifyMode === 'off') return { action: 'drop', reason: 'notifications are off' }
    if (recent.length >= input.maxPerHour + CRITICAL_PER_HOUR) return { action: 'digest', reason: 'hourly cap reached' }
    return { action: 'send', reason: 'critical' }
  }
  if (input.notifyMode === 'off') return { action: 'drop', reason: 'notifications are off' }
  const away = input.notifyMode === 'always' || isAway(prefs, input.lastActiveAt, now)
  if (!away) return { action: 'drop', reason: 'you are at the keyboard' }
  if (prefs.paused) return { action: 'digest', reason: 'notifications paused' }
  if (inWindow(prefs.quietHours, new Date(now).getHours())) return { action: 'digest', reason: 'quiet hours' }
  if (priority === 'info') return { action: 'digest', reason: 'info waits for the digest' }
  if (recent.length >= input.maxPerHour) return { action: 'digest', reason: 'hourly cap reached' }
  return { action: 'send', reason: 'away' }
}

/** Whether a scheduled moment (minutes after midnight) fell between two checks. */
export const crossed = (minuteOfDay: number | null, previous: number, now: number): boolean => {
  if (minuteOfDay === null || previous <= 0 || now <= previous) return false
  const at = new Date(now)
  const target = new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(minuteOfDay / 60), minuteOfDay % 60).getTime()
  return previous < target && target <= now
}

/** The budget thresholds a session's cost passed since the last check. */
export const crossedBudgets = (steps: readonly number[], before: number, after: number): number[] =>
  steps.filter(step => before < step && after >= step)

export const dayKey = (ms: number): string => {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

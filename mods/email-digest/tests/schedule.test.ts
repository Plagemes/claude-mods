import { expect, test } from 'claude-code/testing'

import { EMPTY_SCHED, GRACE_MS, MAX_ATTEMPTS, RETRY_MS, afterAttempt, dueNow, parseSchedState, parseWeekday, scheduleText, windowFor } from '../hooks/schedule'
import type { Schedule } from '../hooks/schedule'
import { readSettings, readiness, secretsOf } from '../hooks/settings'
import { dateKey, epochToWall } from '../hooks/zones'

const ZONE = 'Europe/Rome'
/** Rome local time on a given day of October 2026 (Wed 7 Oct, Fri 9 Oct, Sat 10 Oct). */
const at = (day: number, h: number, m = 0): number => Date.UTC(2026, 9, day, h - 2, m)
const SCHEDULE: Schedule = { frequency: 'daily', sendAt: { h: 18, mi: 0 }, weeklyDay: 5, skipWeekends: true }

test('daily: due from the send time until six hours later, once per day, never on a weekend', () => {
  expect(dueNow(at(7, 17, 59), ZONE, SCHEDULE, EMPTY_SCHED)).toBeUndefined()
  expect(dueNow(at(7, 18, 0), ZONE, SCHEDULE, EMPTY_SCHED)).toEqual({ period: 'daily', key: '2026-10-07' })
  expect(dueNow(at(7, 23, 59), ZONE, SCHEDULE, EMPTY_SCHED)).toEqual({ period: 'daily', key: '2026-10-07' })
  expect(dueNow(at(7, 18, 0) + GRACE_MS + 1, ZONE, SCHEDULE, EMPTY_SCHED)).toBeUndefined()
  expect(dueNow(at(7, 19), ZONE, SCHEDULE, { ...EMPTY_SCHED, daily: '2026-10-07' })).toBeUndefined()
  expect(dueNow(at(8, 18), ZONE, SCHEDULE, { ...EMPTY_SCHED, daily: '2026-10-07' })).toEqual({ period: 'daily', key: '2026-10-08' })
  expect(dueNow(at(10, 18), ZONE, SCHEDULE, EMPTY_SCHED)).toBeUndefined()
  expect(dueNow(at(10, 18), ZONE, { ...SCHEDULE, skipWeekends: false }, EMPTY_SCHED)).toEqual({ period: 'daily', key: '2026-10-10' })
  expect(dueNow(at(7, 20), ZONE, { ...SCHEDULE, frequency: 'off' }, EMPTY_SCHED)).toBeUndefined()
})

test('weekly: only on its day; with "both" the weekly digest replaces the daily one that day', () => {
  const weekly: Schedule = { ...SCHEDULE, frequency: 'weekly' }
  expect(dueNow(at(7, 18), ZONE, weekly, EMPTY_SCHED)).toBeUndefined()
  expect(dueNow(at(9, 18), ZONE, weekly, EMPTY_SCHED)).toEqual({ period: 'weekly', key: '2026-10-09' })
  expect(dueNow(at(9, 18), ZONE, weekly, { ...EMPTY_SCHED, weekly: '2026-10-09' })).toBeUndefined()
  const both: Schedule = { ...SCHEDULE, frequency: 'both' }
  expect(dueNow(at(8, 18), ZONE, both, EMPTY_SCHED)?.period).toBe('daily')
  expect(dueNow(at(9, 18), ZONE, both, EMPTY_SCHED)?.period).toBe('weekly')
  expect(dueNow(at(9, 18), ZONE, both, { ...EMPTY_SCHED, weekly: '2026-10-09' })).toBeUndefined()
})

test('attempts: a failure is retried after 30 minutes, three times at most; success closes the slot', () => {
  const due = { period: 'daily' as const, key: '2026-10-07' }
  let state = afterAttempt(EMPTY_SCHED, due, false, at(7, 18))
  expect(state.attempt).toEqual({ slot: 'daily:2026-10-07', count: 1, at: at(7, 18) })
  expect(dueNow(at(7, 18, 10), ZONE, SCHEDULE, state)).toBeUndefined()
  expect(dueNow(at(7, 18) + RETRY_MS, ZONE, SCHEDULE, state)).toEqual(due)
  state = afterAttempt(state, due, false, at(7, 18, 30))
  state = afterAttempt(state, due, false, at(7, 19))
  expect(state.attempt?.count).toBe(MAX_ATTEMPTS)
  expect(dueNow(at(7, 22), ZONE, SCHEDULE, state)).toBeUndefined()
  const sent = afterAttempt(state, due, true, at(7, 19, 30))
  expect(sent).toMatchObject({ daily: '2026-10-07', attempt: null })
  expect(dueNow(at(7, 19, 31), ZONE, SCHEDULE, sent)).toBeUndefined()
  // Tomorrow is a new slot, whatever happened today.
  expect(dueNow(at(8, 18), ZONE, SCHEDULE, state)).toEqual({ period: 'daily', key: '2026-10-08' })
})

test('windows: today so far, or the last seven days including today', () => {
  const now = at(7, 18)
  const day = windowFor('daily', now, ZONE)
  expect(dateKey(epochToWall(day.from, ZONE))).toBe('2026-10-07')
  expect(day.from).toBe(Date.UTC(2026, 9, 6, 22))
  expect(day.to).toBe(now)
  const week = windowFor('weekly', now, ZONE)
  expect(dateKey(epochToWall(week.from, ZONE))).toBe('2026-10-01')
})

test('state and text helpers', () => {
  expect(parseSchedState({ daily: '2026-10-07', weekly: 3, attempt: { slot: 'daily:x', count: 2, at: 5 }, costs: { '2026-10-07': 4.5, bad: 'x' } })).toEqual({ daily: '2026-10-07', weekly: '', attempt: { slot: 'daily:x', count: 2, at: 5 }, costs: { '2026-10-07': 4.5 } })
  expect(parseSchedState(null)).toEqual(EMPTY_SCHED)
  expect(parseWeekday('Friday', 1)).toBe(5)
  expect(parseWeekday('someday', 1)).toBe(1)
  expect(scheduleText(SCHEDULE)).toBe('Daily at 18:00 on weekdays')
  expect(scheduleText({ ...SCHEDULE, frequency: 'weekly' })).toBe('Weekly on Fri at 18:00')
  expect(scheduleText({ ...SCHEDULE, frequency: 'both', skipWeekends: false })).toBe('Daily at 18:00, weekly on Fri')
  expect(scheduleText({ ...SCHEDULE, frequency: 'off' })).toBe('Off (send by hand)')
})

test('settings: zero config sends nothing; each provider says what it is missing; secrets are listed for masking', () => {
  const none = readSettings({})
  expect(none).toMatchObject({ provider: 'resend', tone: 'client', language: 'en', includeCost: false, schedule: { frequency: 'off', sendAt: { h: 18, mi: 0 }, weeklyDay: 5, skipWeekends: true } })
  expect(readiness(none, '').problem).toContain('sender address')
  const resend = readSettings({ from: 'Acme <digest@acme.com>', resendApiKey: 're_abc' })
  expect(readiness(resend, '').problem).toContain('No recipients')
  expect(readiness(resend, 'ana@client.com')).toEqual({ isReady: true, problem: '' })
  expect(readiness(readSettings({ from: 'digest@acme.com' }), 'a@b.co').problem).toContain('Resend API key')
  expect(readiness(readSettings({ from: 'digest@acme.com', provider: 'sendgrid' }), 'a@b.co').problem).toContain('SendGrid API key')
  expect(readiness(readSettings({ from: 'digest@acme.com', provider: 'sendgrid', sendgridApiKey: 'SG.x' }), 'a@b.co').isReady).toBe(true)
  expect(readiness(readSettings({ from: 'digest@acme.com', provider: 'smtp' }), 'a@b.co').problem).toContain('SMTP address')
  expect(readiness(readSettings({ from: 'digest@acme.com', provider: 'smtp', smtpUrl: 'smtp://relay.local:25' }), 'a@b.co').isReady).toBe(true)
  expect(readiness(readSettings({ from: 'digest@acme.com', provider: 'smtp', smtpUrl: 'http://x' }), 'a@b.co').isReady).toBe(false)
  expect(secretsOf(readSettings({ resendApiKey: 're_abc', smtpPassword: 'pw' }))).toEqual(['re_abc', 'pw'])
  const custom = readSettings({ frequency: 'both', sendAt: '07:30', weeklyDay: 'mon', tone: 'manager', language: 'it', includeCost: true, timezone: 'Europe/Rome', journalDir: '/notes/journal/' })
  expect(custom).toMatchObject({ tone: 'manager', language: 'it', includeCost: true, zone: 'Europe/Rome', journalDir: 'notes/journal', schedule: { frequency: 'both', sendAt: { h: 7, mi: 30 }, weeklyDay: 1 } })
  expect(readSettings({ frequency: 'hourly', sendAt: '25:99', tone: 'loud', language: 'fr' })).toMatchObject({ tone: 'client', language: 'en', schedule: { frequency: 'off', sendAt: { h: 18, mi: 0 } } })
})

import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { calendar, currentStreak, dayNumber, isoOf, localDay, longestStreak, parseIso, parseMilestones } from '../hooks/streak'

const DAY_MS = 86_400_000
/** Noon of 7 October 2026 on the machine's own clock, so the local date is the same wherever the test runs. */
const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()

const world = (on: On, stored: Record<string, unknown> = {}, now = NOON) => {
  const clock = mock.clock(on, { now })
  mock.store(on, stored)
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, statuses, toasts }
}

const prompt = async ($: Engine, clock: { settle: () => Promise<void> }, origin: PromptOrigin = { kind: 'composer' }) => {
  await $.prompt.submit({ text: 'hello', wait: false, origin })
  await clock.settle()
}

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const streak = ($: Engine) =>
  $.command.run({ command: 'streak', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

/** The days in `YYYY-MM-DD` form, counted back from the test's today. */
const daysAgo = (...offsets: number[]) => offsets.map(offset => isoOf(localDay(NOON) - offset))

test('the first prompt of a day records it, and further prompts that day change nothing', async ($, on) => {
  const { clock } = world(on)

  await prompt($, clock)
  await prompt($, clock)
  await prompt($, clock)

  const shown = (await streak($)).text ?? ''
  expect(shown).toContain('Current streak: 1 day\n')
  expect(shown).toContain('Active on 1 of the last 30 days, and on 1 day since 2026-10-07')
})

test('only the person\'s own prompts count', async ($, on) => {
  const { clock } = world(on)

  for (const origin of [{ kind: 'scheduled-trigger' }, { kind: 'task-notification' }, { kind: 'peer' }, { kind: 'plugin', name: 'x' }] as const) {
    await prompt($, clock, origin)
  }
  expect((await streak($)).text).toBe('No days recorded yet. Send a prompt and your streak starts today.')

  await prompt($, clock, { kind: 'plugin', name: 'x', asUser: true })
  expect((await streak($)).text).toContain('Current streak: 1 day')
})

test('a session start shows a streak that is alive for 10 seconds, then clears the status line', async ($, on) => {
  const { clock, statuses } = world(on, { streaks: { days: daysAgo(3, 2, 1), best: null } })

  await startSession($)
  expect(statuses).toEqual(['🔥 3 days streak'])
  await clock.advance(9_999)
  expect(statuses).toHaveLength(1)
  await clock.advance(1)
  expect(statuses).toEqual(['🔥 3 days streak', undefined])
})

test('the persistent option leaves it there', { options: { persistent: true } }, async ($, on) => {
  const { clock, statuses } = world(on, { streaks: { days: daysAgo(2, 1, 0), best: null } })

  await startSession($)
  await clock.advance(60_000)

  expect(statuses).toEqual(['🔥 3 days streak'])
})

test('a streak is shown from two days, and not once a day has been missed', async ($, on) => {
  const { statuses } = world(on, { streaks: { days: daysAgo(1), best: null } })
  await startSession($)
  expect(statuses).toEqual([]) // one day: not much of a streak yet
})

test('after a missed day nothing is shown, and the old streak is the longest', async ($, on) => {
  const { statuses } = world(on, { streaks: { days: daysAgo(9, 8, 7, 6, 5, 4), best: null } })

  await startSession($)
  const shown = (await streak($)).text ?? ''

  expect(statuses).toEqual([])
  expect(shown).toContain('No streak right now: send a prompt to start one.')
  expect(shown).toContain(`Longest streak: 6 days, ended ${daysAgo(4)[0]}`)
})

test('the first prompt of the day extends the streak, refreshes the status and toasts on a milestone', async ($, on) => {
  const { clock, statuses, toasts } = world(on, { streaks: { days: daysAgo(6, 5, 4, 3, 2, 1), best: null } })

  await prompt($, clock)

  expect(statuses).toEqual(['🔥 7 days streak'])
  expect(toasts).toEqual(['🔥 7 days in a row! Milestone reached.'])
  await clock.advance(10_000)
  expect(statuses).toEqual(['🔥 7 days streak', undefined])
})

test('a streak builds over days of use, and the milestones option decides what gets a toast', { options: { milestones: '3, 5' } }, async ($, on) => {
  const { clock, toasts } = world(on)

  for (let day = 0; day < 5; day += 1) {
    await prompt($, clock)
    await clock.advance(DAY_MS)
  }

  expect(toasts).toEqual(['🔥 3 days in a row! Milestone reached.', '🔥 5 days in a row! Milestone reached.'])
  const shown = (await streak($)).text ?? ''
  expect(shown).toContain('Current streak: 5 days (send a prompt today to keep it going)') // the clock is now on the day after the fifth
  expect(shown).toContain('Longest streak: 5 days')
})

test('/streak shows the current and longest streaks and a calendar of the last 30 days', async ($, on) => {
  world(on, { streaks: { days: [...daysAgo(0, 1, 2), ...daysAgo(10, 11, 12, 13, 14, 15, 16)], best: null } })

  const shown = (await streak($)).text ?? ''

  expect(shown.split('\n').slice(0, 3)).toEqual([
    '🔥 Current streak: 3 days',
    `🏆 Longest streak: 7 days, ended ${daysAgo(10)[0]}`,
    `📅 Active on 10 of the last 30 days, and on 10 days since ${daysAgo(16)[0]}`,
  ])
  expect(shown).toContain('      M  T  W  T  F  S  S')
  expect(shown).toContain('[●]') // today
  expect(shown.endsWith('● active day   · quiet day   [ ] today')).toBe(true)
})

test('the best streak is remembered even when its days are no longer kept', async ($, on) => {
  world(on, { streaks: { days: daysAgo(0), best: { length: 45, end: '2025-03-14' } } })

  expect((await streak($)).text).toContain('Longest streak: 45 days, ended 2025-03-14')
})

test('streak maths: current counts back from today or yesterday, longest finds the longest run', () => {
  const day = (n: number) => dayNumber(2026, 0, n)
  const active = new Set([day(1), day(2), day(3), day(5), day(6), day(8), day(9), day(10), day(11)])

  expect(currentStreak(active, day(11))).toBe(4)
  expect(currentStreak(active, day(12))).toBe(4) // yesterday counts: today is still to come
  expect(currentStreak(active, day(13))).toBe(0)
  expect(currentStreak(active, day(7))).toBe(2)
  expect(longestStreak(active)).toEqual({ length: 4, end: day(11) })
  expect(longestStreak(new Set())).toEqual({ length: 0, end: 0 })
})

test('calendar lays the last days out in weeks from Monday, with today in brackets', () => {
  const today = dayNumber(2026, 9, 7) // a Wednesday
  const active = new Set([today, today - 1, today - 8])

  expect(calendar(active, today, 10)).toEqual([
    '       M  T  W  T  F  S  S',
    'Sep 28 ·  ●  ·  ·  ·  ·  ·',
    'Oct 05 ·  ● [●]',
  ])
})

test('dates round-trip, and milestone settings are cleaned up', () => {
  expect(isoOf(dayNumber(2026, 9, 7))).toBe('2026-10-07')
  expect(parseIso('2026-10-07')).toBe(dayNumber(2026, 9, 7))
  expect(parseIso('yesterday')).toBeUndefined()
  expect(parseMilestones('30, 7,100, 7, x, 1, -3')).toEqual([7, 30, 100])
})

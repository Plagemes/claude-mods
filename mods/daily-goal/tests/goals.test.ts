import { expect, test } from 'claude-code/testing'

import { closeGoal, dayLabel, daysBefore, historyText, markAsked, parseRequest, questionFor, readEntries, setGoal, streakOf } from '../hooks/goals'
import type { DailyGoalEntry } from '../types'

const entry = (date: string, text: string, status: DailyGoalEntry['status'] = 'open'): DailyGoalEntry => ({ date, text, setAt: 1, status })

test('reads the command: a goal, done, clear, history', () => {
  expect(parseRequest('')).toEqual({ kind: 'show' })
  expect(parseRequest(' Done ')).toEqual({ kind: 'done' })
  expect(parseRequest('history')).toEqual({ kind: 'history' })
  expect(parseRequest('"Ship the  login fix"')).toEqual({ kind: 'set', text: 'Ship the login fix' })
  expect(parseRequest('x'.repeat(201))).toEqual({ kind: 'usage', reason: 'Keep the goal under 200 characters.' })
})

test('dates, labels and the entries the store holds', () => {
  expect(daysBefore('2026-10-01', 1)).toBe('2026-09-30')
  expect(daysBefore('2026-03-01', 14)).toBe('2026-02-15')
  expect(dayLabel('2026-10-07')).toBe('Wed 07 Oct')
  expect(readEntries({ entries: [entry('2026-10-07', 'b'), entry('2026-10-05', 'a'), { date: 'nope', text: 1 }] }).map(one => one.text)).toEqual(['a', 'b'])
  expect(readEntries(undefined)).toEqual([])

  const set = setGoal([entry('2026-10-07', 'old', 'done')], '2026-10-07', 'new', 5)
  expect(set).toEqual([{ date: '2026-10-07', text: 'new', setAt: 5, status: 'open' }])
  expect(closeGoal(set, '2026-10-07', 'missed', 9)).toEqual([{ date: '2026-10-07', text: 'new', setAt: 5, status: 'missed', closedAt: 9 }])
})

test('asks about an earlier open goal first, then today’s in the evening, once', () => {
  const today = '2026-10-07'
  const entries = [entry('2026-10-05', 'docs'), entry(today, 'ship it')]
  expect(questionFor(entries, today, 9, 18)).toEqual({ date: '2026-10-05', text: 'docs', isToday: false })

  const answered = closeGoal(entries, '2026-10-05', 'done', 2)
  expect(questionFor(answered, today, 17, 18)).toBeNull()
  expect(questionFor(answered, today, 18, 18)).toEqual({ date: today, text: 'ship it', isToday: true })
  expect(questionFor(markAsked(answered, today), today, 21, 18)).toBeNull()
  expect(questionFor([entry('2026-09-20', 'long ago')], today, 9, 18)).toBeNull()
})

test('a goal set after the ask hour is not asked about right away; it waits for the next day', () => {
  const today = '2026-10-07'
  const at = (hour: number): number => new Date(2026, 9, 7, hour, 0).getTime()
  const late = [{ date: today, text: 'late goal', setAt: at(19), status: 'open' as const }]
  expect(questionFor(late, today, 19, 18)).toBeNull()
  expect(questionFor(late, today, 23, 18)).toBeNull()
  expect(questionFor(late, '2026-10-08', 9, 18)).toEqual({ date: today, text: 'late goal', isToday: false })
  const early = [{ date: today, text: 'early goal', setAt: at(10), status: 'open' as const }]
  expect(questionFor(early, today, 17, 18)).toBeNull()
  expect(questionFor(early, today, 18, 18)).toEqual({ date: today, text: 'early goal', isToday: true })
})

test('history shows the last 14 days with ✓ and ✗, and the streak', () => {
  const entries = [
    entry('2026-10-07', 'ship the login fix'),
    entry('2026-10-06', 'write the migration', 'done'),
    entry('2026-10-05', 'fix flaky tests', 'done'),
    entry('2026-10-03', 'refactor billing', 'missed'),
    entry('2026-10-02', 'update docs'),
  ]
  expect(streakOf(entries, '2026-10-07')).toBe(2)
  const text = historyText(entries, '2026-10-07')
  expect(text.split('\n').slice(0, 7)).toEqual([
    '🎯 Goals, last 14 days: 2 of 5 reached · 2-day streak',
    '◦ Wed 07 Oct  ship the login fix',
    '✓ Tue 06 Oct  write the migration',
    '✓ Mon 05 Oct  fix flaky tests',
    '· Sun 04 Oct  (no goal)',
    '✗ Sat 03 Oct  refactor billing',
    '? Fri 02 Oct  update docs',
  ])
  expect(text.split('\n')).toHaveLength(15)
  expect(historyText([], '2026-10-07').split('\n')[0]).toBe('🎯 Goals, last 14 days: no goals set yet')
})

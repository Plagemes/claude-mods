import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

const NOW = new Date(2026, 9, 7, 9, 0).getTime()
const MINUTE = 60_000

/** Stands for the engine: what the plugin shows and plays is recorded. */
const answerEngine = (on: On, stored: Record<string, unknown> = {}) => {
  const engine = { status: [] as (string | undefined)[], toasts: [] as string[], played: [] as string[] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    engine.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    engine.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    engine.played.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  return { engine, clock }
}

const pomodoro = (args: string) =>
  ({ command: 'pomodoro', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('/pomodoro counts down in the status line, rings at the end, and the break follows', { options: { breakMinutes: 1 } }, async ($, on) => {
  const { engine, clock } = answerEngine(on)

  expect((await $.command.run(pomodoro('2'))).text).toBe('🍅 Focus round 1: 2 min, until 09:02.')
  expect(engine.status.at(-1)).toBe('🍅 2:00')

  await clock.advance(MINUTE)
  expect(engine.status.at(-1)).toBe('🍅 1:00')

  await clock.advance(MINUTE)
  expect(engine.toasts).toEqual(['🍅 Round 1 done: take a 1-minute break.'])
  expect(engine.played).toEqual(['assets/bell.wav'])
  expect(engine.status.at(-1)).toBe('☕ 1:00 break')

  await clock.advance(30_000)
  expect(engine.status.at(-1)).toBe('☕ 0:30 break')

  await clock.advance(30_000)
  expect(engine.toasts.at(-1)).toBe('☕ Break over. /pomodoro starts round 2.')
  expect(engine.status.at(-1)).toBeUndefined()
  expect(engine.played).toHaveLength(2)

  expect((await $.command.run(pomodoro('status'))).text).toBe('No timer running · 1 round done this session.')
  expect((await $.command.run(pomodoro(''))).text).toBe('🍅 Focus round 2: 25 min, until 09:28.')
})

test('a timer left in the store resumes at session start, and /pomodoro stop ends it', async ($, on) => {
  const running = { phase: 'focus', endsAt: NOW + 10 * MINUTE, minutes: 25, round: 3 }
  const { engine, clock } = answerEngine(on, { timer: running })

  await $.session.start(START)
  await clock.advance(1_000)
  expect(engine.status.at(-1)).toBe('🍅 9:59')
  expect((await $.command.run(pomodoro('status'))).text).toBe('🍅 Focus round 3: 9:59 left · 0 rounds done this session.')

  expect((await $.command.run(pomodoro('stop'))).text).toBe('Stopped.')
  expect(engine.status.at(-1)).toBeUndefined()
  await clock.advance(10 * MINUTE)
  expect(engine.toasts).toHaveLength(0)
})

test('a timer that ended long before the session started stays quiet', async ($, on) => {
  const { engine, clock } = answerEngine(on, { timer: { phase: 'break', endsAt: NOW - 60 * MINUTE, minutes: 5, round: 1 } })

  await $.session.start(START)
  await clock.advance(5_000)
  expect(engine.status).toHaveLength(0)
  expect(engine.toasts).toHaveLength(0)
  expect((await $.command.run(pomodoro('status'))).text).toBe('No timer running · 0 rounds done this session.')
})

test('bad durations are refused, and with the sound off nothing plays', { options: { sound: false, breakMinutes: 0 } }, async ($, on) => {
  const { engine, clock } = answerEngine(on)

  expect((await $.command.run(pomodoro('forever'))).text).toContain('is not a duration from 1 to 240 minutes')
  expect((await $.command.run(pomodoro('stop'))).text).toBe('No timer running.')

  await $.command.run(pomodoro('1'))
  await clock.advance(MINUTE)
  expect(engine.toasts).toEqual(['🍅 Round 1 done. /pomodoro starts the next one.'])
  expect(engine.status.at(-1)).toBeUndefined()
  expect(engine.played).toHaveLength(0)
})

test('with mods-hub: a focus round silences the other mods, is published, and its end reaches you when away', { options: { breakMinutes: 1 } }, async ($, on) => {
  const { engine, clock } = answerEngine(on)
  const hub = fakeHub(on, {}, clock)

  await $.session.start(START)
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['focus.started', 'focus.ended'], consumes: ['session.away'] }])

  await $.command.run(pomodoro('2'))
  expect(hub.published).toEqual([{ topic: 'focus.started', data: { minutes: 2 } }])
  expect(hub.modes).toEqual([{ silentMinutes: 2 }])
  expect(hub.mode.isSilent).toBe(true)

  await clock.advance(2 * MINUTE)
  expect(hub.modes.at(-1)).toEqual({ silentMinutes: null })
  expect(hub.published.at(-1)).toEqual({ topic: 'focus.ended', data: { minutes: 2, isCompleted: true } })
  expect(hub.notified).toEqual([{ level: 'info', title: '🍅 Round 1 done: take a 1-minute break.', topic: 'focus.ended' }])
  expect(engine.toasts).toEqual([])
  expect(engine.played).toEqual(['assets/bell.wav'])

  // Stepped away during the break: its end goes to your channels too.
  hub.mode = { ...hub.mode, presence: 'away' }
  await clock.advance(MINUTE)
  expect(hub.notified.at(-1)).toEqual({ level: 'success', title: '☕ Break over. /pomodoro starts round 2.', topic: 'focus.ended' })
  expect(hub.published).toHaveLength(2)
})

test('with mods-hub: Silent already on is left alone, and a stopped round is published as not completed', async ($, on) => {
  const { clock } = answerEngine(on)
  const hub = fakeHub(on, { isSilent: true }, clock)

  await $.command.run(pomodoro('25'))
  await clock.advance(10 * MINUTE)
  await $.command.run(pomodoro('stop'))
  expect(hub.modes).toEqual([])
  expect(hub.published).toEqual([
    { topic: 'focus.started', data: { minutes: 25 } },
    { topic: 'focus.ended', data: { minutes: 10, isCompleted: false } },
  ])
})

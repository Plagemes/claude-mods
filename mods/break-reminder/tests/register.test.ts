import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

const MINUTE = 60_000

// Stands for the engine: a clock that only the test moves, a store in memory, and a toast recorder.
const engine = (on: On, isInteractive = true) => {
  const clock = mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive })
  return { clock, toasts, start }
}

const prompt = ($: Engine) => $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })

// One prompt every four minutes: the person is at the keyboard throughout.
const work = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, minutes: number) => {
  for (let spent = 0; spent < minutes; spent += 4) {
    await prompt($)
    await clock.advance(Math.min(4, minutes - spent) * MINUTE)
  }
}

test('reminds after 50 minutes of active work, not before', async ($, on) => {
  const { clock, toasts, start } = engine(on)
  await start($)

  await work($, clock, 44)
  expect(toasts).toHaveLength(0)

  await work($, clock, 8)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('min of active work')
})

test('idle time does not count as work', async ($, on) => {
  const { clock, toasts, start } = engine(on)
  await start($)

  await prompt($)
  await clock.advance(180 * MINUTE)

  expect(toasts).toHaveLength(0)
})

test('a long turn counts as work even without new prompts', async ($, on) => {
  const { clock, toasts, start } = engine(on)
  await start($)

  await $.turn.start({ text: 'refactor everything', turnId: 't1' })
  await clock.advance(55 * MINUTE)

  expect(toasts).toHaveLength(1)
})

test('rotates the reminder and keeps counting afterwards', async ($, on) => {
  const { clock, toasts, start } = engine(on)
  await start($)

  await work($, clock, 52)
  await work($, clock, 52)

  expect(toasts).toHaveLength(2)
  expect(toasts[1]?.split(' (')[0]).not.toBe(toasts[0]?.split(' (')[0])
})

test('minutes sets the interval', { options: { minutes: 10, idleMinutes: 5 } }, async ($, on) => {
  const { clock, toasts, start } = engine(on)
  await start($)

  await work($, clock, 12)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('(10 min of active work)')
})

test('stays silent in a headless run', async ($, on) => {
  const { clock, toasts, start } = engine(on, false)
  await start($)

  await work($, clock, 60)

  expect(toasts).toHaveLength(0)
})

test('with mods-hub: the reminder is a terminal notice, waits out a focus round, and a round\'s end or being away resets the count', async ($, on) => {
  const { clock, toasts, start } = engine(on)
  const hub = fakeHub(on, {}, clock)
  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['session.idle', 'session.away', 'focus.started', 'focus.ended'] }])

  await work($, clock, 52)
  expect(toasts).toEqual([])
  expect(hub.notified).toHaveLength(1)
  expect(hub.notified[0]?.level).toBe('info')
  expect(hub.notified[0]?.audience).toBe('terminal')
  expect(hub.notified[0]?.title).toContain('min of active work')

  // A 60-minute focus round: no reminder in the middle of it.
  hub.events.push({ topic: 'focus.started', source: 'focus-timer', at: clock.now(), data: { minutes: 60 } })
  await work($, clock, 56)
  expect(hub.notified).toHaveLength(1)

  // The round ends (its own break starts): the count starts over.
  hub.events.push({ topic: 'focus.ended', source: 'focus-timer', at: clock.now(), data: { minutes: 60, isCompleted: true } })
  await work($, clock, 44)
  expect(hub.notified).toHaveLength(1)

  // Away (no activity in any session): a break, the count starts over again.
  hub.mode = { ...hub.mode, presence: 'away' }
  await clock.advance(MINUTE)
  hub.mode = { ...hub.mode, presence: 'here' }
  await work($, clock, 44)
  expect(hub.notified).toHaveLength(1)
  await work($, clock, 8)
  expect(hub.notified).toHaveLength(2)
})

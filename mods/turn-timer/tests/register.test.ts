import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

type Spy = { statuses: (string | undefined)[]; toasts: string[] }

const answerEngine = (on: On): Spy => {
  const spy: Spy = { statuses: [], toasts: [] }
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', (_$, e) => {
    spy.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    spy.toasts.push(e.text)
    return { value: undefined }
  })
  return spy
}

const turn = (seconds: number, extra: { isAborted?: boolean; agentId?: string } = {}) => ({
  reason: extra.isAborted ? ('aborted' as const) : ('answer' as const),
  answer: 'done',
  durationMs: seconds * 1000,
  isAborted: extra.isAborted ?? false,
  turnId: 't',
  ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
})

test('shows the last turn and the average in the status line', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(34))
  expect(spy.statuses.at(-1)).toBe('last 34s · avg 34s')

  await $.turn.complete(turn(8))
  expect(spy.statuses.at(-1)).toBe('last 8s · avg 21s')
  expect(spy.toasts).toHaveLength(0)
})

test('toasts when a turn runs past the threshold, in minutes and seconds', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(120))
  expect(spy.toasts).toHaveLength(0)

  await $.turn.complete(turn(125))
  expect(spy.toasts).toEqual(['That turn took 2m 05s'])
  expect(spy.statuses.at(-1)).toBe('last 2m 05s · avg 2m 03s')
})

test('ignores interrupted turns and subagent turns', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(500, { isAborted: true }))
  await $.turn.complete(turn(500, { agentId: 'agent-1' }))
  expect(spy.statuses).toHaveLength(0)
  expect(spy.toasts).toHaveLength(0)
})

test('the threshold is configurable', { options: { thresholdSeconds: 10 } }, async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(11))
  expect(spy.toasts).toHaveLength(1)
})

test('a threshold of 0 never toasts', { options: { thresholdSeconds: 0 } }, async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(3600))
  expect(spy.toasts).toHaveLength(0)
  expect(spy.statuses.at(-1)).toBe('last 1h 00m · avg 1h 00m')
})

test('/clear starts the timings over', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn(40))
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  expect(spy.statuses.at(-1)).toBeUndefined()

  await $.turn.complete(turn(10))
  expect(spy.statuses.at(-1)).toBe('last 10s · avg 10s')
})

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

test('with mods-hub: says hello and announces a long turn as an info notice with its tool count', async ($, on) => {
  const clock = mock.clock(on)
  const spy = answerEngine(on)
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  await $.session.start(START)
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['turn.finished'] }])

  hub.events.push({ topic: 'turn.finished', data: { durationMs: 125_000, tools: 14, isAborted: false }, at: 1, source: 'mods-hub' })
  await $.turn.complete(turn(125))
  await clock.advance(300)
  expect(hub.notified).toEqual([{ level: 'info', title: 'That turn took 2m 05s', body: '14 tool calls' }])
  expect(spy.toasts).toEqual([])
  expect(spy.statuses.at(-1)).toBe('last 2m 05s · avg 2m 05s')
})

test('with mods-hub but no turn.finished for that turn, the notice has no tool count', async ($, on) => {
  const clock = mock.clock(on)
  const spy = answerEngine(on)
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  await $.session.start(START)
  await clock.advance(1_500)
  hub.events.push({ topic: 'turn.finished', data: { durationMs: 5000, tools: 2, isAborted: false }, at: 1, source: 'mods-hub' })
  await $.turn.complete(turn(130))
  await clock.advance(300)
  expect(hub.notified).toEqual([{ level: 'info', title: 'That turn took 2m 10s' }])
  expect(spy.toasts).toEqual([])
})

test('without mods-hub the long-turn notice is the same toast as before', async ($, on) => {
  const spy = answerEngine(on)
  await $.session.start(START)
  await $.turn.complete(turn(125))
  expect(spy.toasts).toEqual(['That turn took 2m 05s'])
})

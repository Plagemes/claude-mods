import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

type Spy = { statuses: (string | undefined)[]; toasts: string[] }

const answerEngine = (on: On): Spy => {
  const spy: Spy = { statuses: [], toasts: [] }
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
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

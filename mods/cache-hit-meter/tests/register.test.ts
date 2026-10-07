import { test, expect } from 'claude-code/testing'
import type { ModelUsage, On } from 'claude-code'

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

const turn = (usage: Partial<ModelUsage>, agentId?: string) => ({
  reason: 'answer' as const,
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: 't',
  ...(agentId === undefined ? {} : { agentId }),
  usage: {
    model: 'm',
    input_tokens: 0,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...usage,
  },
})

test('shows the cache share of a turn, then session and last turn', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }))
  expect(spy.statuses.at(-1)).toBe('cache 80%')

  await $.turn.complete(turn({ input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }))
  expect(spy.statuses.at(-1)).toBe('cache 40% · last 0%')
})

test('toasts once when the session share stays under the threshold after 5 turns', async ($, on) => {
  const spy = answerEngine(on)
  const miss = turn({ input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 890 })

  for (let i = 0; i < 4; i++) await $.turn.complete(miss)
  expect(spy.toasts).toHaveLength(0)

  await $.turn.complete(miss)
  expect(spy.toasts).toHaveLength(1)
  expect(spy.toasts[0]).toContain('1%')

  await $.turn.complete(miss)
  expect(spy.toasts).toHaveLength(1)
})

test('stays quiet while the cache works and ignores subagent turns', async ($, on) => {
  const spy = answerEngine(on)
  const hit = turn({ input_tokens: 10, cache_read_input_tokens: 980, cache_creation_input_tokens: 10 })

  for (let i = 0; i < 6; i++) await $.turn.complete(hit)
  expect(spy.toasts).toHaveLength(0)

  const before = spy.statuses.length
  await $.turn.complete(turn({ input_tokens: 1000 }, 'agent-1'))
  expect(spy.statuses).toHaveLength(before)
})

test('the threshold comes from the configuration', { options: { warnBelow: 90, afterTurns: 1 } }, async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn({ input_tokens: 200, cache_read_input_tokens: 800 }))
  expect(spy.toasts).toHaveLength(1)
})

test('/clear starts the counters over', async ($, on) => {
  const spy = answerEngine(on)

  await $.turn.complete(turn({ input_tokens: 1000 }))
  expect(spy.statuses.at(-1)).toBe('cache 0%')

  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  expect(spy.statuses.at(-1)).toBeUndefined()

  await $.turn.complete(turn({ cache_read_input_tokens: 1000 }))
  expect(spy.statuses.at(-1)).toBe('cache 100%')
})

import { test, expect } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

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

const turn = (usage: Partial<TurnUsage>, agentId?: string) => ({
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

const MANIFEST = '{"version":"1.0.0"}'

test('with mods-hub: the status line adds what the cache saved against the hub\'s session spend', async ($, on) => {
  const spy = answerEngine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: MANIFEST }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['cost.update'] }])

  // Opus 5.5 ($4 in, $0.20 cache read): 1,000,000 cached tokens save $3.80.
  hub.events.push({ topic: 'cost.update', data: { turnUsd: 1, sessionUsd: 11.4, model: 'claude-opus-5-5', tokens: 1, isEstimate: false }, at: 1, source: 'mods-hub' })
  await $.turn.complete(turn({ model: 'claude-opus-5-5', input_tokens: 0, cache_read_input_tokens: 1_000_000 }))
  expect(spy.statuses.at(-1)).toBe('cache 100% · saved $3.80 (25% off)')

})

test('with mods-hub, the low-cache warning goes through its notifications, not a toast', async ($, on) => {
  const spy = answerEngine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: MANIFEST }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const miss = turn({ input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 890 })
  for (let i = 0; i < 5; i++) await $.turn.complete(miss)
  expect(hub.notified.map(notice => [notice.level, notice.title])).toEqual([['info', 'Only 1% of input came from the prompt cache (5 turns)']])
  expect(spy.toasts).toEqual([])
})

test('with mods-hub but no cost.update yet, only the saving is shown; a turn with no cache reads shows none', async ($, on) => {
  const spy = answerEngine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: MANIFEST }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toHaveLength(1)
  await $.turn.complete(turn({ input_tokens: 1000 }))
  expect(spy.statuses.at(-1)).toBe('cache 0%')
  await $.turn.complete(turn({ model: 'claude-opus-5-5', cache_read_input_tokens: 500_000 }))
  expect(spy.statuses.at(-1)).toMatch(/^cache 100% · last 100% · saved \$1\.90$/)
})

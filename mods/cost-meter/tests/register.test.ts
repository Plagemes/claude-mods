import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const TYPED = { command: 'cost-reset', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

/** 128,000 tokens in all: 8k input, 4k output, 100k cache reads, 16k cache writes. */
const USAGE = { input_tokens: 8000, output_tokens: 4000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 16_000 }

const turn = (model: string, agentId?: string) =>
  ({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', agentId, usage: { ...USAGE, model } }) as const

/** Stands in for the engine: state kept in memory, the status lines recorded. */
function engine(on: On) {
  const lines: Array<string | undefined> = []
  const store = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_$, e) => ({ value: store.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const key = `${e.plugin}/${e.key}`
    const version = (store.get(key)?.version ?? 0) + 1
    store.set(key, { value: e.value, version })
    return { value: { isSet: true as const, version } }
  })
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return lines
}

test('prices a turn from its real usage and model: Sonnet 5.5 and Opus 4.6', async ($, on) => {
  const lines = engine(on)
  await $.turn.complete(turn('claude-sonnet-5-5'))
  await $.turn.complete(turn('claude-opus-4-6'))
  // Sonnet: 8k*2 + 4k*10 + 100k*0.2 + 16k*2.5 = $0.116; Opus 4.6: 8k*5 + 4k*25 + 100k*0.5 + 16k*6.25 = $0.29
  expect(lines).toEqual(['$0.12 · 128k tok', '$0.41 · 256k tok'])
})

test('counts subagent turns, skips turns without usage, and marks unknown models as a guess', async ($, on) => {
  const lines = engine(on)
  await $.turn.complete(turn('claude-haiku-4-5', 'agent-1'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  await $.turn.complete(turn('some-gateway-model'))
  // Haiku 4.5: 8k*1 + 4k*5 + 100k*0.1 + 16k*1.25 = $0.058; unknown models are priced as a Sonnet 5 ($0.116)
  expect(lines).toEqual(['$0.06 · 128k tok', '~$0.17 · 256k tok'])
})

test('shows the meter when the session starts, and /cost-reset clears it', async ($, on) => {
  const lines = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn('claude-sonnet-5-5'))
  const reset = await $.command.run({ ...TYPED })
  expect(reset.text).toContain('counters reset (they read $0.12 · 128k tok)')
  expect(lines).toEqual(['$0.00 · 0 tok', '$0.12 · 128k tok', '$0.00 · 0 tok'])
})

test('formats small costs and large token counts', async ($, on) => {
  const lines = engine(on)
  await $.turn.complete({ ...turn('claude-haiku-4-5'), usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-4-5' } })
  await $.turn.complete({ ...turn('claude-fable-5-1'), usage: { input_tokens: 2_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-fable-5-1' } })
  expect(lines).toEqual(['<$0.01 · 120 tok', '$20.00 · 2.0M tok'])
})

test('a pricing override JSON wins over the built-in table', { options: { pricing: '{"sonnet":{"input":3,"output":15}}' } }, async ($, on) => {
  const lines = engine(on)
  await $.turn.complete(turn('claude-sonnet-5-5'))
  // input 3, output 15, cacheRead 0.3, cacheWrite 3.75: 24k + 60k + 30k + 60k = $0.174
  expect(lines).toEqual(['$0.17 · 128k tok'])
})

test('showTokens: false leaves just the cost, and a broken override is ignored', { options: { showTokens: false, pricing: '{not json' } }, async ($, on) => {
  const lines = engine(on)
  await $.turn.complete(turn('claude-sonnet-5-5'))
  expect(lines).toEqual(['$0.12'])
})

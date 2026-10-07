import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fallbackReason, filesMatching, glimpseOf, parseReasons } from '../hooks/why'
import type { WhyEntry } from '../hooks/why'

const ROOT = '/work/shop'
const KEY = `why:${ROOT}`
const USAGE = { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = { clock: MockClock; asked: { model: string; prompt: string }[]; store: Map<string, unknown>; reply: { text: string | undefined } }

function world(on: On): World {
  const seen: World = { clock: mock.clock(on, { now: new Date(2026, 9, 7, 14, 32).getTime() }), asked: [], store: new Map(), reply: { text: undefined } }
  on('store.get', ($, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', ($, e) => ('file_path' in e && String(e.file_path).includes('locked') ? { isError: true, result: 'EACCES', text: 'EACCES' } : { result: 'ok' }))
  on('model.complete', ($, e) => {
    seen.asked.push({ model: e.model, prompt: e.prompt })
    const text = seen.reply.text
    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const why = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'why', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

const entries = (seen: World): WhyEntry[] => (seen.store.get(KEY) as WhyEntry[] | undefined) ?? []

test('reads reasons defensively and finds files by path or name', async () => {
  expect(glimpseOf('\n  }\n  return round(sum)\n')).toBe('return round(sum)')
  expect(parseReasons('```json\n{"src/cart.ts": "- Round totals to cents", "money.ts": "Add a helper", "x.ts": 3}\n```', ['src/cart.ts', 'src/money.ts'])).toEqual(
    new Map([
      ['src/cart.ts', 'Round totals to cents'],
      ['src/money.ts', 'Add a helper'],
    ]),
  )
  expect(fallbackReason('Rounded the total. Also added tests.')).toBe('Turn summary: Rounded the total.')
  const log = ['src/cart.ts', 'lib/cart.ts', 'README.md'].map(file => ({ file, at: 0, turnId: 't', prompt: '', reason: 'r', edits: 1 }))
  expect(filesMatching(log, 'src/cart.ts')).toEqual(['src/cart.ts'])
  expect(filesMatching(log, 'cart.ts')).toEqual(['src/cart.ts', 'lib/cart.ts'])
  expect(filesMatching(log, 'README.md')).toEqual(['README.md'])
})

test('records each changed file with a one-line reason from the small model; /why shows the last turn', async ($, on) => {
  const seen = world(on)
  seen.reply.text = '{"src/cart.ts": "Skip free items and round the total to cents", "src/money.ts": "Add a shared rounding helper"}'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Round the cart total to cents\nand skip free items', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'a', new_string: 'if (item.price > 0) sum += item.price' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'b', new_string: 'return round(sum)' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/money.ts`, content: 'export const round = (n) => Math.round(n * 100) / 100' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/locked.ts`, content: 'x' })
  await $.turn.complete({ answer: 'Rounded the total and skipped free items.', durationMs: 8_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.advance(0)

  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]?.model).toBe('haiku')
  expect(seen.asked[0]?.prompt).toContain('Round the cart total to cents and skip free items')
  expect(seen.asked[0]?.prompt).toContain('- src/cart.ts (2 edits): if (item.price > 0) sum += item.price')
  expect(seen.asked[0]?.prompt).toContain('- src/money.ts (1 edit): export const round')
  expect(seen.asked[0]?.prompt).not.toContain('locked')
  expect(entries(seen).map(entry => [entry.file, entry.reason, entry.edits])).toEqual([
    ['src/cart.ts', 'Skip free items and round the total to cents', 2],
    ['src/money.ts', 'Add a shared rounding helper', 1],
  ])

  expect(await why($)).toBe(
    [
      'Last change, 2026-10-07 14:32 · asked: "Round the cart total to cents and skip free items"',
      '- src/cart.ts: Skip free items and round the total to cents (2 edits)',
      '- src/money.ts: Add a shared rounding helper',
    ].join('\n'),
  )
})

test('/why <file> lists its history newest first; a failed model falls back to the summary', async ($, on) => {
  const seen = world(on)
  seen.reply.text = '{"src/cart.ts": "Add the cart total"}'
  await $.turn.start({ text: 'Add a cart total', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/cart.ts`, content: 'export function total() {}' })
  await $.turn.complete({ answer: 'Added total().', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.advance(60 * 60 * 1000)

  seen.reply.text = undefined
  await $.turn.start({ text: 'Fix the rounding bug', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: 'Fixed the rounding in total(). Tests pass.', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await seen.clock.advance(0)

  await $.turn.start({ text: 'What does total do?', turnId: 't3' })
  await $.turn.complete({ answer: 'It sums.', durationMs: 1_000, isAborted: false, turnId: 't3', reason: 'answer' })
  await seen.clock.advance(0)

  expect(await why($, 'cart.ts')).toBe(
    [
      'src/cart.ts · 2 recorded changes',
      '- 2026-10-07 15:32: Turn summary: Fixed the rounding in total().',
      '    asked: "Fix the rounding bug"',
      '- 2026-10-07 14:32: Add the cart total',
      '    asked: "Add a cart total"',
    ].join('\n'),
  )
  expect(await why($)).toContain('asked: "Fix the rounding bug"')
  expect(await why($, `${ROOT}/src/cart.ts`)).toContain('2 recorded changes')
  expect(await why($, 'src/nope.ts')).toContain('No recorded changes for src/nope.ts')
})

test('a turn cut short by the end of the session is still recorded', async ($, on) => {
  const seen = world(on)
  await $.turn.start({ text: 'Refactor checkout', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/checkout.ts`, old_string: 'a', new_string: 'b' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(entries(seen).map(entry => entry.reason)).toEqual(['(the session ended before this turn finished)'])
  expect(seen.asked).toEqual([])
})

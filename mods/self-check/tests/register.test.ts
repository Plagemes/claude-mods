import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelForkResult, On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { fixPrompt, parseVerdict } from '../hooks/verdict'
import { fakeHub } from './hub'

const ROOT = '/work/shop'
const USAGE = { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0 }
const REQUEST = 'Add a discount code field to checkout and cover it with tests'
const GAPS = '{"complete": false, "gaps": ["No test covers an expired discount code.", "The TODO in applyDiscount() is still there."]}'
const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 14,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 14 },
  view: {},
}

type World = { clock: MockClock; forks: string[]; submitted: string[]; statuses: (string | undefined)[]; toasts: string[]; reply: { text: string } }

function world(on: On): World {
  const seen: World = { clock: mock.clock(on), forks: [], submitted: [], statuses: [], toasts: [], reply: { text: GAPS } }
  on('session.root', () => ({ value: ROOT }))
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    const value: ModelForkResult = { isAnswered: true, text: seen.reply.text, usage: USAGE }
    return { value }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  return seen
}

const ended = (turnId: string, reason: 'answer' | 'aborted' = 'answer'): TurnCompleteInput => ({
  answer: 'Added the discount field and tests; everything passes.',
  durationMs: 30_000,
  isAborted: reason === 'aborted',
  turnId,
  reason,
})

/** One main-loop turn for `text` that edits `files`, then lets the check run. */
async function editingTurn($: Engine, seen: World, turnId: string, text: string, files: string[], reason: 'answer' | 'aborted' = 'answer') {
  await $.turn.start({ text, turnId })
  for (const file of files) await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(ended(turnId, reason))
  await seen.clock.advance(0)
}

test('reads the verdict defensively and words the fix as the person', async () => {
  expect(parseVerdict('```json\n' + GAPS + '\n```')).toEqual({
    isComplete: false,
    gaps: ['No test covers an expired discount code.', 'The TODO in applyDiscount() is still there.'],
  })
  expect(parseVerdict('{"complete": true, "gaps": []}')).toEqual({ isComplete: true, gaps: [] })
  expect(parseVerdict('{"complete": false, "gaps": []}')).toEqual({ isComplete: true, gaps: [] })
  expect(parseVerdict('Looks fine to me!')).toBeUndefined()
  expect(parseVerdict('{"complete": "maybe"}')).toBeUndefined()
  expect(parseVerdict(JSON.stringify({ complete: false, gaps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))?.gaps).toHaveLength(5)
  expect(fixPrompt(['one', 'two'])).toContain('found these gaps against my request:\n1. one\n2. two')
})

test('after an editing turn it forks a checklist and shows the gaps with Fix gaps / Dismiss', async ($, on) => {
  const seen = world(on)
  await editingTurn($, seen, 't1', REQUEST, ['src/checkout.ts', 'test/checkout.test.ts'])

  expect(seen.forks).toHaveLength(1)
  expect(seen.forks[0]).toContain(REQUEST)
  expect(seen.forks[0]).toContain('Files edited in that turn: src/checkout.ts, test/checkout.test.ts')
  expect(seen.forks[0]).toContain('Added the discount field and tests')
  expect(seen.forks[0]).toContain('"complete"')
  expect(seen.statuses.at(-1)).toBe('⚠ self-check: 2 gaps')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'self-check', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ key: 'self-check' }))?.text).toContain('Self-check: 2 gaps in the last turn')
    expect((await band.find({ key: 'gap:0' }))?.text).toContain('expired discount code')
    expect((await band.find({ key: 'fix' }))?.props.label).toBe('Fix gaps')
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: 'self-check', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'fix' })
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('1. No test covers an expired discount code.')
  expect(await band.find({ key: 'self-check' })).toBeUndefined()
  await band.unmount()

  // The fix turn is never checked again: one round at most.
  await editingTurn($, seen, 't2', seen.submitted[0] ?? '', ['test/checkout.test.ts'])
  expect(seen.forks).toHaveLength(1)
})

test('turns without edits, interrupted turns and subagent turns are not checked', async ($, on) => {
  const seen = world(on)
  await editingTurn($, seen, 't1', 'What does applyDiscount do?', [])
  await editingTurn($, seen, 't2', REQUEST, ['src/checkout.ts'], 'aborted')
  await $.turn.complete({ ...ended('sub'), agentId: 'agent-1' })
  await seen.clock.advance(0)
  expect(seen.forks).toEqual([])
  expect(seen.submitted).toEqual([])
})

test('a complete verdict only says so on the status line; Dismiss clears gaps', async ($, on) => {
  const seen = world(on)
  seen.reply.text = '{"complete": true, "gaps": []}'
  await editingTurn($, seen, 't1', REQUEST, ['src/checkout.ts'])
  expect(seen.statuses.at(-1)).toBe('✓ self-check: done as asked')
  const quiet = await $.ui.mount({ plugin: 'self-check', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await quiet.find({ key: 'self-check' })).toBeUndefined()
  await quiet.unmount()

  seen.reply.text = GAPS
  await editingTurn($, seen, 't2', REQUEST, ['src/checkout.ts'])
  const band = await $.ui.mount({ plugin: 'self-check', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'dismiss' })
  expect(await band.find({ key: 'self-check' })).toBeUndefined()
  await band.unmount()
  expect(seen.submitted).toEqual([])
})

test('auto mode sends the gaps back once, but never when a newer turn has started', { options: { mode: 'auto' } }, async ($, on) => {
  const seen = world(on)
  await editingTurn($, seen, 't1', REQUEST, ['src/checkout.ts'])
  expect(seen.submitted).toHaveLength(1)
  expect(seen.toasts.at(-1)).toContain('2 gaps found · asked Claude to close them')

  await editingTurn($, seen, 't2', seen.submitted[0] ?? '', ['src/checkout.ts'])
  expect(seen.forks).toHaveLength(1)
  expect(seen.submitted).toHaveLength(1)

  // The person starts another turn before the check answers: the verdict is stale and nothing is sent.
  await $.turn.start({ text: REQUEST, turnId: 't3' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'x' })
  await $.turn.complete(ended('t3'))
  await $.turn.start({ text: 'and now the docs', turnId: 't4' })
  await seen.clock.advance(0)
  expect(seen.forks).toHaveLength(2)
  expect(seen.submitted).toHaveLength(1)
})

test('with mods-hub: says hello, publishes agent.finished for each check, and announces the auto-fix as an info notice', { options: { mode: 'auto' } }, async ($, on) => {
  const seen = world(on)
  const hub = fakeHub(on, {}, seen.clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['agent.finished'], consumes: [] }])

  await editingTurn($, seen, 't1', REQUEST, ['src/checkout.ts'])
  expect(hub.published).toEqual([{ topic: 'agent.finished', data: { agentType: 'self-check', outcome: 'ok', durationMs: 0 } }])
  expect(hub.notified).toEqual([{ level: 'info', title: '🔎 2 gaps found · asked Claude to close them' }])
  expect(seen.toasts).toEqual([])

  seen.reply.text = 'not json at all'
  await editingTurn($, seen, 't2', REQUEST, ['src/checkout.ts']) // the fix turn auto mode asked for: not checked again
  expect(hub.published).toHaveLength(1)
  await editingTurn($, seen, 't3', REQUEST, ['src/checkout.ts'])
  expect(hub.published.at(-1)).toEqual({ topic: 'agent.finished', data: { agentType: 'self-check', outcome: 'failed', durationMs: 0 } })
})

test('without mods-hub the auto-fix message is the same toast and nothing is published', { options: { mode: 'auto' } }, async ($, on) => {
  const seen = world(on)
  await editingTurn($, seen, 't1', REQUEST, ['src/checkout.ts'])
  expect(seen.toasts.at(-1)).toContain('2 gaps found · asked Claude to close them')
})

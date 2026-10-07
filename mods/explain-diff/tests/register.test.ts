import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { cutDiff, unifiedDiff } from '../hooks/diff'
import { parseExplanation } from '../hooks/explain'

const ROOT = '/work/shop'
const CART = `${ROOT}/src/cart.ts`
const USAGE = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BEFORE = ['export function total(items) {', '  let sum = 0', '  for (const item of items) sum += item.price', '  return sum', '}', ''].join('\n')
const REPLY = JSON.stringify({
  summary: 'The cart total now ignores **free** items and rounds to cents.',
  files: [
    { path: 'src/cart.ts', what: 'Skips items priced 0 and rounds.', why: 'Floating point totals.', risks: 'none', test: 'Run `npm test -- cart`.' },
    { path: 'src/money.ts', what: 'New `round()` helper.', why: 'Shared rounding.', risks: 'Negative amounts.', test: 'Unit test it.' },
  ],
})
const PANE: RenderPropsOf['Pane'] = {
  title: 'Explain diff',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = { clock: MockClock; files: Map<string, string>; asked: { model: string; prompt: string }[]; reply: { text: string | undefined } }

function world(on: On, stored: Record<string, unknown> = {}): World {
  const seen: World = { clock: mock.clock(on, { now: 5_000 }), files: new Map([[CART, BEFORE]]), asked: [], reply: { text: REPLY } }
  mock.store(on, stored)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  // The tools really change the files, as the engine's would.
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') seen.files.set(e.file_path, (seen.files.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    if (e.tool === 'Write') seen.files.set(e.file_path, e.content)
    return { result: 'ok' }
  })
  on('model.complete', ($, e) => {
    seen.asked.push({ model: e.model, prompt: e.prompt })
    const text = seen.reply.text
    return { value: text === undefined ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } : { isAnswered: true, text, usage: USAGE } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const explainDiff = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'explain-diff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

/** A turn that fixes the cart total and adds a helper file. */
async function fixTurn($: Engine, seen: World): Promise<void> {
  await $.turn.start({ text: 'Round the cart total to cents and skip free items', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: CART, old_string: '  for (const item of items) sum += item.price', new_string: '  for (const item of items) if (item.price > 0) sum += item.price' })
  await $.tool.call({ tool: 'Edit', file_path: CART, old_string: '  return sum', new_string: '  return round(sum)' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/money.ts`, content: 'export const round = (n) => Math.round(n * 100) / 100\n' })
  await $.turn.complete({ answer: 'Rounded the total and skipped free items.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.advance(0)
}

test('builds unified hunks that parse, and cuts them without breaking a header', async () => {
  const diff = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
  expect(diff).toEqual({ text: '@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e', added: 2, removed: 1 })
  expect(unifiedDiff('', 'x\ny\n').text).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
  expect(unifiedDiff('same\n', 'same\n').text).toBe('')

  const far = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const changed = far.map((line, i) => (i === 2 || i === 30 ? `${line}!` : line))
  const twoHunks = unifiedDiff(far.join('\n'), changed.join('\n')).text
  expect(twoHunks.split('\n').filter(line => line.startsWith('@@'))).toEqual(['@@ -1,6 +1,6 @@', '@@ -28,7 +28,7 @@'])
  expect(cutDiff(twoHunks, 10)).toEqual({ text: twoHunks.split('\n').slice(0, 8).join('\n'), isCut: true })
  expect(cutDiff('@@ -1,5 +1,5 @@\n-a\n+b\n c\n-d\n+e\n f\n g', 4).text).toBe('@@ -1,2 +1,2 @@\n-a\n+b\n c')

  const parsed = parseExplanation(`Here you go:\n${REPLY}`, ['src/cart.ts', 'src/money.ts'])
  expect(parsed.summary).toContain('ignores **free** items')
  expect(parsed.notes['src/money.ts']?.what).toBe('New `round()` helper.')
  expect(parseExplanation('Plain words only.', ['a.ts'])).toEqual({ summary: 'Plain words only.', notes: {} })
})

test('records the edits of the last turn and explains them per file, with diffs to unfold', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await fixTurn($, seen)

  expect(await explainDiff($)).toBe('Explaining the last change (2 files) for a beginner…')
  await seen.clock.advance(0)
  expect(seen.asked[0]?.model).toBe('sonnet')
  expect(seen.asked[0]?.prompt).toContain('Round the cart total to cents and skip free items')
  expect(seen.asked[0]?.prompt).toContain('=== src/cart.ts (modified, +2 -2)')
  expect(seen.asked[0]?.prompt).toContain('+  return round(sum)')
  expect(seen.asked[0]?.prompt).toContain('=== src/money.ts (added, +1 -0)')
  expect(seen.asked[0]?.prompt).toContain('plain words')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'explain-diff', surface, component: 'Pane', requestId: 'explain-diff', props: PANE })
    expect((await ui.find({ key: 'header' }))?.text).toContain('Last change · 2 files')
    expect((await ui.find({ key: 'summary' }))?.text).toContain('ignores **free** items')
    expect((await ui.find({ key: 'note:src/cart.ts' }))?.text).toContain('**How to check:** Run `npm test -- cart`.')
    expect((await ui.find({ key: 'note:src/cart.ts' }))?.text).not.toContain('Watch out')
    expect((await ui.find({ key: 'note:src/money.ts' }))?.text).toContain('**Watch out:** Negative amounts.')
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'diff:src/cart.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(code?.text).toContain('+  for (const item of items) if (item.price > 0) sum += item.price')
    await ui.press({ key: 'diff:src/cart.ts' })
    await ui.unmount()
  }
  expect(await explainDiff($)).toBe('Showing the explanation of the last change (2 files).')
  expect(seen.asked).toHaveLength(1)
})

test('expert level, a failed request with Regenerate, and turns without edits keep the last change', async ($, on) => {
  const seen = world(on)
  expect(await explainDiff($)).toContain('No edits recorded yet')
  await fixTurn($, seen)
  await $.turn.start({ text: 'what does round do?', turnId: 't2' })
  await $.turn.complete({ answer: 'It rounds.', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await seen.clock.advance(0)

  seen.reply.text = undefined
  expect(await explainDiff($, 'expert')).toContain('for an expert')
  await seen.clock.advance(0)
  expect(seen.asked[0]?.prompt).toContain('experienced engineer')
  expect(seen.asked[0]?.prompt).toContain('Round the cart total')

  const ui = await $.ui.mount({ plugin: 'explain-diff', surface: 'desktop', component: 'Pane', requestId: 'explain-diff', props: PANE })
  expect((await ui.find({ key: 'failed' }))?.text).toContain('the model request failed (529)')
  seen.reply.text = REPLY
  await ui.press({ key: 'regenerate' })
  expect((await ui.find({ key: 'summary' }))?.text).toContain('rounds to cents')
  expect(seen.asked[1]?.prompt).toContain('experienced engineer')
  await ui.unmount()
  expect(await explainDiff($, 'sideways')).toContain('Usage')
})

test('the last change is kept per project across sessions', async ($, on) => {
  const change = { id: 'old', request: 'Add logging', answer: 'Done', endedAt: 1, files: [{ path: 'src/log.ts', status: 'added', added: 3, removed: 0, diff: '@@ -0,0 +1,1 @@\n+log()' }] }
  const seen = world(on, { [`change:${ROOT}`]: change })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(await explainDiff($)).toContain('(1 file)')
  await seen.clock.advance(0)
  expect(seen.asked[0]?.prompt).toContain('=== src/log.ts (added, +3 -0)')
})

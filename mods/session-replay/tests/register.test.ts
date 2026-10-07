import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionMessage } from 'claude-code'

const PLUGIN = 'session-replay'
const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/repo'
const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()

const PANE: RenderPropsOf['Pane'] = {
  title: 'Replay',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

/** Stands for the engine: the transcript is built from the tool calls the test makes, so their ids match. */
function world(on: On, options: { isPlaced?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOON })
  const ids: string[] = []
  const written = new Map<string, string>()
  const panes = { isOpen: false }
  const transcript = (): SessionMessage[] => [
    { role: 'user', text: 'Run the tests', toolUses: [] },
    {
      role: 'assistant',
      text: 'Running them now.',
      toolUses: [
        { tool_use_id: ids[0] ?? 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'Tests: 1 failed', isError: true },
        { tool_use_id: ids[1] ?? 'e', tool: 'Edit', input: { file_path: '/repo/src/cart.ts', old_string: 'a', new_string: 'b' }, text: 'ok' },
      ],
    },
    { role: 'assistant', text: 'Fixed **the cart**.', toolUses: [] },
  ]

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: transcript() }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => {
    panes.isOpen = options.isPlaced !== false
    return { value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface places panes' } : { isPlaced: true as const } }
  })
  on('ui.close', () => {
    panes.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.isOpen ? [{ id: PLUGIN, title: 'Replay', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    ids.push(e.tool_use_id)
    return e.tool === 'Bash' ? { isError: true as const, result: 'Exit code 1', text: 'Tests: 1 failed' } : { result: { filePath: '/repo/src/cart.ts' } }
  })

  return { clock, written, panes }
}

const replay = ($: Engine, args = '') =>
  $.command.run({ command: 'replay', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

/** Plays the session the transcript describes: a prompt, a failing test run, an edit. */
async function play($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Run the tests', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/cart.ts', old_string: 'a', new_string: 'b' })
}

test('/replay opens on the newest step and steps through the session with the buttons', async ($, on) => {
  world(on)
  await play($)
  expect((await replay($)).text).toBe('▶ Replaying 5 steps.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Step 5 / 5 · live' })).toBeDefined()
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Fixed **the cart**.')

    await ui.press({ key: 'first' })
    expect(await ui.find({ type: 'Text', text: 'Step 1 / 5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '💬 Prompt · 12:00:00' })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: '$ Command · 12:00:00 · 0 ms · ✗ failed' })).toBeDefined()
    expect((await ui.findAll({ type: 'Code' })).map(code => code.text)).toEqual(['npm test', 'Tests: 1 failed'])
    await ui.press({ key: 'next' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff', source: '@@ -1,1 +1,1 @@\n-a\n+b', path: '/repo/src/cart.ts' })
    await ui.press({ key: 'previous' })
    expect(await ui.find({ type: 'Text', text: 'Step 3 / 5' })).toBeDefined()
    await ui.press({ key: 'last' })
    expect(await ui.find({ type: 'Text', text: 'Step 5 / 5 · live' })).toBeDefined()
    await ui.unmount()
  }
})

test('the filter narrows the steps; /replay <n> jumps; a finished turn refreshes an open replay', async ($, on) => {
  const w = world(on)
  await play($)
  await replay($, '2')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect(await ui.find({ type: 'Text', text: 'Step 2 / 5' })).toBeDefined()

  await ui.select({ key: 'filter', value: 'edits' })
  expect(await ui.find({ type: 'Text', text: 'Step 1 / 1 · #4 of 5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Edit src/cart.ts' })).toBeDefined()
  await ui.select({ key: 'filter', value: 'errors' })
  expect(await ui.find({ type: 'Text', text: '$ npm test' })).toBeDefined()
  await ui.select({ key: 'filter', value: 'all' })
  expect(await ui.find({ type: 'Text', text: 'Step 3 / 5' })).toBeDefined()

  w.panes.isOpen = true
  await ui.press({ key: 'last' })
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't', reason: 'answer' })
  await w.clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'Step 5 / 5 · live' })).toBeDefined()
  await ui.unmount()
})

test('/replay export writes the whole timeline as Markdown under .claude/replays', async ($, on) => {
  const w = world(on)
  await play($)
  expect((await replay($, 'export')).text).toBe('✓ Exported 5 steps to .claude/replays/2026-10-07-120000.md')
  const markdown = w.written.get('/repo/.claude/replays/2026-10-07-120000.md') ?? ''
  expect(markdown).toContain('5 steps · 1 prompts · 2 tool calls · 1 edits')
  expect(markdown).toContain('## 3. $ $ npm test')

  await replay($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE })
  await ui.press({ key: 'export' })
  expect(await ui.find({ type: 'Text', text: '✓ Exported 5 steps to .claude/replays/2026-10-07-120000.md' })).toBeDefined()
})

test('without a pane /replay lists the steps; bad arguments get the usage', async ($, on) => {
  world(on, { isPlaced: false })
  await play($)
  const text = (await replay($)).text ?? ''
  expect(text).toBe(
    [
      '▶ Session replay: 5 steps (the pane could not be shown here).',
      '   1 12:00:00 💬 Run the tests',
      '   2 ✦ Running them now.',
      '   3 12:00:00 $ $ npm test ✗',
      '   4 12:00:00 ✎ Edit src/cart.ts',
      '   5 ✦ Fixed **the cart**.',
    ].join('\n'),
  )
  expect((await replay($, 'rewind')).text).toBe('✗ Usage: /replay [export | <step number>]')
})

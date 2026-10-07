import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, PromptFillInput } from 'claude-code'

const PLUGIN = 'prompt-enhancer'
const PANE = 'prompt-enhancer'
const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 400, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REWRITE = 'Fix the login failure in `src/auth/login.ts`.\n- Keep the public API unchanged.\n- `npm test` must pass.'

const paneProps = {
  title: 'Enhance prompt',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** A small Node project, a pane that opens, and a model that answers with `reply`. */
const world = (on: On, reply: () => ModelCompleteResult) => {
  const asked: ModelCompleteInput[] = []
  on('session.root', () => ({ value: '/work/shop' }))
  on('fs.list', () => ({
    value: [
      { name: 'package.json', kind: 'file', size: 10, mtimeMs: 1, isLink: false },
      { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'node_modules', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', () => ({
    value: JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { react: '19' }, devDependencies: { typescript: '5' } }),
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('model.complete', ($, e) => {
    asked.push(e)
    return { value: reply() }
  })
  return asked
}

const enhance = ($: Engine, args: string) =>
  $.command.run({ command: 'enhance', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('rewrites the draft with project context and shows original and enhanced side by side', async ($, on) => {
  const clock = mock.clock(on)
  const asked = world(on, () => ({ isAnswered: true, text: '```\n' + REWRITE + '\n```', usage: USAGE }))

  const ran = await enhance($, 'fix login its broken')
  expect(ran.text).toContain('Rewriting with sonnet')
  await clock.advance(1)

  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBe('sonnet')
  expect(asked[0]?.system).toContain('Reply with the rewritten prompt and nothing else.')
  expect(asked[0]?.prompt).toContain('<draft>\nfix login its broken\n</draft>')
  expect(asked[0]?.prompt).toContain('stack: Node.js, TypeScript, React')
  expect(asked[0]?.prompt).toContain('test script: vitest run')
  expect(asked[0]?.prompt).not.toContain('node_modules')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    const text = (await ui.find({ type: 'Box' }))?.text ?? ''
    expect(text).toContain('fix login its broken')
    expect(text).toContain(REWRITE)
    expect(text).not.toContain('```')
    for (const key of ['use', 'send', 'retry', 'copy', 'discard']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.unmount()
  }
})

test('Use puts the rewrite in the prompt box; Send submits it', async ($, on) => {
  const clock = mock.clock(on)
  world(on, () => ({ isAnswered: true, text: REWRITE, usage: USAGE }))
  const filled: PromptFillInput[] = []
  const submitted: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: 'add dark mode', cursor: 13 } }))

  await enhance($, '')
  await clock.advance(1)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    expect((await ui.find({ type: 'Box' }))?.text).toContain('add dark mode')
    await ui.press({ key: 'use' })
    await ui.press({ key: 'send' })
    await ui.unmount()
  }
  expect(filled[0]).toMatchObject({ text: REWRITE, mode: 'replace' })
  expect(submitted).toEqual([REWRITE, REWRITE])
})

test('says why there is no rewrite and offers Retry', async ($, on) => {
  const clock = mock.clock(on)
  let fails = true
  world(on, () =>
    fails
      ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
      : { isAnswered: true, text: REWRITE, usage: USAGE },
  )
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))

  expect((await enhance($, '   ')).text).toContain('Nothing to enhance')

  await enhance($, 'speed up the build')
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps })
  expect((await ui.find({ type: 'Text', text: /No rewrite/ }))?.text).toContain('529 (overloaded)')

  fails = false
  await ui.press({ key: 'retry' })
  await clock.settle()
  expect((await ui.find({ type: 'Box' }))?.text).toContain(REWRITE)
})

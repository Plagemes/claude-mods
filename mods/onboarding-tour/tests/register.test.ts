import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, On, RenderPropsOf } from 'claude-code'

import { excerptOf, parseSteps, treeOf } from '../hooks/tour'

const ROOT = '/work/shop'
const USAGE = { input_tokens: 4_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const README = '# Shop\n\nA tiny online shop: catalogue, cart and checkout.\n\nRun `npm run dev`.\n'
const PACKAGE = JSON.stringify({ name: 'shop', scripts: { dev: 'vite', test: 'vitest' }, dependencies: { react: '^19' }, devDependencies: { vitest: '^3' }, private: true })
const STEPS = {
  steps: [
    { title: 'What Shop is', body: 'A small online shop: **catalogue**, cart and checkout.', files: ['README.md'] },
    { title: 'Run it', body: 'Install, then `npm run dev`; tests with `npm test`.', files: ['package.json', './src/ghost.ts'] },
    { title: 'Entry point', body: '`src/main.tsx` mounts the app.', files: ['src/main.tsx', '../etc/passwd'] },
  ],
}
const PANE: RenderPropsOf['Pane'] = {
  title: 'Tour',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = { clock: MockClock; asked: string[]; filled: string[]; reply: { text: string }; draft: { text: string } }

const entry = (name: string, kind: 'file' | 'dir'): FsEntry => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })

function world(on: On, stored: Record<string, unknown> = {}): World {
  const seen: World = { clock: mock.clock(on, { now: 1_000 }), asked: [], filled: [], reply: { text: JSON.stringify(STEPS) }, draft: { text: '' } }
  const files = new Map([
    [`${ROOT}/README.md`, README],
    [`${ROOT}/package.json`, PACKAGE],
    [`${ROOT}/src/main.tsx`, 'render(<App />)'],
  ])
  mock.store(on, stored)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', ($, e) => {
    if (e.path === ROOT) return { value: [entry('src', 'dir'), entry('node_modules', 'dir'), entry('.git', 'dir'), entry('README.md', 'file'), entry('package.json', 'file')] }
    if (e.path === `${ROOT}/src`) return { value: [entry('main.tsx', 'file'), entry('cart', 'dir')] }
    return { deny: 'ENOENT' }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('model.complete', ($, e) => {
    seen.asked.push(e.prompt)
    return { value: { isAnswered: true, text: seen.reply.text, usage: USAGE } }
  })
  on('prompt.read', () => ({ value: { text: seen.draft.text, cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(`${e.mode}:${e.text}`)
    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const tour = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'tour', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

test('sketches the project and keeps only usable steps', async () => {
  expect(excerptOf('package.json', PACKAGE)).toContain('"dev": "vite"')
  expect(excerptOf('package.json', PACKAGE)).not.toContain('private')
  const tree = treeOf([{ name: 'README.md', isDir: false }, { name: 'src', isDir: true }], new Map([['src', [{ name: 'main.tsx', isDir: false }]]]))
  expect(tree).toBe('src/\n  main.tsx\nREADME.md')
  const steps = parseSteps(`Here:\n${JSON.stringify({ steps: [...STEPS.steps, { title: '', body: 'no title' }] })}`)
  expect(steps.map(step => step.title)).toEqual(['What Shop is', 'Run it', 'Entry point'])
  expect(steps[1]?.files).toEqual(['package.json', 'src/ghost.ts'])
  expect(steps[2]?.files).toEqual(['src/main.tsx'])
  expect(parseSteps('Sorry, no.')).toEqual([])
})

test('plans a tour from the repository and walks it step by step, with files to mention', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(await tour($)).toBe('Reading the repository and planning a tour…')
  await seen.clock.advance(0)
  expect(seen.asked[0]).toContain('guided tour of the repository "shop"')
  expect(seen.asked[0]).toContain('src/\n  cart/\n  main.tsx')
  expect(seen.asked[0]).not.toContain('node_modules')
  expect(seen.asked[0]).toContain('=== README.md\n# Shop')
  expect(seen.asked[0]).toContain('"test": "vitest"')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'onboarding-tour', surface, component: 'Pane', requestId: 'tour', props: PANE })
    expect((await ui.find({ key: 'progress' }))?.text).toContain('Step 1 of 3')
    expect((await ui.find({ key: 'title' }))?.text).toBe('What Shop is')
    expect((await ui.find({ key: 'body' }))?.text).toContain('**catalogue**')
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.press({ key: 'next' })
    expect((await ui.find({ key: 'title' }))?.text).toBe('Run it')
    expect(await ui.find({ key: 'file:src/ghost.ts' })).toBeUndefined()
    await ui.press({ key: 'file:package.json' })
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  expect(seen.filled).toEqual(['replace:@package.json ', 'replace:@package.json '])

  const ui = await $.ui.mount({ plugin: 'onboarding-tour', surface: 'desktop', component: 'Pane', requestId: 'tour', props: PANE })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ key: 'next' }))?.props.label).toBe('Finish')
  seen.draft.text = 'Explain'
  await ui.press({ key: 'ask' })
  expect(seen.filled.at(-1)).toBe('append: In this repository, regarding "Entry point": ')
  await ui.press({ key: 'next' })
  expect((await ui.find({ key: 'finished' }))?.text).toContain('That is the whole tour')
  await ui.unmount()
  expect(seen.asked).toHaveLength(1)
})

test('/tour resumes where you left off; restart plans afresh, Retry after a bad reply', async ($, on) => {
  const seen = world(on)
  await tour($)
  await seen.clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'onboarding-tour', surface: 'terminal', component: 'Pane', requestId: 'tour', props: PANE })
  await ui.press({ key: 'next' })
  await ui.unmount()

  expect(await tour($)).toBe('Resuming the tour at step 2 of 3: Run it. (/tour restart plans a fresh one.)')
  expect(seen.asked).toHaveLength(1)
  expect(await tour($, 'restart')).toBe('Reading the repository and planning a tour…')
  seen.reply.text = 'not json'
  await seen.clock.advance(0)
  expect(seen.asked).toHaveLength(2)
  const failed = await $.ui.mount({ plugin: 'onboarding-tour', surface: 'desktop', component: 'Pane', requestId: 'tour', props: PANE })
  expect((await failed.find({ key: 'failed' }))?.text).toContain('did not return a usable tour')
  seen.reply.text = JSON.stringify(STEPS)
  await failed.press({ key: 'retry' })
  expect((await failed.find({ key: 'title' }))?.text).toBe('What Shop is')
  await failed.unmount()
})

test('a tour saved in an earlier session resumes at its step without planning again', async ($, on) => {
  const saved = { status: 'ready', steps: STEPS.steps.map(step => ({ ...step, files: [] })), index: 2, isFinished: false, builtAt: 1, error: '' }
  const seen = world(on, { [`tour:${ROOT}`]: saved })
  expect(await tour($)).toBe('Resuming the tour at step 3 of 3: Entry point. (/tour restart plans a fresh one.)')
  const ui = await $.ui.mount({ plugin: 'onboarding-tour', surface: 'terminal', component: 'Pane', requestId: 'tour', props: PANE })
  expect((await ui.find({ key: 'title' }))?.text).toBe('Entry point')
  await ui.unmount()
  expect(seen.asked).toEqual([])
})

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'
import { hasStoryIn, isComponentPath, storyExtension, storyFor } from '../hooks/paths'

const ROOT = '/repo'
const BAND = {
  plugin: 'storybook-nudge',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const
const TURN = { answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' } as const

type Seen = { toasts: string[]; prompts: { text: string; asUser: boolean }[]; reached: string[] }

/** A project on a virtual disk: Write puts the file there, and listings and existence answer from it. */
const project = (on: On, paths: string[]): Seen & { disk: Set<string> } => {
  const disk = new Set(paths)
  const seen = { toasts: [] as string[], prompts: [] as { text: string; asUser: boolean }[], reached: [] as string[], disk }
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => ({ value: [...disk].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of [...disk].filter(path => path.startsWith(prefix))) {
      const [name, ...deeper] = path.slice(prefix.length).split('/')
      if (name !== undefined) names.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    return names.size === 0 ? { deny: 'ENOENT' } : { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') {
      disk.add(e.file_path)
      seen.reached.push(e.file_path)
    }
    return { result: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.prompts.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
    return { text: e.text }
  })
  return seen
}

const write = ($: Engine, file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'export {}' })
const bandText = async ($: Engine, surface: 'terminal' | 'desktop', text: string) => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found
}

test('a new component without a story raises a toast and the band, and the band button asks Claude', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`, `${ROOT}/src/components/Card.tsx`, `${ROOT}/src/components/Card.stories.tsx`])

  await write($, `${ROOT}/src/components/Button.tsx`)
  expect(seen.toasts).toHaveLength(0)
  await $.turn.complete(TURN)

  expect(seen.toasts).toEqual(['Button.tsx has no story yet'])
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface, 'Button.tsx has no story')).toBeDefined()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'ask' })
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]?.asUser).toBe(true)
  expect(seen.prompts[0]?.text).toContain('- src/components/Button.tsx (story file: Button.stories.tsx)')
  expect(seen.prompts[0]?.text).toContain('following the stories this project already has')
  expect(await band.find({ key: 'ask' })).toBeUndefined()
})

test('with mods-hub: the toast is an info notification, and the band is unchanged', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`, `${ROOT}/src/components/Card.tsx`])
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  await write($, `${ROOT}/src/components/Button.tsx`)
  await $.turn.complete(TURN)

  expect(seen.toasts).toEqual([])
  expect(hub.notified).toEqual([{ level: 'info', title: 'Button.tsx has no story yet' }])
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface, 'Button.tsx has no story')).toBeDefined()
  }
})

test('a story written in the same turn, or already next to the component, means no nudge', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`, `${ROOT}/src/components/Tag/Tag.stories.ts`, `${ROOT}/src/components/Chip/stories/Chip.stories.tsx`])

  await write($, `${ROOT}/src/components/Button.tsx`)
  await write($, `${ROOT}/src/components/Button.stories.tsx`)
  await write($, `${ROOT}/src/components/Tag/Tag.tsx`)
  await write($, `${ROOT}/src/components/Chip/Chip.tsx`)
  await write($, `${ROOT}/src/components/Modal.vue`)
  await write($, `${ROOT}/src/components/Modal.stories.ts`)
  await $.turn.complete(TURN)

  expect(seen.toasts).toHaveLength(0)
  expect(await bandText($, 'terminal', 'has no story')).toBeUndefined()
})

test('a story written in a later turn clears the band', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`])
  await write($, `${ROOT}/src/components/Nav.svelte`)
  await $.turn.complete(TURN)
  expect(await bandText($, 'terminal', 'Nav.svelte has no story')).toBeDefined()

  await write($, `${ROOT}/src/components/Nav.stories.ts`)

  expect(await bandText($, 'terminal', 'Nav.svelte has no story')).toBeUndefined()
  expect(seen.prompts).toHaveLength(0)
})

test('a project without Storybook is left alone', async ($, on) => {
  const withoutStorybook = project(on, [`${ROOT}/src/components/Old.tsx`])
  await write($, `${ROOT}/src/components/Button.tsx`)
  await $.turn.complete(TURN)
  expect(withoutStorybook.toasts).toHaveLength(0)
})

test('overwriting a component, helpers, tests, pages and styles are not new components', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`, `${ROOT}/src/components/Old.tsx`])

  for (const path of ['src/components/Old.tsx', 'src/components/button.tsx', 'src/components/Button.test.tsx', 'src/components/Button.css', 'src/pages/Home.tsx', 'src/components/index.ts']) {
    await write($, `${ROOT}/${path}`)
  }
  await $.turn.complete(TURN)

  expect(seen.toasts).toHaveLength(0)
  expect(await bandText($, 'terminal', 'no story')).toBeUndefined()
})

test('Storybook in a package above the component counts; other projects do not', async ($, on) => {
  const seen = project(on, [`${ROOT}/packages/ui/.storybook/main.ts`, `${ROOT}/packages/api/src/x.ts`])

  await write($, `${ROOT}/packages/ui/src/components/forms/Input.tsx`)
  await write($, `${ROOT}/packages/api/src/components/Widget.tsx`)
  await $.turn.complete(TURN)

  expect(seen.toasts).toEqual(['Input.tsx has no story yet'])
})

test('subagents and interrupted turns do not settle; the main turn does, with one toast for several components', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`])
  await write($, `${ROOT}/src/components/A.tsx`)
  await write($, `${ROOT}/src/components/B.tsx`)
  await write($, `${ROOT}/src/components/C.tsx`)
  await write($, `${ROOT}/src/components/D.tsx`)

  await $.turn.complete({ ...TURN, agentId: 'agent-1' })
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  expect(seen.toasts).toHaveLength(0)

  await $.turn.complete(TURN)
  expect(seen.toasts).toEqual(['4 new components have no story yet'])
  expect(await bandText($, 'terminal', 'A.tsx, B.tsx, C.tsx and 1 more have no story')).toBeDefined()
})

test('Dismiss clears the band without asking Claude', async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`])
  await write($, `${ROOT}/src/components/Tabs.tsx`)
  await $.turn.complete(TURN)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'dismiss' })

  expect(await band.find({ key: 'dismiss' })).toBeUndefined()
  expect(seen.prompts).toHaveLength(0)
})

test('component folders are configurable', { options: { directories: 'ui, widgets' } }, async ($, on) => {
  const seen = project(on, [`${ROOT}/.storybook/main.ts`])

  await write($, `${ROOT}/src/components/Skipped.tsx`)
  await write($, `${ROOT}/src/widgets/Gauge.tsx`)
  await $.turn.complete(TURN)

  expect(seen.toasts).toEqual(['Gauge.tsx has no story yet'])
})

test('path helpers', () => {
  const folders = new Set(['components'])
  expect(isComponentPath('/r/src/components/ui/Button.tsx', folders)).toBe(true)
  expect(isComponentPath('/r/src/components/Button.stories.tsx', folders)).toBe(false)
  expect(isComponentPath('/r/src/components/button.tsx', folders)).toBe(false)
  expect(isComponentPath('/r/src/lib/Button.tsx', folders)).toBe(false)
  expect(storyFor('/r/Button.stories.tsx')).toBe('Button')
  expect(storyFor('/r/Button.story.js')).toBe('Button')
  expect(storyFor('/r/Button.tsx')).toBeUndefined()
  expect(hasStoryIn(['Button.tsx', 'Button.stories.mdx'], 'Button')).toBe(true)
  expect(hasStoryIn(['ButtonGroup.stories.tsx'], 'Button')).toBe(false)
  expect(storyExtension('/r/A.tsx')).toBe('tsx')
  expect(storyExtension('/r/A.vue')).toBe('ts')
})

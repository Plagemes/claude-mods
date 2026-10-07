import { test, expect, mock } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const NOW = new Date(2026, 9, 7, 14, 5).getTime()

const PANE = {
  plugin: 'prompt-history',
  component: 'Pane',
  requestId: 'prompt-history',
  props: {
    title: 'History',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const typed = (text: string, origin: PromptOrigin = { kind: 'composer' }) => ({ text, wait: false, origin })

const history = (args = '') =>
  ({ command: 'history', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type Entry = { text: string; at: number; project: string }

/** Stands for the engine: a store open to the test, the project root, the prompt box and panes. */
const answerEngine = (on: On, stored: Entry[] = []) => {
  const engine = {
    root: '/work/alpha',
    store: new Map<string, unknown>([['prompts', stored]]),
    filled: [] as string[],
    closed: [] as string[],
  }
  const clock = mock.clock(on, { now: NOW })
  on('session.root', () => ({ value: engine.root }))
  on('store.get', ($, e) => ({ value: engine.store.get(e.key) }))
  on('store.set', ($, e) => {
    engine.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    engine.store.delete(e.key)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.fill', ($, e) => {
    engine.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    engine.closed.push(e.id)
    return { value: undefined }
  })
  return { engine, clock }
}

const kept = (store: Map<string, unknown>) => store.get('prompts') as Entry[]

test('every typed prompt is kept newest first with its project and time; repeats move up, plugin prompts are left out', async ($, on) => {
  const { engine, clock } = answerEngine(on)

  await $.prompt.submit(typed('add retries to the uploader'))
  await clock.advance(60_000)
  engine.root = '/work/beta'
  await $.prompt.submit(typed('explain the auth flow'))
  await $.prompt.submit(typed('summarise the build', { kind: 'plugin', name: 'other' }))
  await clock.advance(60_000)
  await $.prompt.submit(typed('add retries to the uploader'))

  expect(kept(engine.store)).toEqual([
    { text: 'add retries to the uploader', at: NOW + 120_000, project: '/work/beta' },
    { text: 'explain the auth flow', at: NOW + 60_000, project: '/work/beta' },
  ])
})

test('the history keeps at most 1000 prompts', async ($, on) => {
  const old = Array.from({ length: 1_000 }, (_, i) => ({ text: `prompt ${i}`, at: NOW - i, project: '/work/alpha' }))
  const { engine } = answerEngine(on, old)

  await $.prompt.submit(typed('the newest one'))

  const entries = kept(engine.store)
  expect(entries).toHaveLength(1_000)
  expect(entries[0]?.text).toBe('the newest one')
  expect(entries.at(-1)?.text).toBe('prompt 998')
})

const PAST: Entry[] = [
  { text: 'fix the flaky queue test\nit fails one run in ten', at: NOW - 1_000, project: '/work/alpha' },
  { text: 'write a migration for the users table', at: NOW - 2_000, project: '/work/beta' },
  { text: 'fix the typo in the README', at: NOW - 3_000, project: '/work/alpha' },
]

test('/history searches as you type, scopes to the project, and Use fills the prompt box', async ($, on) => {
  const { engine } = answerEngine(on, PAST)
  expect((await $.command.run(history())).text).toBe('3 prompts kept.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '3 of 3 prompts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'fix the flaky queue test …' })).toBeDefined()

    await ui.input({ key: 'search', text: 'FIX the', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: '2 of 3 prompts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /migration/ })).toBeUndefined()

    await ui.input({ key: 'search', text: '', kind: 'change' })
    engine.root = '/work/beta'
    await ui.press({ key: 'scope' })
    expect(await ui.find({ type: 'Text', text: '2 of 3 prompts in alpha' })).toBeDefined()
    await ui.press({ key: 'scope' })

    await ui.press({ key: `use:${NOW - 3_000}` })
    expect(engine.filled.at(-1)).toBe('fix the typo in the README')
    expect(engine.closed.at(-1)).toBe('prompt-history')
    engine.root = '/work/alpha'
    await ui.unmount()
  }
})

test('/history <words> opens with the search filled in, and /history clear forgets everything', async ($, on) => {
  const { engine } = answerEngine(on, PAST)

  expect((await $.command.run(history('migration'))).text).toBe('1 of 3 prompts match "migration".')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('migration')

  expect((await $.command.run(history('clear'))).text).toBe('History cleared.')
  expect(engine.store.has('prompts')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Nothing kept yet/ })).toBeDefined()
  await ui.unmount()
})

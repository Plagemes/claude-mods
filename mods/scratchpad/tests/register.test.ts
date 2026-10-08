import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const PANE = {
  plugin: 'scratchpad',
  component: 'Pane',
  requestId: 'scratchpad',
  props: {
    title: 'Notes',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const run = (command: 'note' | 'notes', args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

/** Stands for the engine: a store open to the test, the project root, the prompt box and panes. */
const answerEngine = (on: On) => {
  const engine = { root: '/work/alpha', store: new Map<string, unknown>(), filled: [] as { text: string; mode: string }[], opened: [] as unknown[] }
  startClock = mock.clock(on, { now: new Date(2026, 9, 7, 14, 5).getTime() })
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
  on('prompt.fill', ($, e) => {
    engine.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('ui.open', ($, e) => {
    engine.opened.push(e)
    return { value: { isPlaced: true } }
  })
  return engine
}

const textsOf = (notes: unknown): string[] => (notes as { text: string }[]).map(note => note.text)

test('/note keeps notes per project root, newest first, and /notes opens the pane with the keyboard', async ($, on) => {
  const engine = answerEngine(on)

  expect((await $.command.run(run('note', 'check the retry budget'))).text).toBe('Noted. 1 note for alpha.')
  expect((await $.command.run(run('note', 'ask Sam about the schema'))).text).toBe('Noted. 2 notes for alpha.')
  engine.root = '/work/beta'
  await $.command.run(run('note', 'beta only'))

  expect(textsOf(engine.store.get('notes:/work/alpha'))).toEqual(['ask Sam about the schema', 'check the retry budget'])
  expect(textsOf(engine.store.get('notes:/work/beta'))).toEqual(['beta only'])

  engine.root = '/work/alpha'
  expect((await $.command.run(run('notes'))).text).toBe('2 notes for alpha.')
  expect(engine.opened).toEqual([{ id: 'scratchpad', title: 'Notes', focus: true }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const notes = await ui.findAll({ type: 'Text', text: /schema|retry|beta only/ })
    expect(notes.map(found => found.text)).toEqual(['ask Sam about the schema', 'check the retry budget'])
    expect(await ui.find({ type: 'Text', text: '7 Oct 14:05' })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'new' })).toBeDefined()
    await ui.unmount()
  }

  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ type: 'Input' })).toBeUndefined()
  expect(await phone.find({ type: 'Text', text: /terminal or the desktop app/ })).toBeDefined()
  await phone.unmount()
})

test('in the pane, Enter adds a note, To prompt fills the prompt box and Delete removes the note', async ($, on) => {
  const engine = answerEngine(on)
  await $.command.run(run('notes'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'new', text: `  remember ${surface}`, kind: 'change' })
    expect((await ui.find({ type: 'Input', key: 'new' }))?.props.value).toBe(`  remember ${surface}`)
    await ui.input({ key: 'new', text: `  remember ${surface}  ` })
    expect((await ui.find({ type: 'Input', key: 'new' }))?.props.value).toBe('')
    await ui.input({ key: 'new', text: '   ' })
    const added = (await ui.find({ type: 'Text', text: `remember ${surface}` }))?.text
    expect(added).toBe(`remember ${surface}`)

    const [note] = engine.store.get('notes:/work/alpha') as { id: string; text: string }[]
    await ui.press({ key: `send:${note?.id}` })
    expect(engine.filled.at(-1)).toEqual({ text: `remember ${surface}`, mode: 'insert' })

    await ui.press({ key: `delete:${note?.id}` })
    expect(await ui.find({ type: 'Text', text: `remember ${surface}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '0 notes' })).toBeDefined()
    await ui.unmount()
  }

  expect(engine.store.has('notes:/work/alpha')).toBe(false)
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const
const START = { cwd: '/work/alpha', surface: 'terminal', isInteractive: true } as const

test('with mods-hub: the Notes tab loads this project\'s notes at start, /notes opens it, and the field does not grab the keyboard', async ($, on) => {
  const engine = answerEngine(on)
  engine.store.set('notes:/work/alpha', [{ id: 'n1', text: 'check the retry budget', createdAt: new Date(2026, 9, 7, 9, 30).getTime() }])
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start(START)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: [] }])
  expect(hub.tabs).toEqual([{ id: 'notes', title: 'Notes', order: 280, command: 'notes' }])

  expect((await $.command.run(run('notes'))).text).toBe('1 note for alpha.')
  expect(hub.shown).toEqual(['notes'])
  expect(engine.opened).toEqual([])
  hub.tab = 'notes'

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'check the retry budget' })).toBeDefined()
    expect((await ui.find({ type: 'Input', key: 'new' }))?.props.autoFocus).toBeFalsy()
    await ui.input({ key: 'new', text: `from the tab ${surface}` })
    expect(await ui.find({ type: 'Text', text: `from the tab ${surface}` })).toBeDefined()
    await ui.unmount()
  }
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  answerEngine(on)
  const hub = fakeHub(on)
  hub.tab = 'cost'
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub the own pane keeps the keyboard in its field', async ($, on) => {
  answerEngine(on)
  await $.command.run(run('notes'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Input', key: 'new' }))?.props.autoFocus).toBe(true)
  await ui.unmount()
})

import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  mock.clock(on, { now: new Date(2026, 9, 7, 14, 5).getTime() })
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

  expect((await $.command.run(run('note', 'check the retry budget'))).text).toBe('scratchpad: noted. 1 note for alpha.')
  expect((await $.command.run(run('note', 'ask Sam about the schema'))).text).toBe('scratchpad: noted. 2 notes for alpha.')
  engine.root = '/work/beta'
  await $.command.run(run('note', 'beta only'))

  expect(textsOf(engine.store.get('notes:/work/alpha'))).toEqual(['ask Sam about the schema', 'check the retry budget'])
  expect(textsOf(engine.store.get('notes:/work/beta'))).toEqual(['beta only'])

  engine.root = '/work/alpha'
  expect((await $.command.run(run('notes'))).text).toBe('scratchpad: 2 notes for alpha.')
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

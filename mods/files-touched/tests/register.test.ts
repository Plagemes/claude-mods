import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

import { groupByDirectory, mentionOf } from '../hooks/files'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const PANE = {
  plugin: 'files-touched',
  component: 'Pane',
  requestId: 'files',
  props: { title: 'Files', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The engine beneath the plugin: Write creates /repo/src/new.ts, an Edit of missing.ts fails. */
const engine = (on: On) => {
  const copies: unknown[] = []
  const fills: unknown[] = []
  const toasts: string[] = []
  const opened: string[] = []
  startClock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', () => ({ type: 'Box' }))
  on('ui.copy', ($, e) => {
    copies.push(e)
    return { value: { isCopied: true } }
  })
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    if ('file_path' in e && String(e.file_path).endsWith('missing.ts')) return { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
    if (e.tool === 'Write') return { result: { type: e.file_path.endsWith('new.ts') ? 'create' : 'update' } }
    return { result: 'ok' }
  })
  return { copies, fills, toasts, opened }
}

const touchAll = async ($: Engine) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: '' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/missing.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
}

test('counts reads, edits and creates per file and groups them by directory, on terminal and desktop', async ($, on) => {
  engine(on)
  await touchAll($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '4 files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 edited' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 created' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /\/$/ })).map(found => found.text)).toEqual(['./', '/etc/', 'src/'])
    expect(await ui.find({ type: 'Text', text: /missing/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^ +2 read$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ +new$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button', text: 'copy' })).toHaveLength(4)
    await ui.unmount()
  }
})

test('copies a path and mentions a file in the prompt from its buttons', async ($, on) => {
  const { copies, fills, toasts } = engine(on)
  await touchAll($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'copy:/repo/src/app.ts' })
  await ui.press({ key: 'mention:/repo/src/new.ts' })
  await ui.unmount()

  expect(copies).toEqual([{ text: '/repo/src/app.ts', surface: 'desktop' }])
  expect(toasts).toEqual(['Copied src/app.ts'])
  expect(fills).toEqual([{ text: '@src/new.ts ', mode: 'insert' }])
})

test('shows changed files only on demand, and /files opens the pane', async ($, on) => {
  engine(on)
  await touchAll($)
  const ran = await $.command.run({ command: 'files', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(ran.text).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: 'hosts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
  expect((await ui.find({ key: 'filter' }))?.props.label).toBe('Show all')
  await ui.unmount()
})

test('groups paths and writes mentions the way the prompt reads them', () => {
  const entry = (path: string) => ({ path, reads: 1, edits: 0, creates: 0, lastAt: 0 })
  const groups = groupByDirectory([entry('/repo/src/b.ts'), entry('/repo/a.md'), entry('/repo/src/a.ts')], '/repo')
  expect(groups.map(group => [group.dir, group.files.map(file => file.path)])).toEqual([
    ['./', ['/repo/a.md']],
    ['src/', ['/repo/src/a.ts', '/repo/src/b.ts']],
  ])
  expect(mentionOf('/repo/docs/my notes.md', '/repo')).toBe('@"docs/my notes.md"')
  expect(mentionOf('/tmp/x.log', '/repo')).toBe('@/tmp/x.log')
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const

test('with mods-hub: registers its Files tab, /files opens the tab, and the files are drawn in it on both surfaces', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  await touchAll($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: [] }])
  expect(hub.tabs).toEqual([{ id: 'files', title: 'Files', order: 251, command: 'files' }])

  await $.command.run({ command: 'files', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(hub.shown).toEqual(['files'])
  hub.tab = 'files'

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Files this session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'hosts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
    await ui.press({ key: 'filter' })
    expect(await ui.find({ type: 'Text', text: 'hosts' })).toBeUndefined()
    await ui.press({ key: 'filter' })
    await ui.unmount()
  }
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  hub.tab = 'cost'
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub /files opens the own pane', async ($, on) => {
  const spy = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'files', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(spy.opened).toEqual(['files'])
})

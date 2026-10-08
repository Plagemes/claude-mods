import { test, expect, mock } from 'claude-code/testing'
import type { On, UiOpenResult } from 'claude-code'

import { taskEvents } from '../hooks/todos'
import { fakeHub } from './hub'

const PANE = {
  plugin: 'todo-pane',
  component: 'Pane',
  requestId: 'todos',
  props: {
    title: 'Todos',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const PLAN = [
  { content: 'Read the parser', activeForm: 'Reading the parser', status: 'completed' },
  { content: 'Fix the off-by-one', activeForm: 'Fixing the off-by-one', status: 'in_progress' },
  { content: 'Run the tests', activeForm: 'Running the tests', status: 'pending' },
] as const

/** Stands for the engine: the tools answer as the built-ins do, panes are recorded. */
/** The mock clock of the running test, moved on past afterStart's delay (the hub hello, the pane at start). */
let startClock: ReturnType<typeof mock.clock> | undefined

const answerEngine = (on: On, placed = true) => {
  startClock = mock.clock(on)
  const engine = { opened: [] as string[], closed: [] as string[], open: new Set<string>(), nextTask: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos } }
    if (e.tool === 'TaskCreate') {
      engine.nextTask += 1
      return { result: { task: { id: String(engine.nextTask), subject: e.subject } } }
    }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { deny: 'not in this test' }
  })
  on('ui.open', ($, e) => {
    engine.opened.push(e.title ?? e.id)
    if (placed) engine.open.add(e.id)
    const value: UiOpenResult = placed ? { isPlaced: true } : { isPlaced: false, reason: 'unasked: 144 columns, 100 now' }
    return { value }
  })
  on('ui.close', ($, e) => {
    engine.closed.push(e.id)
    engine.open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...engine.open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  return engine
}

test('a TodoWrite list draws a progress bar and ☑ ◐ ☐ items on every surface', async ($, on) => {
  answerEngine(on)
  await $.tool.call({ tool: 'TodoWrite', todos: [...PLAN] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1/3 done' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^[☑◐☐]$/ })).map(found => found.text)).toEqual(['☑', '◐', '☐'])
    expect((await ui.find({ type: 'Text', text: 'Reading the parser' }))).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'Read the parser' }))?.props.strikethrough).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'Fixing the off-by-one' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toBe('█'.repeat(10))
    expect(await ui.find({ type: 'Text', text: '░'.repeat(20) })).toBeDefined()
    await ui.unmount()
  }
})

test('TaskCreate and TaskUpdate keep the list too, and the open pane tab shows the progress', async ($, on) => {
  const engine = answerEngine(on)
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the migration', description: 'add the column', activeForm: 'Writing the migration' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Backfill rows', description: 'batch update' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Drop the old table', description: 'later' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' })

  expect(engine.opened.at(-1)).toBe('Todos 1/2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1/2 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Backfill rows' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Drop the old table' })).toBeUndefined()

  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ type: 'Text', text: 'Write the migration' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '1 done item hidden' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'toggle-done' }))?.text).toBe('Show done')
  await ui.unmount()
})

test('/todos opens the pane; at start it stays only where the engine placed it', async ($, on) => {
  const engine = answerEngine(on, false)
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start
  expect(engine.opened).toEqual(['Todos'])
  expect(engine.closed).toEqual(['todos'])

  const run = await $.command.run({
    command: 'todos',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(run.text).toBe('No task list yet.')
  expect(engine.opened).toEqual(['Todos', 'Todos'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'No task list yet.' })).toBeDefined()
  await ui.unmount()
})

test('with autoOpen off nothing opens at start', { options: { autoOpen: false } }, async ($, on) => {
  const engine = answerEngine(on)
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start
  expect(engine.opened).toHaveLength(0)
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const
const RUN = { command: 'todos', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

test('with mods-hub: the Tasks tab opens with /todos, shows the list under the hub strip without a Close button, and no pane opens at start', async ($, on) => {
  const engine = answerEngine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['task.started', 'task.finished'], consumes: [] }])
  expect(hub.tabs).toEqual([{ id: 'tasks', title: 'Tasks', order: 260, command: 'todos' }])
  expect(engine.opened).toEqual([])

  await $.tool.call({ tool: 'TodoWrite', todos: [...PLAN] })
  expect(hub.tabs.at(-1)).toEqual({ id: 'tasks', title: 'Tasks 1/3', order: 260, command: 'todos' })
  expect((await $.command.run(RUN)).text).toBe('1 of 3 done.')
  expect(hub.shown).toEqual(['tasks'])
  expect(engine.opened).toEqual([])
  hub.tab = 'tasks'

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1/3 done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Fixing the off-by-one' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-done' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.unmount()
  }
})

test('with mods-hub: items turning in progress and finished are published as task.started and task.finished', async ($, on) => {
  answerEngine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start

  await $.tool.call({ tool: 'TodoWrite', todos: [...PLAN] })
  expect(hub.published).toEqual([{ topic: 'task.started', data: { id: 'todo-2', title: 'Fixing the off-by-one' } }])

  hub.published.length = 0
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the parser', activeForm: 'Reading the parser', status: 'completed' },
      { content: 'Fix the off-by-one', activeForm: 'Fixing the off-by-one', status: 'completed' },
      { content: 'Run the tests', activeForm: 'Running the tests', status: 'in_progress' },
    ],
  })
  expect(hub.published).toEqual([
    { topic: 'task.finished', data: { id: 'todo-2', title: 'Fix the off-by-one', outcome: 'ok' } },
    { topic: 'task.started', data: { id: 'todo-3', title: 'Running the tests' } },
  ])

  hub.published.length = 0
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the migration', description: 'd', activeForm: 'Writing the migration' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' })
  expect(hub.published.map(event => [event.topic, (event.data as { outcome?: string }).outcome])).toEqual([
    ['task.started', undefined],
    ['task.finished', 'cancelled'],
  ])
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  answerEngine(on)
  const hub = fakeHub(on)
  hub.tab = 'cost'
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [...PLAN] })
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1/3 done' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub nothing is published, no tab is registered and /todos opens the own pane', async ($, on) => {
  const engine = answerEngine(on)
  await $.session.start(START)
  await startClock?.advance(1_500) // afterStart: the hello and the pane at start
  await $.tool.call({ tool: 'TodoWrite', todos: [...PLAN] })
  await $.command.run(RUN)
  expect(engine.opened.at(-1)).toBe('Todos 1/3')
})

test('taskEvents: only transitions of items the mod has seen are news', () => {
  const item = (id: string, content: string, status: 'pending' | 'in_progress' | 'completed') => ({ id, content, activeForm: `${content}ing`, status })
  expect(taskEvents([], [item('todo-1', 'a', 'completed'), item('todo-2', 'b', 'pending')])).toEqual([])
  expect(taskEvents([item('todo-1', 'a', 'pending')], [item('todo-1', 'a', 'in_progress')])).toEqual([{ topic: 'task.started', data: { id: 'todo-1', title: 'aing' } }])
  // A rewritten list moves the positions: the item is still the same one.
  expect(taskEvents([item('todo-1', 'a', 'in_progress'), item('todo-2', 'b', 'pending')], [item('todo-1', 'b', 'in_progress'), item('todo-2', 'a', 'in_progress')])).toEqual([
    { topic: 'task.started', data: { id: 'todo-1', title: 'bing' } },
  ])
})

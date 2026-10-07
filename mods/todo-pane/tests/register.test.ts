import { test, expect } from 'claude-code/testing'
import type { On, UiOpenResult } from 'claude-code'

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
const answerEngine = (on: On, placed = true) => {
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
  expect(engine.opened).toHaveLength(0)
})

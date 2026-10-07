import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'test-first',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

/** The engine beneath the plugin: tool calls that reach it are counted, Bash fails while `bash.fails`. */
const engine = (on: On, below = 'nothing beneath') => {
  const reached: string[] = []
  const bash = { fails: false }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'below' }, children: [{ type: 'Text', props: {}, children: [below] }] }))
  on('tool.call', ($, e) => {
    reached.push(e.tool === 'Bash' ? e.command : 'file_path' in e ? String(e.file_path) : e.tool)
    if (e.tool === 'Bash' && bash.fails) return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nTests  1 failed (1)' }
    return { result: { stdout: 'Tests  3 passed (3)', stderr: '', interrupted: false } }
  })
  return { reached, bash }
}

const tdd = ($: Engine, args: string) =>
  $.command.run({ command: 'tdd', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

const newTurn = ($: Engine, turnId: string) => $.turn.start({ text: 'go on', turnId })

test('locks production code each turn until a test file has been edited', async ($, on) => {
  const { reached } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const on_ = await tdd($, 'on')
  expect(on_.text).toBe('TDD mode on. Production code stays locked each turn until a test is written.')
  expect(on_.context?.[0]).toContain('red → green → refactor')

  const locked = await edit($, '/repo/src/app.ts')
  expect(locked.deny).toStartWith('test-first: TDD mode is on, so src/app.ts stays locked until a test is written this turn.')
  await edit($, '/repo/README.md')
  await edit($, '/repo/src/app.test.ts')
  await edit($, '/repo/src/app.ts')
  expect(reached).toEqual(['/repo/README.md', '/repo/src/app.test.ts', '/repo/src/app.ts'])

  await newTurn($, 'turn-2')
  expect((await edit($, '/repo/src/app.ts')).deny).toBeDefined()

  await tdd($, 'off')
  expect((await edit($, '/repo/src/app.ts')).deny).toBeUndefined()
})

test('follows the cycle from test runs: red unlocks code, green locks it, edits under green are refactoring', async ($, on) => {
  const { bash } = engine(on)
  await tdd($, 'on')
  const phase = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const current = await ui.find({ type: 'Text', text: '●' })
    await ui.unmount()
    return current?.text.replace(/[●→]/g, '').trim()
  }

  bash.fails = true
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await phase()).toBe('red')
  await newTurn($, 'turn-2')
  expect((await edit($, '/repo/src/app.ts')).deny).toBeUndefined()

  bash.fails = false
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run src/app.test.ts' })
  expect(await phase()).toBe('green')
  expect((await edit($, '/repo/src/app.ts')).deny).toBeDefined()

  await edit($, '/repo/tests/test_app.py')
  expect(await phase()).toBe('red')
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await edit($, '/repo/src/app.ts')
  expect(await phase()).toBe('refactor')

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(await phase()).toBe('refactor')
})

test('the band shows the phase and the lock on terminal and desktop, and turns TDD off', async ($, on) => {
  engine(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'TDD' })).toBeUndefined()
    await ui.unmount()

    await tdd($, 'on')
    ui = await $.ui.mount({ ...BAND, surface })
    const red = await ui.find({ type: 'Text', text: '● red' })
    expect(red?.props).toMatchObject({ bold: true, color: 'error' })
    expect((await ui.find({ type: 'Text', text: 'green' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'code locked' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'write a failing test first' })).toBeDefined()

    await ui.press({ key: 'off' })
    expect(await ui.find({ type: 'Text', text: 'TDD' })).toBeUndefined()
    await ui.unmount()
  }
})

test('regression: a command that only names a runner does not count as a test run', async ($, on) => {
  const { bash } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await tdd($, 'on')

  // A failing run opens the code to make it pass...
  bash.fails = true
  await $.tool.call({ tool: 'Bash', command: 'cd web && npx vitest run' })
  bash.fails = false
  await newTurn($, 'turn-2')
  // ...and reading a config or installing a runner does not close it again.
  for (const command of ['cat jest.config.js', 'npm install -D vitest', 'grep -rn pytest .', 'git commit -m "add jest tests"']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect((await edit($, '/repo/src/app.ts')).deny).toBeUndefined()

  // A real passing run does.
  await $.tool.call({ tool: 'Bash', command: 'CI=1 npm run test:unit 2>&1 | tail -5' })
  await newTurn($, 'turn-3')
  expect((await edit($, '/repo/src/app.ts')).deny).toBeDefined()
})

test('regression: the TDD band keeps the bands beneath it on screen', async ($, on) => {
  engine(on, 'engine band')
  await tdd($, 'on')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'TDD' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

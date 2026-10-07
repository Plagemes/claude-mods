import { test, expect, mock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { fakeHub } from './hub'

type Run = { argv: readonly string[]; cwd: string | undefined }

const PANE_PROPS = {
  title: 'Tests',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** A project on a virtual disk (absolute path → text) whose test runner prints `output`. */
const world = (on: On, files: Record<string, string>, output: (argv: readonly string[]) => Partial<ProcessRunResult>) => {
  const runs: Run[] = []
  const statuses: string[] = []
  const opened: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('fs.list', ($, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Set(Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...output(e.argv) } }
  })
  on('tool.call', () => ({ result: { type: 'update' } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  return { runs, statuses, opened }
}

const VITEST_PROJECT = {
  '/repo/.git/HEAD': '',
  '/repo/package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
  '/repo/node_modules/.bin/vitest': '',
  '/repo/src/app.ts': '',
  '/repo/src/app.test.ts': '',
  '/repo/src/util.ts': '',
  '/repo/tests/util.spec.ts': '',
  '/repo/src/orphan.ts': '',
}

const VITEST_FAILED = {
  exitCode: 1,
  stdout: '\u001b[31m FAIL \u001b[39m src/app.test.ts > adds\n Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 10 passed (12)\n',
}

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const

test('runs the related tests 3s after the edits settle and shows the verdict', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, statuses } = world(on, VITEST_PROJECT, () => VITEST_FAILED)

  await $.tool.call(edit('/repo/src/app.ts'))
  await clock.advance(1000)
  await $.tool.call(edit('/repo/src/util.ts'))
  await clock.advance(2999)
  expect(runs).toHaveLength(0)

  await clock.advance(1)
  expect(runs).toEqual([
    { argv: ['/repo/node_modules/.bin/vitest', 'run', 'src/app.test.ts', 'tests/util.spec.ts'], cwd: '/repo' },
  ])
  expect(statuses).toEqual(['⧗ tests: running app.test.ts, util.spec.ts…', '✗ 2 failed · 10 passed'])
})

test('maps Python modules to pytest files and Go files to their package', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, statuses } = world(
    on,
    {
      '/repo/.git/HEAD': '',
      '/repo/pyproject.toml': '[project]\nname = "pkg"\n',
      '/repo/src/pkg/util.py': '',
      '/repo/tests/pkg/test_util.py': '',
      '/repo/svc/go.mod': 'module svc',
      '/repo/svc/api/handler.go': '',
      '/repo/svc/api/handler_test.go': '',
    },
    argv =>
      argv[0] === 'pytest'
        ? { stdout: '...\n3 passed in 0.12s\n' }
        : { stdout: '=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- PASS: TestB (0.00s)\nok  \tsvc/api\t0.01s\n' },
  )

  await $.tool.call(edit('/repo/src/pkg/util.py'))
  await $.tool.call(edit('/repo/svc/api/handler.go'))
  await clock.advance(3000)

  expect(runs).toEqual([
    { argv: ['pytest', '-q', 'tests/pkg/test_util.py'], cwd: '/repo' },
    { argv: ['go', 'test', '-v', './api'], cwd: '/repo/svc' },
  ])
  expect(statuses.at(-1)).toBe('✓ 5 passed')
})

test('says so when an edited file has no related tests', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, statuses } = world(on, VITEST_PROJECT, () => ({}))

  await $.tool.call(edit('/repo/src/orphan.ts'))
  await clock.advance(3000)

  expect(runs).toHaveLength(0)
  expect(statuses).toEqual(['○ tests: none related to orphan.ts'])
})

test('/tests-last shows the last run in a pane on every surface, and Run again reruns it', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, opened } = world(on, VITEST_PROJECT, () => VITEST_FAILED)
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/src/app.ts'))
  await clock.advance(3000)
  await $.command.run({ command: 'tests-last', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(opened).toEqual(['tests-last'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test-watch', surface, component: 'Pane', requestId: 'tests-last', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: '✗' }))?.text).toBe('✗ 2 failed · 10 passed')
    const output = await ui.find({ type: 'Code' })
    expect(output?.text).toContain('$ node_modules/.bin/vitest run src/app.test.ts')
    expect(output?.text).toContain('Tests  2 failed | 10 passed (12)')
    expect(output?.text).not.toContain('\u001b[')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'test-watch', surface: 'terminal', component: 'Pane', requestId: 'tests-last', props: PANE_PROPS })
  await ui.press({ key: 'rerun' })
  expect(runs).toHaveLength(2)
  await ui.unmount()
})

test('the pane explains itself before any run', async ($, on) => {
  world(on, VITEST_PROJECT, () => ({}))
  on('ui.render', () => ({ type: 'Box' }))

  const ui = await $.ui.mount({ plugin: 'test-watch', surface: 'desktop', component: 'Pane', requestId: 'tests-last', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'No test run yet' })).toBeDefined()
  expect(await ui.find({ key: 'rerun' })).toBeUndefined()
  await ui.unmount()
})

test('with mods-hub: publishes test.result and its plan, and /tests-last opens the Tests tab of the shared panel', async ($, on) => {
  const clock = mock.clock(on)
  const { opened, statuses } = world(on, VITEST_PROJECT, () => VITEST_FAILED)
  const hub = fakeHub(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['test.result'], consumes: [] }])
  expect(hub.tabs).toEqual([{ id: 'tests', title: 'Tests', order: 100, command: 'tests-last' }])

  await $.tool.call(edit('/repo/src/app.ts'))
  await clock.advance(3000)
  expect(statuses.at(-1)).toBe('✗ 2 failed · 10 passed')
  expect(hub.published).toEqual([
    {
      topic: 'test.result',
      data: { runner: 'vitest', outcome: 'failed', passed: 10, failed: 2, durationMs: 0, command: 'node_modules/.bin/vitest run src/app.test.ts' },
    },
  ])
  expect(hub.facts.get('plan')).toEqual({ runners: ['vitest'], targets: ['src/app.test.ts'], plans: [{ runner: 'vitest', cwd: '/repo' }] })

  await $.command.run({ command: 'tests-last', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(hub.shown).toEqual(['tests'])
  expect(opened).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test-watch', surface, component: 'Pane', requestId: 'claude-mods', props: { ...PANE_PROPS, title: 'Claude Mods' } })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '✗' }))?.text).toBe('✗ 2 failed · 10 passed')
    expect(await ui.find({ key: 'rerun' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.unmount()
  }
})

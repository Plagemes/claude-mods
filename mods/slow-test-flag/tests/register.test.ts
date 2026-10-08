import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

import { formatMs, isTestCommand, parseTimings, runnerOf, slowest } from '../hooks/durations'

const PYTEST_DURATIONS = `============================= test session starts ==============================
collected 12 items

tests/test_api.py ........                                               [ 66%]
tests/test_db.py ....                                                    [100%]

============================= slowest 10 durations =============================
1.52s call     tests/test_api.py::test_login
0.30s setup    tests/test_db.py::test_connect
0.21s call     tests/test_db.py::TestQueries::test_join
0.00s teardown tests/test_db.py::test_connect

(3 durations < 0.005s hidden.  Use -vv to show these durations.)
============================== 12 passed in 2.41s ==============================
`

const PYTEST_PLAIN = `============================= test session starts ==============================
collected 12 items

tests/test_api.py ............                                           [100%]

============================== 12 passed in 2.41s ==============================
`

const JEST_VERBOSE = `PASS src/auth.test.ts
  login
    ✓ accepts a valid password (812 ms)
    ✓ rejects a bad password (4 ms)
FAIL src/cart.test.ts (6.3 s)
  cart
    ✕ totals with tax (1534 ms)
    ✓ empties (2 ms)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
Time:        7.1 s
`

const VITEST_DEFAULT = ` ✓ src/utils.test.ts  (14 tests) 1523ms
 ✓ src/format.test.ts  (3 tests) 12ms
 ❯ src/slow.test.ts  (2 tests | 1 failed) 3204ms

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 18 passed (19)
`

const VITEST_VERBOSE = ` ✓ src/utils.test.ts (2 tests) 1523ms
   ✓ parses a long file 1500ms
   ✓ parses a short file 3ms

 Test Files  1 passed (1)
`

const GO_VERBOSE = `=== RUN   TestFast
--- PASS: TestFast (0.00s)
=== RUN   TestSlow
--- PASS: TestSlow (1.25s)
    --- PASS: TestSlow/sub (0.80s)
PASS
ok  \texample.com/app/store\t1.262s
FAIL\texample.com/app/api\t0.512s
`

const CARGO_REPORT = `     Running unittests src/lib.rs (target/debug/deps/app-1a2b3c)

running 2 tests
test parser::tests::quick ... ok <0.001s>
test parser::tests::big_input ... ok <2.310s>

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.31s
`

const CARGO_PLAIN = `     Running unittests src/lib.rs (target/debug/deps/app-1a2b3c)

running 1 test
test parser::tests::quick ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`

type Answer = { text: string; isError?: true } | { deny: string }

/** Bash tool results for `output`, and the toasts and status the plugin showed. */
const world = (on: On, output: Answer) => {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ('deny' in output ? output : { result: 'ok', ...output }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { toasts, statuses, clock }
}

const slowTests = ($: Engine) =>
  $.command.run({ command: 'slow-tests', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('shows the slowest pytest tests in a toast and the status line, slowest first', async ($, on) => {
  const { toasts, statuses } = world(on, { text: PYTEST_DURATIONS })

  await $.tool.call({ tool: 'Bash', command: 'pytest --durations=10' })

  expect(toasts).toEqual([
    [
      'slowest tests in that run:',
      ' 1.   1.52 s  tests/test_api.py::test_login',
      ' 2.   300 ms  tests/test_db.py::test_connect [setup]',
      ' 3.   210 ms  tests/test_db.py::TestQueries::test_join',
    ].join('\n'),
  ])
  expect(statuses).toEqual(['🐢 slowest test: 1.52 s · tests/test_api.py::test_login'])
})

test('/slow-tests lists the last run, and says so before any run', async ($, on) => {
  world(on, { text: PYTEST_DURATIONS })

  expect((await slowTests($)).text).toContain('No test run seen yet')

  await $.tool.call({ tool: 'Bash', command: 'python -m pytest --durations=10' })
  const shown = (await slowTests($)).text ?? ''

  expect(shown).toContain('Slowest tests in the last run, python -m pytest --durations=10 (just now):')
  expect(shown).toContain('tests/test_api.py::test_login')
  expect(shown.split('\n')).toHaveLength(4)
})

test('suggests the flag when the runner printed no durations, once per runner', async ($, on) => {
  const { toasts } = world(on, { text: PYTEST_PLAIN })

  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/test_api.py' })

  expect(toasts).toEqual(['no per-test times in that output: run pytest with --durations=10 to see the slowest tests'])
  expect((await slowTests($)).text).toContain('printed no per-test times. Try this: run pytest with --durations=10')
})

test('reads Jest verbose output: per-test times with their file, even when the run failed', async ($, on) => {
  const { toasts } = world(on, { text: JEST_VERBOSE, isError: true })

  await $.tool.call({ tool: 'Bash', command: 'npx jest --verbose' })

  expect(toasts[0]).toContain(' 1.   1.53 s  totals with tax  (cart.test.ts)')
  expect(toasts[0]).toContain(' 2.   812 ms  accepts a valid password  (auth.test.ts)')
  expect(toasts[0]).not.toContain('rejects a bad password') // 4 ms: under the 100 ms threshold
})

test('falls back to files when the output has no per-test times (Vitest default reporter)', async ($, on) => {
  const { toasts, statuses } = world(on, { text: VITEST_DEFAULT })

  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(toasts[0]?.split('\n')).toEqual(['slowest files in that run:', ' 1.   3.20 s  src/slow.test.ts', ' 2.   1.52 s  src/utils.test.ts'])
  expect(statuses[0]).toBe('🐢 slowest file: 3.20 s · src/slow.test.ts')
})

test('goes per test with Vitest verbose output', async ($, on) => {
  const { toasts } = world(on, { text: VITEST_VERBOSE })

  await $.tool.call({ tool: 'Bash', command: 'vitest run --reporter=verbose' })

  expect(toasts[0]?.split('\n')).toEqual(['slowest tests in that run:', ' 1.   1.50 s  parses a long file  (utils.test.ts)'])
})

test('reads go test per-test and per-package times', async ($, on) => {
  const { toasts } = world(on, { text: GO_VERBOSE })

  await $.tool.call({ tool: 'Bash', command: 'go test -v ./...' })

  expect(toasts[0]?.split('\n')).toEqual(['slowest tests in that run:', ' 1.   1.25 s  TestSlow', ' 2.   800 ms  TestSlow/sub'])
})

test('reads cargo --report-time output, with the test binary it ran in', async ($, on) => {
  const { toasts } = world(on, { text: CARGO_REPORT })

  await $.tool.call({ tool: 'Bash', command: 'cargo +nightly test -- -Z unstable-options --report-time' })

  expect(toasts[0]).toContain(' 1.   2.31 s  parser::tests::big_input  (lib.rs)')
})

test('cargo without timings gets the nextest hint', async ($, on) => {
  const { toasts } = world(on, { text: CARGO_PLAIN })

  await $.tool.call({ tool: 'Bash', command: 'cargo test' })

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('cargo nextest')
})

test('ignores commands that are not test runs, and background runs', async ($, on) => {
  const { toasts, statuses } = world(on, { text: PYTEST_DURATIONS })

  await $.tool.call({ tool: 'Bash', command: 'cat results.txt' })
  await $.tool.call({ tool: 'Bash', command: 'pytest --durations=10', run_in_background: true })

  expect(toasts).toEqual([])
  expect(statuses).toEqual([])
})

test('ignores refused calls and test commands whose output shows no test run', async ($, on) => {
  const refused = world(on, { deny: 'no' })
  await $.tool.call({ tool: 'Bash', command: 'pytest --durations=10' })
  expect(refused.toasts).toEqual([])
})

test('a test command that printed nothing about tests is not commented on', async ($, on) => {
  const { toasts } = world(on, { text: 'sh: 1: pytest: not found' })

  await $.tool.call({ tool: 'Bash', command: 'pytest' })

  expect(toasts).toEqual([])
  expect((await slowTests($)).text).toContain('No test run seen yet')
})

test('the options choose how many tests are listed and how slow counts as slow', { options: { top: 1, thresholdMs: 1000, status: false } }, async ($, on) => {
  const { toasts, statuses } = world(on, { text: PYTEST_DURATIONS })

  await $.tool.call({ tool: 'Bash', command: 'pytest --durations=10' })

  expect(toasts[0]?.split('\n')).toEqual(['slowest tests in that run:', ' 1.   1.52 s  tests/test_api.py::test_login'])
  expect(statuses).toEqual([])
})

test('says when nothing in the run was slow', { options: { thresholdMs: 10_000 } }, async ($, on) => {
  const { toasts, statuses } = world(on, { text: JEST_VERBOSE })

  await $.tool.call({ tool: 'Bash', command: 'jest --verbose' })

  expect(toasts).toEqual([])
  expect(statuses).toEqual([undefined]) // the status line from an earlier run is cleared
  expect((await slowTests($)).text).toContain('Nothing took 10.00 s or longer in the last run, jest --verbose (just now).')
})

test('parseTimings keeps the order of the output, drops zero times, and slowest picks one level and sorts', () => {
  const timings = parseTimings(GO_VERBOSE)

  expect(timings.map(timing => [timing.level, timing.name, timing.ms])).toEqual([
    ['test', 'TestSlow', 1250],
    ['test', 'TestSlow/sub', 800],
    ['group', 'example.com/app/store', 1262],
    ['group', 'example.com/app/api', 512],
  ])
  expect(slowest(timings, 1, 0)).toEqual({ level: 'test', items: [timings[0]] })
  expect(slowest(timings.slice(2), 5, 600).items.map(timing => timing.name)).toEqual(['example.com/app/store'])
})

test('runnerOf trusts the command, then the shape of the output', () => {
  expect(runnerOf('python -m pytest -x', '')).toBe('pytest')
  expect(runnerOf('npm test', JEST_VERBOSE)).toBe('jest')
  expect(runnerOf('npm test', VITEST_DEFAULT)).toBe('vitest')
  expect(runnerOf('make', 'nothing')).toBeUndefined()
})

test('formatMs reads naturally from milliseconds to minutes', () => {
  expect([formatMs(80), formatMs(1520), formatMs(75_000)]).toEqual(['80 ms', '1.52 s', '1m 15s'])
})

test('parseTimings skips very long lines instead of backtracking over them', () => {
  const started = Date.now()
  const timings = parseTimings(`✓ a${' '.repeat(100_000)}x\n0.1s call x${' '.repeat(100_000)}y\n  ✓ renders (120 ms)`)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(timings.map(timing => timing.name)).toEqual(['renders'])
})

test('regression: a command that only names a runner is not a test run', () => {
  for (const command of ['cat jest.config.js', 'npm i -D vitest', 'git commit -m "add jest"', 'tail -50 pytest.log', 'pip install pytest']) {
    expect(isTestCommand(command)).toBe(false)
  }
  expect(runnerOf('cat jest.config.js', '')).toBeUndefined()
  for (const command of ['cd web && npx vitest run', 'poetry run pytest --durations=10', 'yarn test:unit', 'cargo +nightly nextest run', 'tox -e py311']) {
    expect(isTestCommand(command)).toBe(true)
  }
  expect(runnerOf('cd web && npx vitest run', '')).toBe('vitest')
})

const SETTLE_MS = 250

/** The Bash run, after which mods-hub (as its sensor does) records `test.result` for `command` with `durationMs`. */
const hubbedRun = async ($: Engine, hub: ReturnType<typeof fakeHub>, clock: { now: () => number; advance: (ms: number) => Promise<void> }, command: string, durationMs?: number) => {
  await $.tool.call({ tool: 'Bash', command })
  if (durationMs !== undefined) {
    hub.events.push({ topic: 'test.result', data: { runner: 'pytest', outcome: 'passed', passed: 12, failed: 0, durationMs, command }, at: clock.now(), source: 'mods-hub' })
  }
  await clock.advance(SETTLE_MS)
}

test('with mods-hub: says hello, notifies the slowest tests as one info notice with the run\'s total time, and keeps the status line', async ($, on) => {
  const { toasts, statuses, clock } = world(on, { text: PYTEST_DURATIONS })
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['test.result'] }])

  await hubbedRun($, hub, clock, 'pytest --durations=10', 2410)

  expect(hub.notified).toEqual([
    {
      level: 'info',
      title: 'slowest tests in that run (2.41 s in all):',
      body: [' 1.   1.52 s  tests/test_api.py::test_login', ' 2.   300 ms  tests/test_db.py::test_connect [setup]', ' 3.   210 ms  tests/test_db.py::TestQueries::test_join'].join('\n'),
      topic: 'test.result',
    },
  ])
  expect(toasts).toEqual([])
  expect(statuses).toEqual(['🐢 slowest test: 1.52 s · tests/test_api.py::test_login'])
  expect((await slowTests($)).text).toContain('Slowest tests in the last run, pytest --durations=10')
})

test('with mods-hub but no test.result for the call, or one for another run: the output alone is read', async ($, on) => {
  const { clock } = world(on, { text: JEST_VERBOSE })
  const hub = fakeHub(on)
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 3, failed: 0, durationMs: 9_000, command: 'vitest run' }, at: 1_000_100, source: 'test-watch' })

  await hubbedRun($, hub, clock, 'npx jest --verbose')

  expect(hub.notified).toHaveLength(1)
  expect(hub.notified[0]?.title).toBe('slowest tests in that run:')
  expect(hub.notified[0]?.body).toContain('totals with tax  (cart.test.ts)')
})

test('with mods-hub: the flag suggestion is an info notice too, once per runner', async ($, on) => {
  const { toasts, clock } = world(on, { text: PYTEST_PLAIN })
  const hub = fakeHub(on)

  await hubbedRun($, hub, clock, 'pytest -q', 1_000)
  await hubbedRun($, hub, clock, 'pytest tests/test_api.py', 1_000)

  expect(hub.notified).toEqual([{ level: 'info', title: 'no per-test times in that output: run pytest with --durations=10 to see the slowest tests', topic: 'test.result' }])
  expect(toasts).toEqual([])
})

test('with mods-hub: commands that are not test runs are left alone, and the status of a run with nothing slow is cleared', { options: { thresholdMs: 10_000 } }, async ($, on) => {
  const { statuses, clock } = world(on, { text: JEST_VERBOSE })
  const hub = fakeHub(on)

  await hubbedRun($, hub, clock, 'cat results.txt')
  expect(statuses).toEqual([])

  await hubbedRun($, hub, clock, 'jest --verbose', 7_100)
  expect(hub.notified).toEqual([])
  expect(statuses).toEqual([undefined])
})

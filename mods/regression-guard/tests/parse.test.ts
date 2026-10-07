import { expect, test } from 'claude-code/testing'

import { applyRun, touchedBy } from '../hooks/baseline'
import { isTestCommand, parseResults } from '../hooks/parse'
import type { TestResult } from '../hooks/parse'

const JEST = `
> app@1.0.0 test
> jest --verbose

PASS src/sum.test.js
  math
    ✓ adds numbers (3 ms)
    ✓ subtracts numbers (1 ms)
FAIL src/user.test.js
  user
    ✓ has a name (2 ms)
    ✕ greets (4 ms)

  ● user › greets

    expect(received).toBe(expected) // Object.is equality

    Expected: "Hello, Ada"
    Received: "Hi, Ada"

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
`

const VITEST = `
 RUN  v2.1.0 /repo

 ✓ src/sum.test.ts (2 tests) 3ms
 ❯ src/user.test.ts (2 tests | 1 failed) 5ms
   × user > greets 3ms
     → expected 'Hi, Ada' to be 'Hello, Ada'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/user.test.ts > user > greets
AssertionError: expected 'Hi, Ada' to be 'Hello, Ada'

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
`

const PYTEST_VERBOSE = `
============================= test session starts ==============================
tests/test_cart.py::test_total PASSED                                    [ 33%]
tests/test_cart.py::test_discount[10] FAILED                             [ 66%]
tests/test_user.py::test_name PASSED                                     [100%]
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_discount[10] - assert 90 == 81
`

const PYTEST_QUIET = `
tests/test_cart.py .F                                                    [ 66%]
tests/test_user.py .                                                     [100%]
FAILED tests/test_cart.py::test_discount[10] - assert 90 == 81
`

const GO = `
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestDiv
--- FAIL: TestDiv (0.00s)
    div_test.go:12: want 2, got 0
FAIL
FAIL	example.com/calc	0.004s
ok  	example.com/strs	(cached)
`

const CARGO = `
running 2 tests
test parser::tests::reads_numbers ... ok
test parser::tests::reads_words ... FAILED
`

const MOCHA = `
  Array
    #indexOf()
      ✔ returns -1 when absent
      1) finds the index


  1 passing (5ms)
  1 failing

  1) Array
       #indexOf()
         finds the index:
     AssertionError: expected -1 to equal 0
`

const TAP = `
TAP version 13
ok 1 - parses dates
not ok 2 - formats dates
ok 3 - skipped one # SKIP no locale
`

const byName = (results: readonly TestResult[]) =>
  Object.fromEntries(results.map(result => [result.name, result.isGroup ? `${result.outcome} (group)` : result.outcome]))

test('recognises test commands and nothing else', () => {
  for (const command of ['npm test', 'pnpm run test:unit', 'npx vitest run', 'pytest -q tests', 'go test ./...', 'cargo test', 'node --test', 'python -m pytest']) {
    expect(isTestCommand(command)).toBe(true)
  }
  for (const command of ['npm run build', 'git status', 'cat test.txt', 'ls tests/']) {
    expect(isTestCommand(command)).toBe(false)
  }
})

test('reads Jest verbose output with describe blocks and failure details', () => {
  expect(byName(parseResults(JEST))).toEqual({
    'src/sum.test.js': 'pass (group)',
    'src/sum.test.js › math › adds numbers': 'pass',
    'src/sum.test.js › math › subtracts numbers': 'pass',
    'src/user.test.js': 'fail (group)',
    'src/user.test.js › user › has a name': 'pass',
    'src/user.test.js › user › greets': 'fail',
  })
})

test('reads Vitest default output: files, and the tests that failed', () => {
  const results = parseResults(VITEST)
  expect(byName(results)).toEqual({
    'src/sum.test.ts': 'pass (group)',
    'src/user.test.ts': 'fail (group)',
    'src/user.test.ts > user > greets': 'fail',
  })
  expect(results.find(result => result.name === 'src/user.test.ts > user > greets')?.group).toBe('src/user.test.ts')
})

test('reads pytest verbose, quiet progress and summary lines', () => {
  expect(byName(parseResults(PYTEST_VERBOSE))).toEqual({
    'tests/test_cart.py::test_total': 'pass',
    'tests/test_cart.py::test_discount[10]': 'fail',
    'tests/test_user.py::test_name': 'pass',
  })
  expect(byName(parseResults(PYTEST_QUIET))).toEqual({
    'tests/test_cart.py': 'fail (group)',
    'tests/test_user.py': 'pass (group)',
    'tests/test_cart.py::test_discount[10]': 'fail',
  })
})

test('reads go test, cargo test, Mocha and TAP', () => {
  const go = parseResults(GO)
  expect(byName(go)).toEqual({ TestAdd: 'pass', TestDiv: 'fail', 'example.com/calc': 'fail (group)', 'example.com/strs': 'pass (group)' })
  expect(go.find(result => result.name === 'TestDiv')?.group).toBe('example.com/calc')
  expect(byName(parseResults(CARGO))).toEqual({ 'parser::tests::reads_numbers': 'pass', 'parser::tests::reads_words': 'fail' })
  expect(byName(parseResults(MOCHA))).toEqual({
    'Array › #indexOf() › returns -1 when absent': 'pass',
    'Array › #indexOf() › finds the index': 'fail',
  })
  expect(byName(parseResults(TAP))).toEqual({ 'parses dates': 'pass', 'formats dates': 'fail' })
  expect(parseResults('Compiled 12 files in 3.2s\nDone.')).toEqual([])
})

test('the first sighting of a test is its baseline; a passing one that fails later is a regression', () => {
  const pass = (name: string, group?: string): TestResult => ({ name, outcome: 'pass', ...(group ? { group } : {}) })
  const fail = (name: string, group?: string): TestResult => ({ name, outcome: 'fail', ...(group ? { group } : {}) })

  const first = applyRun({}, [], [pass('a'), pass('b'), fail('c')], 1, 'npm test')
  expect(first.baseline).toEqual({ a: 'pass', b: 'pass', c: 'fail' })
  expect(first.added).toEqual([])

  const second = applyRun(first.baseline, first.regressions, [fail('a'), pass('b'), fail('c'), fail('d')], 2, 'npm test')
  expect(second.added).toEqual([{ name: 'a', since: 2, command: 'npm test' }])
  expect(second.baseline.d).toBe('fail')
  expect([second.passed, second.failed]).toEqual([1, 3])

  const third = applyRun(second.baseline, second.regressions, [fail('a')], 3, 'npm test -- a')
  expect(third.added).toEqual([])
  expect(third.regressions[0]?.since).toBe(2)

  const fourth = applyRun(third.baseline, third.regressions, [pass('a')], 4, 'npm test')
  expect(fourth.fixed).toEqual(['a'])
  expect(fourth.regressions).toEqual([])
})

test('files that passed in full stand for their tests, unless Claude edited the test file', () => {
  const baseline = applyRun({}, [], parseResults(VITEST), 1, 'npx vitest run').baseline
  const broken = parseResults(' ❯ src/sum.test.ts (2 tests | 1 failed) 3ms\n   × math > adds 2ms\n')

  const untouched = applyRun(baseline, [], broken, 2, 'npx vitest run')
  expect(untouched.added.map(regression => regression.name)).toEqual(['src/sum.test.ts > math > adds'])

  const edited = touchedBy(['/repo/src/sum.test.ts'])
  const touched = applyRun(baseline, [], broken, 2, 'npx vitest run', edited)
  expect(touched.added).toEqual([])
  expect(touched.baseline['src/sum.test.ts > math > adds']).toBe('fail')

  const green = applyRun(untouched.baseline, untouched.regressions, parseResults(' ✓ src/sum.test.ts (2 tests) 3ms\n'), 3, 'npx vitest run')
  expect(green.fixed).toEqual(['src/sum.test.ts > math > adds'])
  expect(touchedBy(['/home/me/calc/div_test.go'])('example.com/calc')).toBe(true)
  expect(touchedBy(['/home/me/calc/div.go'])('example.com/calc')).toBe(false)
})

test('regression: a command that only names a runner is not a test run', () => {
  for (const command of ['cat jest.config.js', 'npm i -D vitest', 'git commit -m "add jest"', 'tail -100 pytest.log', 'grep -rn rspec Gemfile', 'pip install pytest']) {
    expect(isTestCommand(command)).toBe(false)
  }
  for (const command of ['cd web && npx vitest run', 'CI=1 yarn jest', 'poetry run pytest', 'bundle exec rspec', './gradlew test', 'make check', 'python3 -m unittest']) {
    expect(isTestCommand(command)).toBe(true)
  }
})

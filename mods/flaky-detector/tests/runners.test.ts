import { expect, test } from 'claude-code/testing'

import { applyRun, emptyHistory, suspectsOf } from '../hooks/history'
import { isTestCommand, normalizeCommand, parseRun, runnerOfCommand } from '../hooks/runners'
import type { RunReport } from '../hooks/runners'
import { CARGO_FAIL, GO_FAIL, GO_VERBOSE, JEST_FAIL, JEST_VERBOSE, PYTEST_FAIL, PYTEST_VERBOSE, RSPEC_FAIL, VITEST_FAIL, VITEST_VERBOSE } from './fixtures'

const outcomes = (report: RunReport | undefined) =>
  (report?.tests ?? []).map(one => `${one.outcome === 'pass' ? '✓' : '✗'} ${one.id}`).sort()

test('vitest: failures from both reporters, passes per test or per passing file', () => {
  const plain = parseRun('npx vitest run', VITEST_FAIL)
  expect(plain?.runner).toBe('vitest')
  expect(outcomes(plain)).toEqual([
    '✓ src/math.test.js > math > adds',
    '✓ src/math.test.js > math > nested > multiplies',
    '✗ src/math.test.js > math > divides by zero',
    '✗ src/math.test.js > top level fails',
  ])
  expect(plain?.passedScopes).toEqual(['src/clock.test.js'])
  expect(plain?.isComplete).toBe(true)
  expect(plain?.allPassed).toBe(false)
  const verbose = parseRun('npm test', VITEST_VERBOSE)
  expect(outcomes(verbose)).toContain('✓ src/clock.test.js > ticks')
  expect(outcomes(verbose)).toContain('✗ src/math.test.js > top level fails')
})

test('jest: ● failures under their file, the --verbose tree with nested describes', () => {
  const plain = parseRun('npx jest', JEST_FAIL)
  expect(outcomes(plain)).toEqual(['✗ jest/cart.test.js > cart > applies discount', '✗ jest/cart.test.js > cart > checkout > charges card'])
  expect(plain?.passedScopes).toEqual(['jest/util.test.js'])
  expect(outcomes(parseRun('npm test -- --verbose', JEST_VERBOSE))).toEqual([
    '✓ jest/cart.test.js > cart > adds items',
    '✓ jest/util.test.js > formats',
    '✗ jest/cart.test.js > cart > applies discount',
    '✗ jest/cart.test.js > cart > checkout > charges card',
  ])
})

test('pytest: the short summary, -v lines, and files whose progress dots show no failure', () => {
  const plain = parseRun('pytest', PYTEST_FAIL)
  expect(outcomes(plain)).toEqual(['✗ test_shop.py::TestCart::test_remove', '✗ test_shop.py::test_even[1]', '✗ test_shop.py::test_tax'])
  expect(plain?.passedScopes).toEqual(['test_other.py'])
  const verbose = parseRun('python -m pytest -v', PYTEST_VERBOSE)
  expect(outcomes(verbose)).toContain('✓ test_shop.py::test_even[2]')
  expect(verbose?.tests).toHaveLength(7)
  const broken = parseRun('pytest', 'ERROR tests/test_db.py - ModuleNotFoundError: No module named \'psycopg\'\n=== 1 error in 0.12s ===\n')
  expect(broken?.failedScopes).toEqual(['tests/test_db.py'])
  expect(broken?.allPassed).toBe(false)
})

test('go test: tests tied to their package line, subtests included; ok packages pass whole', () => {
  const plain = parseRun('go test ./...', GO_FAIL)
  expect(outcomes(plain)).toEqual([
    '✗ example.com/shop/calc.TestDiv',
    '✗ example.com/shop/calc.TestTable',
    '✗ example.com/shop/calc.TestTable/large',
  ])
  expect(plain?.passedScopes).toEqual(['example.com/shop/store'])
  expect(outcomes(parseRun('go test -v ./...', GO_VERBOSE))).toEqual([
    '✓ example.com/shop/calc.TestAdd',
    '✓ example.com/shop/calc.TestTable/small',
    '✓ example.com/shop/store.TestSave',
    '✗ example.com/shop/calc.TestDiv',
    '✗ example.com/shop/calc.TestTable',
    '✗ example.com/shop/calc.TestTable/large',
  ])
})

test('cargo test and rspec', () => {
  expect(outcomes(parseRun('cargo test', CARGO_FAIL))).toEqual(['✓ src/lib.rs tests::it_adds', '✗ src/lib.rs tests::it_fails'])
  const rspec = parseRun('bundle exec rspec', RSPEC_FAIL)
  expect(outcomes(rspec)).toEqual(['✗ spec/models/user_spec.rb > User rejects blank names', '✗ spec/models/user_spec.rb > User when admin can delete posts'])
  expect(rspec?.isComplete).toBe(true)
  expect(parseRun('ls -la', 'total 0\n')).toBeUndefined()
})

test('test commands and their normal form', () => {
  expect(isTestCommand('npm test')).toBe(true)
  expect(isTestCommand('pnpm run test:unit')).toBe(true)
  expect(isTestCommand('CI=1 npx vitest run src/math.test.js')).toBe(true)
  expect(isTestCommand('go test ./...')).toBe(true)
  expect(isTestCommand('npm run build')).toBe(false)
  expect(normalizeCommand('CI=1  pytest -q  tests/')).toBe('pytest tests/')
  expect(normalizeCommand('npx vitest run --reporter=verbose')).toBe('npx vitest run')
})

test('a test that fails then passes on the same code is flaky; after a code change it is not', () => {
  const failing = parseRun('npx vitest run', VITEST_FAIL) as RunReport
  const passing: RunReport = { runner: 'vitest', tests: [], passedScopes: [], failedScopes: [], allPassed: true, isComplete: true }
  let history = emptyHistory()

  history = applyRun(history, { report: failing, command: 'npx vitest run', fingerprint: 'tree:a', at: 1 }).history
  expect(suspectsOf(history).watching.map(one => one.id)).toEqual(['src/math.test.js > math > divides by zero', 'src/math.test.js > top level fails'])

  // The code changed (tree b), then everything passed: a fix, not a flake.
  const fixed = applyRun(history, { report: passing, command: 'CI=1 npx vitest run', fingerprint: 'tree:b', at: 2 })
  expect(fixed.newlyFlaky).toEqual([])
  expect(fixed.history.records['src/math.test.js > top level fails']?.outcomes.map(one => one.outcome)).toEqual(['fail', 'pass'])

  // It fails again on tree b with nothing edited: that is a flip.
  const again = applyRun(fixed.history, { report: failing, command: 'npx vitest run', fingerprint: 'tree:b', at: 3 })
  expect(again.newlyFlaky.map(one => one.id).sort()).toEqual(['src/math.test.js > math > divides by zero', 'src/math.test.js > top level fails'])
  const flaky = suspectsOf(again.history).flaky
  expect(flaky.map(one => one.flips)).toEqual([1, 1])

  // The next failure of a known flaky test is reported as such.
  const third = applyRun(again.history, { report: failing, command: 'npx vitest run', fingerprint: 'tree:b', at: 4 })
  expect(third.flakyFailures.map(one => one.id).sort()).toEqual(['src/math.test.js > math > divides by zero', 'src/math.test.js > top level fails'])
})

test('a first failure on code a recent run passed is a flip; a run of other files does not count as a pass', () => {
  const verbose = parseRun('npx vitest run --reporter=verbose', VITEST_VERBOSE) as RunReport
  const allGreen: RunReport = { ...verbose, tests: verbose.tests.map(one => ({ ...one, outcome: 'pass' as const })), allPassed: true }
  let history = applyRun(emptyHistory(), { report: allGreen, command: 'npx vitest run', fingerprint: 'tree:a', at: 1 }).history
  const failed = applyRun(history, { report: verbose, command: 'npx vitest run', fingerprint: 'tree:a', at: 2 })
  expect(failed.newlyFlaky.map(one => one.id).sort()).toEqual(['src/math.test.js > math > divides by zero', 'src/math.test.js > top level fails'])

  history = applyRun(emptyHistory(), { report: verbose, command: 'npx vitest run', fingerprint: 'tree:a', at: 1 }).history
  const other: RunReport = { runner: 'vitest', tests: [{ id: 'src/clock.test.js > ticks', outcome: 'pass' }], passedScopes: ['src/clock.test.js'], failedScopes: [], allPassed: true, isComplete: true }
  const next = applyRun(history, { report: other, command: 'npx vitest run src/clock.test.js', fingerprint: 'tree:a', at: 2 })
  expect(next.newlyFlaky).toEqual([])
  expect(next.history.records['src/math.test.js > top level fails']?.outcomes).toHaveLength(1)
})

test('regression: a command that only names a runner is not a test run', () => {
  for (const command of ['cat jest.config.js', 'npm i -D vitest', 'git commit -m "add jest"', 'tail -50 pytest-output.log', 'grep -rn rspec Gemfile', 'pip install pytest']) {
    expect(isTestCommand(command)).toBe(false)
    expect(runnerOfCommand(command)).toBeUndefined()
  }
  expect(runnerOfCommand('cd web && npx vitest run')).toBe('vitest')
  expect(runnerOfCommand('python -m pytest -q')).toBe('pytest')
  expect(runnerOfCommand('bundle exec rspec spec/a_spec.rb')).toBe('rspec')
  expect(runnerOfCommand('./node_modules/.bin/jest --ci')).toBe('jest')
  expect(runnerOfCommand('go test ./...')).toBe('go')
  expect(runnerOfCommand('cargo nextest run')).toBe('cargo')
  expect(isTestCommand('yarn test:e2e')).toBe(true)
  expect(isTestCommand('make test')).toBe(true)
})

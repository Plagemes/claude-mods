// @vendored shared/test-runners.ts sha256:0be4989c5880 by scripts/sync-shared.mjs: edit the source, then run `node scripts/sync-shared.mjs`; never this copy.
/**
 * shared/test-runners.ts — one answer to "is this a test run, which runner, and what did it say?".
 *
 * Extracted from:
 *   - mods/flaky-detector/hooks/runners.ts  command detection past launchers (npx, python -m, poetry run, bundle exec)
 *                                           and runner detection from output (vitest, jest, pytest, go, cargo, rspec)
 *   - mods/test-watch/hooks/runners.ts      the pass/fail counts of each runner's summary, ANSI stripping, test-file shapes
 * Pure: no `$`, no I/O. Vendored into mods by scripts/sync-shared.mjs.
 */

export type TestRunner = 'vitest' | 'jest' | 'pytest' | 'go' | 'cargo' | 'rspec' | 'mocha' | 'bun' | 'deno' | 'phpunit'

/** What a finished run said: `passed`/`failed` are null where the output gives no count. */
export type TestRunSummary = {
  runner: TestRunner | undefined
  outcome: 'passed' | 'failed' | 'error'
  passed: number | null
  failed: number | null
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const TEST_FILE = /(^|\/)__tests__\/|[._](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$|Test\.php$/

/** A shell segment's start, past env assignments and launchers (`npx`, `python -m`, `poetry run`, `bundle exec`...) and a path. */
const LAUNCHED =
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
  String.raw`(?:[\w.~-]*\/)*`
/** A runner as the command a segment runs: `cat jest.config.js`, `npm i -D vitest` or `git commit -m "fix pytest"` run none. */
const RUNNER = new RegExp(
  LAUNCHED + String.raw`(vitest|jest|py\.test|pytest|go\s+test|cargo\s+(?:test|nextest)|rspec|mocha|bun\s+test|deno\s+test|phpunit)(?![\w./-])`,
)
/** A package script or make target named test. */
const TEST_SCRIPT = new RegExp(LAUNCHED + String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|(?:make|just|task)\s+test)(?![\w./-])`)
/**
 * A test tool whose output this module does not count (its runner stays undefined): tox, nox, ctest, dotnet test,
 * swift test, mix test, python -m unittest, and Maven / Gradle (wrappers too) with a `test` goal or task
 * (`mvn -q clean test`, `./gradlew :app:test`), never a flag that only names one (`-DskipTests`).
 */
const TEST_TOOL = new RegExp(
  LAUNCHED +
    String.raw`(?:tox|nox|ctest|unittest|(?:dotnet|swift|mix)\s+test|(?:mvnw?|gradlew?)(?:\s+\S+)*?\s+(?:\S*:)?test)(?![\w./-])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

const RUNNER_OF: Record<string, TestRunner> = {
  vitest: 'vitest', jest: 'jest', 'py.test': 'pytest', pytest: 'pytest', go: 'go', cargo: 'cargo',
  rspec: 'rspec', mocha: 'mocha', bun: 'bun', deno: 'deno', phpunit: 'phpunit',
}

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** Whether a path looks like a test file (`a.test.ts`, `__tests__/x.js`, `test_a.py`, `a_test.go`, `a_spec.rb`, `ATest.php`). */
export const isTestFile = (path: string): boolean => TEST_FILE.test(path)

/** The runner a command invokes directly, if it is one; `npm test` and friends are told apart by their output. */
export function runnerOfCommand(command: string): TestRunner | undefined {
  for (const segment of command.split(SEGMENTS)) {
    const found = RUNNER.exec(segment)?.[1]
    if (found !== undefined) return RUNNER_OF[found.split(/\s/)[0] ?? '']
  }
  return undefined
}

/** Whether a shell command runs tests at all (a runner, a test tool, or a package script named test), rather than only naming one. */
export const isTestCommand = (command: string): boolean =>
  runnerOfCommand(command) !== undefined || command.split(SEGMENTS).some(segment => TEST_SCRIPT.test(segment) || TEST_TOOL.test(segment))

/** The runner whose summary the output carries. */
export function runnerOfOutput(output: string): TestRunner | undefined {
  const text = stripAnsi(output)
  if (/^\s*Test Files\s+\d+/m.test(text)) return 'vitest'
  if (/^Tests:\s+\d+/m.test(text) && /^Test Suites:/m.test(text)) return 'jest'
  if (/^=+ .*\b(?:passed|failed|errors?|skipped|no tests ran)\b.* in [\d.]+s/m.test(text) || /short test summary info/.test(text)) return 'pytest'
  if (/^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/m.test(text) || /^\s*--- (?:FAIL|PASS):/m.test(text)) return 'go'
  if (/^test result: (?:ok|FAILED)\./m.test(text)) return 'cargo'
  if (/^\d+ examples?, \d+ failures?/m.test(text)) return 'rspec'
  if (/^\s*\d+ passing \(/m.test(text)) return 'mocha'
  if (/^\s*\d+ pass\s*$/m.test(text) && /^\s*\d+ fail\s*$/m.test(text)) return 'bun'
  if (/^(?:ok|FAILED) \| \d+ passed/m.test(text)) return 'deno'
  if (/^(?:OK \(\d+ tests?|Tests: \d+, Assertions:)/m.test(text)) return 'phpunit'
  return undefined
}

const sumOf = (text: string, pattern: RegExp): number | null => {
  const found = [...text.matchAll(pattern)]
  return found.length === 0 ? null : found.reduce((sum, match) => sum + Number(match[1]), 0)
}

const countIn = (line: string | undefined): { passed: number | null; failed: number | null } => ({
  passed: line === undefined ? null : sumOf(line, /(\d+) passed/g),
  failed: line === undefined ? null : sumOf(line, /(\d+) (?:failed|errors?)\b/g),
})

/** The passed and failed counts a runner's summary reports; null where it says none. */
export function countsOf(runner: TestRunner, output: string): { passed: number | null; failed: number | null } {
  const text = stripAnsi(output)
  const lines = text.split('\n')
  switch (runner) {
    case 'vitest':
      return countIn(lines.findLast(line => /^\s*Tests\s+\d/.test(line)))
    case 'jest':
      return countIn(lines.findLast(line => /^\s*Tests:\s+\d/.test(line)))
    case 'pytest':
      return countIn(lines.findLast(line => /\d+ (passed|failed|errors?)\b/.test(line)))
    case 'go': {
      const passed = (text.match(/^\s*--- PASS:/gm) ?? []).length
      const failed = (text.match(/^\s*--- FAIL:/gm) ?? []).length
      return passed + failed === 0 ? { passed: null, failed: null } : { passed, failed }
    }
    case 'cargo':
      return { passed: sumOf(text, /test result: \w+\. (\d+) passed/g), failed: sumOf(text, /test result: \w+\. \d+ passed; (\d+) failed/g) }
    case 'rspec': {
      const line = lines.findLast(row => /^\d+ examples?, \d+ failures?/.test(row))
      if (line === undefined) return { passed: null, failed: null }
      const examples = Number(/^(\d+) examples?/.exec(line)?.[1] ?? 0)
      const failed = Number(/(\d+) failures?/.exec(line)?.[1] ?? 0)
      return { passed: examples - failed, failed }
    }
    case 'mocha':
      return { passed: sumOf(text, /^\s*(\d+) passing/gm), failed: sumOf(text, /^\s*(\d+) failing/gm) ?? 0 }
    case 'bun':
      return { passed: sumOf(text, /^\s*(\d+) pass\s*$/gm), failed: sumOf(text, /^\s*(\d+) fail\s*$/gm) }
    case 'deno':
      return { passed: sumOf(text, /\| (\d+) passed/g), failed: sumOf(text, /\| \d+ passed \| (\d+) failed/g) }
    case 'phpunit': {
      const ok = /^OK \((\d+) tests?/m.exec(text)
      if (ok !== null) return { passed: Number(ok[1]), failed: 0 }
      const tests = Number(/^Tests: (\d+)/m.exec(text)?.[1] ?? NaN)
      const failed = (sumOf(text, /Failures: (\d+)/g) ?? 0) + (sumOf(text, /Errors: (\d+)/g) ?? 0)
      return Number.isNaN(tests) ? { passed: null, failed: null } : { passed: tests - failed, failed }
    }
  }
}

/**
 * What a test command's run said. `exitFailed` is the shell's verdict (a non-zero exit); counts win
 * over it when the output has them, and a run that failed with no summary at all is `error`
 * (the runner did not get to run the tests: a syntax error, a missing binary).
 */
export function summarizeRun(command: string, output: string, exitFailed: boolean): TestRunSummary {
  const runner = runnerOfOutput(output) ?? runnerOfCommand(command)
  const { passed, failed } = runner === undefined ? { passed: null, failed: null } : countsOf(runner, output)
  const hasCounts = passed !== null || failed !== null
  const outcome = failed !== null && failed > 0 ? 'failed' : exitFailed ? (hasCounts ? 'failed' : 'error') : 'passed'
  return { runner, outcome, passed, failed }
}

/** `✓ 12 passed`, `✗ 2 failed · 10 passed`, `✗ tests could not run`. */
export function describeRun(run: Pick<TestRunSummary, 'outcome' | 'passed' | 'failed'>): string {
  if (run.outcome === 'error') return '✗ tests could not run'
  if (run.outcome === 'passed') return run.passed === null ? '✓ tests passed' : `✓ ${run.passed} passed`
  if (run.failed === null || run.failed === 0) return '✗ tests failed'
  return run.passed === null || run.passed === 0 ? `✗ ${run.failed} failed` : `✗ ${run.failed} failed · ${run.passed} passed`
}

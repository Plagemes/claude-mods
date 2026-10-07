/** Whether one test passed or failed in one run. */
export type Outcome = 'pass' | 'fail'

/**
 * One result a test runner printed: a single test, or (`isGroup`) a whole
 * file or package when the runner reported no finer detail.
 */
export type TestResult = {
  name: string
  outcome: Outcome
  /** The file or package the test belongs to, when the output says. */
  group?: string
  isGroup?: true
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const MAX_LINE_CHARS = 500
const MAX_TITLE_CHARS = 200
const JEST_SEPARATOR = ' › '
const VITEST_SEPARATOR = ' > '
const SKIPPED_BULLETS = new Set(['Test suite failed to run'])

/**
 * A test runner as the command one shell segment runs, past env assignments and launchers (`npx`, `python -m`, `poetry run`...):
 * `cd web && npx vitest run` runs tests; `cat jest.config.js`, `npm i -D vitest` or `git commit -m "fix pytest"` only name a runner.
 */
const TEST_COMMAND = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*(?:` +
    [
      'vitest|jest|mocha|ava|pytest|py\\.test|phpunit|rspec|karma|tox|nox|ctest|playwright\\s+test',
      '(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test(?::\\S+)?',
      '(?:go|cargo|deno|bun|dotnet|mix|swift|zig)\\s+test',
      'cargo\\s+nextest',
      'node\\s+(?:\\S+\\s+)*--test',
      'python[\\d.]*\\s+-m\\s+(?:pytest|unittest)',
      '(?:mvnw?|gradlew?)\\b[^|;&]*\\btest',
      'make\\s+(?:test|check)',
    ].join('|') +
    ')(?![\\w./-])',
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

const PASS_GLYPHS = new Set(['✓', '✔', '√'])
const GLYPH_LINE = /^(\s*)([✓✔√✕✗×✖✘])\s+(.+?)\s*$/
const SUITE_GLYPH_LINE = /^(\s*)▶\s+(.+?)\s*$/
const DURATION_TAIL = /\s+(?:\(\d+(?:\.\d+)?\s*m?s\)|\d+(?:\.\d+)?\s*m?s)$/
const SKIPPED_TAIL = /\s+\[skipped\]$/
const JS_TEST_FILE = '\\S+\\.(?:test|spec)\\.[cm]?[jt]sx?'
const JEST_HEADER = /^\s*(PASS|FAIL)\s+(\S+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/
const VITEST_FILE = new RegExp(`^\\s*([✓✔√❯✗×✕↓])\\s+(${JS_TEST_FILE})\\s+\\((\\d+) tests?([^)]*)\\)`)
const VITEST_FAIL = new RegExp(`^\\s*FAIL\\s+(${JS_TEST_FILE})\\s+>\\s+(.+?)\\s*$`)
const JEST_BULLET = /^\s*●\s+(.+?)\s*$/
const MOCHA_FAIL = /^(\s*)\d+\)\s+(.+?)\s*$/
const MOCHA_FAILING = /^\s*\d+ failing\b/
const NODE_FAILING = /^\s*✖ failing tests:?\s*$/
const TAP = /^\s*(not )?ok \d+(?:\s+-)?\s+(.+?)\s*$/
const TAP_DIRECTIVE = /\s+#\s*(SKIP|TODO)\b/i
const PYTEST_VERBOSE = /^(\S+?\.py::\S.*?)\s+(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)\b/
const PYTEST_SUMMARY = /^(PASSED|FAILED|ERROR)\s+(\S+?\.py::\S+)/
const PYTEST_PROGRESS = /^(\S+\.py)\s+([.FEsxX]+)\s*(?:\[\s*\d+%\])?\s*$/
const GO_TEST = /^\s*--- (PASS|FAIL): (\S+)/
const GO_PACKAGE = /^(ok|FAIL)\s+(\S+)\s+(?:\d+(?:\.\d+)?s\b|\(cached\))/
const CARGO_TEST = /^test (\S+) \.\.\. (ok|FAILED)\b/
const INDENTED = /^(\s*)(\S.*?)\s*$/

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

export const isTestCommand = (command: string): boolean => command.split(SEGMENTS).some(segment => TEST_COMMAND.test(segment))

/** The command as messages show it: its first line, at most `max` characters. */
export const shortCommand = (command: string, max = 60): string => {
  const line = (command.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const pytestGroup = (id: string): string => id.slice(0, id.indexOf('::'))
const cleanTitle = (title: string): string => title.replace(SKIPPED_TAIL, '').replace(DURATION_TAIL, '').trim()

/** A suite header seen above the tests, by how far it is indented. */
type Suite = { indent: number; title: string }
/** The JS test file whose results follow, and how its runner joins a test's path. */
type FileContext = { name: string; separator: string }

/**
 * Reads the per-test results out of a test runner's output: Jest and Vitest
 * (default and verbose), Mocha, node:test (spec and TAP), PHPUnit testdox,
 * pytest (verbose, summary and progress), go test and cargo test.
 *
 * Names are stable across runs of the same runner: the file, the describe
 * blocks and the title, joined the way the runner joins them.
 */
export function parseResults(output: string): TestResult[] {
  const results: TestResult[] = []
  let file: FileContext | undefined
  let suites: Suite[] = []
  let isInDetails = false
  let goPending: TestResult[] = []

  const enterFile = (name: string, separator: string): void => {
    file = { name, separator }
    suites = []
    isInDetails = false
  }
  const pathOf = (indent: number, title: string): string => {
    suites = suites.filter(suite => suite.indent < indent)
    const separator = file?.separator ?? JEST_SEPARATOR
    return [...(file === undefined ? [] : [file.name]), ...suites.map(suite => suite.title), title].join(separator)
  }
  const push = (result: TestResult): void => {
    if (result.name !== '') results.push(result)
  }
  const pushTest = (name: string, outcome: Outcome): void =>
    push(file === undefined ? { name, outcome } : { name, outcome, group: file.name })

  for (const raw of stripAnsi(output).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length > MAX_LINE_CHARS || line.trim() === '') continue

    const go = GO_TEST.exec(line)
    if (go) {
      const test: TestResult = { name: go[2] ?? '', outcome: go[1] === 'PASS' ? 'pass' : 'fail' }
      goPending.push(test)
      push(test)
      continue
    }
    const pkg = GO_PACKAGE.exec(line)
    if (pkg) {
      const name = pkg[2] ?? ''
      for (const test of goPending) test.group = name
      goPending = []
      push({ name, outcome: pkg[1] === 'ok' ? 'pass' : 'fail', isGroup: true })
      continue
    }
    const cargo = CARGO_TEST.exec(line)
    if (cargo) {
      push({ name: cargo[1] ?? '', outcome: cargo[2] === 'ok' ? 'pass' : 'fail' })
      continue
    }
    const pyVerbose = PYTEST_VERBOSE.exec(line)
    if (pyVerbose) {
      const id = pyVerbose[1] ?? ''
      const verdict = pyVerbose[2] ?? ''
      if (verdict === 'PASSED' || verdict === 'FAILED' || verdict === 'ERROR') {
        push({ name: id, outcome: verdict === 'PASSED' ? 'pass' : 'fail', group: pytestGroup(id) })
      }
      continue
    }
    const pySummary = PYTEST_SUMMARY.exec(line)
    if (pySummary) {
      const id = pySummary[2] ?? ''
      push({ name: id, outcome: pySummary[1] === 'PASSED' ? 'pass' : 'fail', group: pytestGroup(id) })
      continue
    }
    const pyProgress = PYTEST_PROGRESS.exec(line)
    if (pyProgress) {
      push({ name: pyProgress[1] ?? '', outcome: /[FE]/.test(pyProgress[2] ?? '') ? 'fail' : 'pass', isGroup: true })
      continue
    }
    const tap = TAP.exec(line)
    if (tap) {
      const title = tap[2] ?? ''
      if (!TAP_DIRECTIVE.test(title)) push({ name: title, outcome: tap[1] === undefined ? 'pass' : 'fail' })
      continue
    }
    const vitestFail = VITEST_FAIL.exec(line)
    if (vitestFail) {
      const name = vitestFail[1] ?? ''
      push({ name: `${name}${VITEST_SEPARATOR}${vitestFail[2] ?? ''}`, outcome: 'fail', group: name })
      continue
    }
    const jestHeader = JEST_HEADER.exec(line)
    if (jestHeader) {
      const name = jestHeader[2] ?? ''
      enterFile(name, JEST_SEPARATOR)
      push({ name, outcome: jestHeader[1] === 'PASS' ? 'pass' : 'fail', isGroup: true })
      continue
    }
    const vitestFile = VITEST_FILE.exec(line)
    if (vitestFile) {
      const glyph = vitestFile[1] ?? ''
      const name = vitestFile[2] ?? ''
      enterFile(name, VITEST_SEPARATOR)
      if (glyph !== '↓') {
        const hasFailed = !PASS_GLYPHS.has(glyph) && /\bfailed\b/.test(vitestFile[4] ?? '')
        push({ name, outcome: hasFailed ? 'fail' : 'pass', isGroup: true })
      }
      continue
    }
    const bullet = JEST_BULLET.exec(line)
    if (bullet) {
      const title = bullet[1] ?? ''
      isInDetails = true
      if (!SKIPPED_BULLETS.has(title)) {
        pushTest(file === undefined ? title : `${file.name}${file.separator}${title}`, 'fail')
      }
      continue
    }
    if (MOCHA_FAILING.test(line) || NODE_FAILING.test(line)) {
      isInDetails = true
      continue
    }
    if (isInDetails) continue

    const glyph = GLYPH_LINE.exec(line)
    if (glyph) {
      const title = cleanTitle(glyph[3] ?? '')
      if (title !== '') pushTest(pathOf((glyph[1] ?? '').length, title), PASS_GLYPHS.has(glyph[2] ?? '') ? 'pass' : 'fail')
      continue
    }
    const mocha = MOCHA_FAIL.exec(line)
    if (mocha) {
      pushTest(pathOf((mocha[1] ?? '').length, cleanTitle(mocha[2] ?? '')), 'fail')
      continue
    }
    // Any other line closes the suites indented at least as far; an indented
    // one (or node:test's `▶ suite`) opens a suite for the tests below it.
    const suite = SUITE_GLYPH_LINE.exec(line) ?? INDENTED.exec(line)
    if (suite) {
      const indent = (suite[1] ?? '').length
      const title = cleanTitle(suite[2] ?? '')
      suites = suites.filter(one => one.indent < indent)
      const isHeader = indent > 0 || line.trimStart().startsWith('▶')
      if (isHeader && title.length <= MAX_TITLE_CHARS && !/^[>$]/.test(title)) suites.push({ indent, title })
    }
  }

  return results
}

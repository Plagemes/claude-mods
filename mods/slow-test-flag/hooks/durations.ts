export type Runner = 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'cargo' | 'nextest'

/** How long one test, or one file or package of tests, took. */
export type Timing = {
  name: string
  ms: number
  file?: string
  /** `test` for one test; `group` for a file, package or test binary, which holds many tests. */
  level: 'test' | 'group'
}

export type Slowest = { level: Timing['level']; items: Timing[] }

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const NUMBER = String.raw`(\d+(?:\.\d+)?)`

const PYTEST_DURATION = new RegExp(String.raw`^\s*${NUMBER}s\s+(call|setup|teardown)\s+(\S.*?)\s*$`)
/** Jest and mocha: `✓ renders the list (12 ms)`, `✔ works (123ms)`. */
const SPEC_TEST = new RegExp(String.raw`^\s*[✓✔√✕✗×]\s+(.+?)\s+\(${NUMBER}\s?ms\)\s*$`)
/** Jest's `PASS src/a.test.ts (5.1 s)`; the time is there only for slow files. */
const JEST_FILE = new RegExp(String.raw`^\s*(?:PASS|FAIL)\s+(?:\S+\s+)?(\S+)(?:\s+\(${NUMBER}\s?s\))?\s*$`)
/** Vitest's `✓ src/a.test.ts (3 tests) 152ms`, and in verbose `✓ src/a.test.ts > suite > test 12ms`. */
const VITEST_LINE = new RegExp(String.raw`^\s*[✓✔√✕✗×❯]\s+(?:\|[^|]+\|\s+)?(.+?)\s+${NUMBER}ms\s*$`)
const GO_PACKAGE = new RegExp(String.raw`^(?:ok|FAIL)\s+(\S+)\s+${NUMBER}s(?:\s|$)`)
const GO_TEST = new RegExp(String.raw`^\s*--- (?:PASS|FAIL|SKIP): (\S+) \(${NUMBER}s\)`)
/** Cargo's unstable `--report-time`: `test tests::parses ... ok <0.012s>`. */
const CARGO_TEST = new RegExp(String.raw`^test (\S+) \.\.\. (?:ok|FAILED|ignored)\S*\s+<${NUMBER}s>`)
const CARGO_BINARY = /^\s*(?:Running|Doc-tests)\s+(.+?)(?:\s+\(.*\))?\s*$/
const CARGO_RESULT = new RegExp(String.raw`^test result: .*finished in ${NUMBER}s`)
const NEXTEST_TEST = new RegExp(String.raw`^\s*(?:PASS|FAIL|SLOW|TIMEOUT|LEAK)\s+\[\s*${NUMBER}s\]\s+(.+?)\s*$`)
const TEST_COUNT = /\s*\(\d+ tests?[^)]*\)/
/** Timing lines are short; longer ones (dumped JSON, minified code) are skipped, which also keeps the lazy patterns linear. */
const MAX_LINE_CHARS = 1_000

/** What each runner prints once it has run tests, whatever its timings. */
const SIGNATURES: ReadonlyArray<readonly [Runner, RegExp]> = [
  ['pytest', /^=+ (?:test session starts|.*\b(?:passed|failed|error|no tests ran)\b.* in [\d.]+s)|^collected \d+ items?/m],
  ['vitest', /^\s*Test Files\s+\d+/m],
  ['jest', /^\s*Test Suites:\s+\d+/m],
  ['nextest', /^\s*Starting \d+ tests? across|^\s*Summary \[/m],
  ['cargo', /^test result: /m],
  ['go', /^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))|^--- (?:PASS|FAIL):/m],
  ['mocha', /^\s*\d+ passing\b/m],
]
/** A shell segment's start, past env assignments and launchers (`npx`, `python -m`, `poetry run`, `bundle exec`...) and a path. */
const LAUNCHED =
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
  String.raw`(?:[\w.~-]*\/)*`
/** The command a segment runs, not a word in it: `cat jest.config.js` or `npm i -D vitest` run no tests. */
const runs = (command: string): RegExp => new RegExp(`${LAUNCHED}(?:${command})(?![\\w./-])`)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/
const COMMANDS: ReadonlyArray<readonly [Runner, RegExp]> = [
  ['pytest', runs(String.raw`pytest|py\.test`)],
  ['vitest', runs('vitest')],
  ['jest', runs('jest')],
  ['mocha', runs('mocha')],
  ['nextest', runs(String.raw`cargo(?:\s+\+\S+)?\s+nextest`)],
  ['cargo', runs(String.raw`cargo(?:\s+\+\S+)?\s+test`)],
  ['go', runs(String.raw`go\s+test`)],
]
/** Commands that run a project's tests without naming the runner. */
const TEST_SCRIPT = runs(String.raw`(?:npm|yarn|pnpm|bun)(?:\s+run)?\s+test(?::[\w-]+)?|tox|nox|make\s+test`)
/** Whether one of the command's shell segments matches. */
const anySegment = (command: string, pattern: RegExp): boolean => command.split(SEGMENTS).some(segment => pattern.test(segment))

const toMs = (seconds: string | undefined): number => Math.round(Number.parseFloat(seconds ?? '0') * 1000)
const asMs = (millis: string | undefined): number => Math.round(Number.parseFloat(millis ?? '0'))
const looksLikeFile = (text: string): boolean => /^[\w./\\@~-]+\.[A-Za-z0-9]+$/.test(text)

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** Where the lines read so far are: the test file (Jest, Vitest, pytest) or test binary (cargo) whose tests come next. */
type Place = { file: string | undefined; binary: string | undefined }
type Rule = readonly [RegExp, (match: RegExpExecArray, place: Place) => Timing | undefined]

const testTime = (name: string, ms: number, file?: string): Timing => ({ name, ms, level: 'test', ...(file === undefined ? {} : { file }) })
const groupTime = (name: string, ms: number): Timing => ({ name, ms, level: 'group' })

// Each line is read by the first rule that fits; the order keeps `FAIL pkg 1.2s` (Go) from being read as a Jest file.
const RULES: readonly Rule[] = [
  [
    PYTEST_DURATION,
    ([, seconds, phase, id = '']) => testTime(phase === 'call' ? id : `${id} [${phase}]`, toMs(seconds), id.split('::')[0]),
  ],
  [SPEC_TEST, ([, name = '', millis], place) => testTime(name, asMs(millis), place.file)],
  [GO_TEST, ([, name = '', seconds]) => testTime(name, toMs(seconds))],
  [GO_PACKAGE, ([, name = '', seconds]) => groupTime(name, toMs(seconds))],
  [
    JEST_FILE,
    ([, name = '', seconds], place) => {
      place.file = name
      return seconds === undefined ? undefined : groupTime(name, toMs(seconds))
    },
  ],
  [
    VITEST_LINE,
    ([, label = '', millis], place) => {
      const [first = '', ...rest] = label.replace(TEST_COUNT, '').split(' > ')
      if (!looksLikeFile(first)) return testTime(label, asMs(millis), place.file)
      place.file = first
      return rest.length > 0 ? testTime(rest.join(' > '), asMs(millis), first) : groupTime(first, asMs(millis))
    },
  ],
  [CARGO_TEST, ([, name = '', seconds], place) => testTime(name, toMs(seconds), place.binary)],
  [NEXTEST_TEST, ([, seconds, name = '']) => testTime(name, toMs(seconds))],
  [
    CARGO_BINARY,
    ([, name], place) => {
      place.binary = name?.replace(/^unittests\s+/, '')
      return undefined
    },
  ],
  [CARGO_RESULT, ([, seconds], place) => groupTime(place.binary ?? 'tests', toMs(seconds))],
]

/** Every duration the runners' output states, in the order printed. Lines that are not one are skipped. */
export const parseTimings = (output: string): Timing[] => {
  const place: Place = { file: undefined, binary: undefined }
  const timings: Timing[] = []
  for (const line of stripAnsi(output).split('\n')) {
    if (line.length > MAX_LINE_CHARS) continue
    for (const [pattern, read] of RULES) {
      const match = pattern.exec(line)
      if (match === null) continue
      const timing = read(match, place)
      if (timing !== undefined && timing.ms > 0) timings.push(timing)
      break
    }
  }
  return timings
}

/** The slowest entries at the finest level the output gave: tests when there are any, else files or packages. */
export const slowest = (timings: readonly Timing[], count: number, thresholdMs: number): Slowest => {
  const level = timings.some(timing => timing.level === 'test') ? 'test' : 'group'
  const items = timings
    .filter(timing => timing.level === level && timing.ms >= thresholdMs)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(0, count))
  return { level, items }
}

/** Which runner printed this output, from the command and, failing that, from what the output looks like. */
export const runnerOf = (command: string, output: string): Runner | undefined => {
  const named = COMMANDS.find(([, pattern]) => anySegment(command, pattern))?.[0]
  return named ?? SIGNATURES.find(([, pattern]) => pattern.test(output))?.[0]
}

/** Whether the output shows a test run at all, whatever runner and whatever timings. */
export const hasRunTests = (output: string): boolean => SIGNATURES.some(([, pattern]) => pattern.test(output))

export const isTestCommand = (command: string): boolean =>
  COMMANDS.some(([, pattern]) => anySegment(command, pattern)) || anySegment(command, TEST_SCRIPT)

/** The one flag that makes a runner print per-test times, when its output had none. */
export const HINTS: Readonly<Record<Runner, string | undefined>> = {
  pytest: 'run pytest with --durations=10 to see the slowest tests',
  jest: 'run jest with --verbose to see how long each test took',
  vitest: 'run vitest with --reporter=verbose to see how long each test took',
  mocha: 'run mocha with --reporter spec to see slow tests',
  go: 'run go test with -v to see how long each test took',
  cargo: 'cargo test has no timings; try cargo nextest, or nightly with -- -Z unstable-options --report-time',
  nextest: undefined,
}

export const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

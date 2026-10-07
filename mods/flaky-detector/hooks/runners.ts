export type Runner = 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'rspec'

/** One test's outcome in one run. `scope` is its file (or Go package) when known. */
export type TestOutcome = { id: string; scope?: string; outcome: 'pass' | 'fail' }

/** What a test run's output says. */
export type RunReport = {
  runner: Runner
  tests: TestOutcome[]
  /** Files (Go packages) the output reports as passing whole, without naming each test. */
  passedScopes: string[]
  /** Files (Go packages) that failed before their tests ran (an import or build error): nothing in them passed. */
  failedScopes: string[]
  /** The run reached its summary, with no failure at all. */
  allPassed: boolean
  /** The run reached its summary line (it was not cut short). */
  isComplete: boolean
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const DURATION = /\s+(?:\(?\d+(?:\.\d+)?\s?m?s\)?)$/
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/

/** A shell segment's start, past env assignments and launchers (`npx`, `python -m`, `poetry run`, `bundle exec`...) and a path. */
const LAUNCHED =
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
  String.raw`(?:[\w.~-]*\/)*`
/** A runner as the command a segment runs: `cat jest.config.js`, `npm i -D vitest` or `git commit -m "fix pytest"` run none. */
const RUNNER = new RegExp(LAUNCHED + String.raw`(vitest|jest|py\.test|pytest|go\s+test|cargo\s+(?:test|nextest)|rspec)(?![\w./-])`)
/** A package script or make target named test. */
const TEST_SCRIPT = new RegExp(LAUNCHED + String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|(?:make|just)\s+test)(?![\w./-])`)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

const RUNNER_OF: Record<string, Runner> = { vitest: 'vitest', jest: 'jest', 'py.test': 'pytest', pytest: 'pytest', go: 'go', cargo: 'cargo', rspec: 'rspec' }

/** The runner a command invokes directly, if it is one; `npm test` and friends are told apart by their output. */
export const runnerOfCommand = (command: string): Runner | undefined => {
  for (const segment of command.split(SEGMENTS)) {
    const found = RUNNER.exec(segment)?.[1]
    if (found !== undefined) return RUNNER_OF[found.split(/\s/)[0] ?? '']
  }
  return undefined
}

/** Whether a shell command runs tests at all (a runner, or a package script named test), rather than only naming one. */
export const isTestCommand = (command: string): boolean =>
  runnerOfCommand(command) !== undefined || command.split(SEGMENTS).some(segment => TEST_SCRIPT.test(segment))

/** The runner whose summary the output carries. */
export const runnerOfOutput = (output: string): Runner | undefined => {
  if (/^\s*Test Files\s+\d+/m.test(output)) return 'vitest'
  if (/^Tests:\s+\d+/m.test(output) && /^Test Suites:/m.test(output)) return 'jest'
  if (/^=+ .*\b(?:passed|failed|errors?|skipped|no tests ran)\b.* in [\d.]+s/m.test(output) || /short test summary info/.test(output)) {
    return 'pytest'
  }
  if (/^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/m.test(output) || /^\s*--- (?:FAIL|PASS):/m.test(output)) return 'go'
  if (/^test result: (?:ok|FAILED)\./m.test(output)) return 'cargo'
  if (/^\d+ examples?, \d+ failures?/m.test(output)) return 'rspec'
  return undefined
}

const report = (runner: Runner, tests: TestOutcome[], passedScopes: string[], isComplete: boolean, failedScopes: string[] = []): RunReport => {
  const byId = new Map<string, TestOutcome>()
  for (const test of tests) {
    const known = byId.get(test.id)
    if (known === undefined || test.outcome === 'fail') byId.set(test.id, test)
  }
  const outcomes = [...byId.values()]
  return {
    runner,
    tests: outcomes,
    passedScopes: [...new Set(passedScopes)],
    failedScopes: [...new Set(failedScopes)],
    allPassed: isComplete && failedScopes.length === 0 && !outcomes.some(test => test.outcome === 'fail'),
    isComplete,
  }
}

/** vitest, default and verbose reporters: `✓`/`×` lines, `FAIL  file > test` headers, `✓ file (n tests)` for a passing file. */
const parseVitest = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  const passed: string[] = []
  const broken: string[] = []
  let file: string | undefined
  for (const line of lines) {
    const suite = /^\s*FAIL\s+(\S+) \[ /.exec(line)
    if (suite !== null) {
      broken.push(suite[1] as string)
      continue
    }
    const header = /^\s*([❯✓×])\s+(\S+)\s+\(\d+ tests?(?:\s*\|[^)]*)?\)/.exec(line)
    if (header !== null) {
      file = header[2] as string
      if (header[1] === '✓') passed.push(file)
      continue
    }
    const failed = /^\s*FAIL\s+(\S+) > (.+)$/.exec(line)
    if (failed !== null) {
      tests.push({ id: `${failed[1]} > ${(failed[2] as string).trim()}`, scope: failed[1], outcome: 'fail' })
      continue
    }
    const row = /^\s*([✓×])\s+(.+)$/.exec(line)
    if (row === null) continue
    const name = (row[2] as string).replace(DURATION, '').trim()
    const outcome = row[1] === '✓' ? 'pass' : 'fail'
    const [first = '', ...rest] = name.split(' > ')
    if (SCRIPT_FILE.test(first) && rest.length > 0) tests.push({ id: name, scope: first, outcome })
    else if (file !== undefined) tests.push({ id: `${file} > ${name}`, scope: file, outcome })
  }
  return report('vitest', tests, passed, lines.some(line => /^\s*Tests\s+\d+/.test(line)), broken)
}

/** jest: `PASS`/`FAIL file` headers, `● suite › test` failures, and the indented ✓/✕ tree of --verbose. */
const parseJest = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  const passed: string[] = []
  const broken: string[] = []
  let file: string | undefined
  let describes: { indent: number; name: string }[] = []
  for (const line of lines) {
    const header = /^(PASS|FAIL)\s+(\S+)/.exec(line)
    if (header !== null) {
      file = header[2] as string
      describes = []
      if (header[1] === 'PASS') passed.push(file)
      continue
    }
    if (file === undefined) continue
    const failure = /^\s+● (.+)$/.exec(line)
    if (failure !== null) {
      const path = (failure[1] as string).trim()
      if (path === 'Test suite failed to run') broken.push(file)
      else tests.push({ id: `${file} > ${path.split(' › ').join(' > ')}`, scope: file, outcome: 'fail' })
      continue
    }
    const indent = line.length - line.trimStart().length
    const mark = /^\s+([✓✕√×○])\s+(.+)$/.exec(line)
    if (mark !== null) {
      if (mark[1] === '○') continue
      const name = (mark[2] as string).replace(DURATION, '').trim()
      const path = [...describes.filter(entry => entry.indent < indent).map(entry => entry.name), name]
      tests.push({ id: `${file} > ${path.join(' > ')}`, scope: file, outcome: mark[1] === '✓' || mark[1] === '√' ? 'pass' : 'fail' })
    } else if (indent >= 2 && line.trim() !== '' && !/^\s+(?:at |>|\d+ \||expect|Expected|Received)/.test(line)) {
      describes = [...describes.filter(entry => entry.indent < indent), { indent, name: line.trim() }]
    }
  }
  return report('jest', tests, passed, lines.some(line => /^Tests:\s+\d+/.test(line)), broken)
}

/** pytest: `FAILED`/`ERROR path::test` summary lines, `path::test PASSED` with -v, and `file ....` progress lines with no failure. */
const parsePytest = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  const passed: string[] = []
  const broken: string[] = []
  for (const line of lines) {
    const collection = /^ERROR (\S+\.py)(?: - |$)/.exec(line)
    if (collection !== null) {
      broken.push(collection[1] as string)
      continue
    }
    const summary = /^(FAILED|ERROR) (\S+?::\S+?)(?: - |$)/.exec(line)
    if (summary !== null) {
      const id = summary[2] as string
      tests.push({ id, scope: id.split('::')[0], outcome: 'fail' })
      continue
    }
    const verbose = /^(\S+?::\S+) (PASSED|FAILED|ERROR)\b/.exec(line)
    if (verbose !== null) {
      const id = verbose[1] as string
      tests.push({ id, scope: id.split('::')[0], outcome: verbose[2] === 'PASSED' ? 'pass' : 'fail' })
      continue
    }
    const progress = /^(\S+\.py) ([.sxXFE]+)\s+\[\s*\d+%\]$/.exec(line)
    if (progress !== null && !/[FE]/.test(progress[2] as string)) passed.push(progress[1] as string)
  }
  return report('pytest', tests, passed, lines.some(line => /^=+ .* in [\d.]+s/.test(line)), broken)
}

/** go test: `--- PASS/FAIL: TestName` lines, each tied to the `ok`/`FAIL <package>` line after it. */
const parseGo = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  const passed: string[] = []
  const broken: string[] = []
  let pending: { name: string; outcome: 'pass' | 'fail' }[] = []
  let isComplete = false
  for (const line of lines) {
    const failedBuild = /^FAIL\s+(\S+)\s+\[(?:build|setup) failed\]/.exec(line)
    if (failedBuild !== null) {
      broken.push(failedBuild[1] as string)
      isComplete = true
      continue
    }
    const result = /^\s*--- (PASS|FAIL): (\S+)/.exec(line)
    if (result !== null) {
      pending.push({ name: result[2] as string, outcome: result[1] === 'PASS' ? 'pass' : 'fail' })
      continue
    }
    const pkg = /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\))/.exec(line)
    if (pkg !== null) {
      const path = pkg[2] as string
      isComplete = true
      if (pkg[1] === 'ok') passed.push(path)
      tests.push(...pending.map(test => ({ id: `${path}.${test.name}`, scope: path, outcome: test.outcome })))
      pending = []
    }
  }
  return report('go', tests, passed, isComplete, broken)
}

/** cargo test: `test path ... ok|FAILED` under each `Running <target>` header. */
const parseCargo = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  let target = ''
  for (const line of lines) {
    const header = /^\s+Running (?:unittests )?(\S+)/.exec(line) ?? /^\s+Doc-tests (\S+)/.exec(line)
    if (header !== null) {
      target = line.includes('Doc-tests') ? `doc:${header[1]}` : (header[1] as string)
      continue
    }
    const result = /^test (\S.*?) \.\.\. (ok|FAILED)$/.exec(line)
    if (result !== null) tests.push({ id: `${target} ${result[1]}`.trim(), scope: target, outcome: result[2] === 'ok' ? 'pass' : 'fail' })
  }
  return report('cargo', tests, [], lines.some(line => /^test result: /.test(line)))
}

/** rspec: the `rspec ./spec/file_spec.rb:12 # description` lines under "Failed examples". */
const parseRspec = (lines: readonly string[]): RunReport => {
  const tests: TestOutcome[] = []
  for (const line of lines) {
    const failed = /^rspec \.\/(\S+?):\d+ # (.+)$/.exec(line)
    if (failed !== null) tests.push({ id: `${failed[1]} > ${(failed[2] as string).trim()}`, scope: failed[1], outcome: 'fail' })
  }
  return report('rspec', tests, [], lines.some(line => /^\d+ examples?, \d+ failures?/.test(line)))
}

const PARSERS: Record<Runner, (lines: readonly string[]) => RunReport> = {
  vitest: parseVitest,
  jest: parseJest,
  pytest: parsePytest,
  go: parseGo,
  cargo: parseCargo,
  rspec: parseRspec,
}

/** What a test command's output says, from the command's runner or the output's own summary; undefined for neither. */
export const parseRun = (command: string, output: string): RunReport | undefined => {
  const text = output.replace(ANSI, '')
  const runner = runnerOfOutput(text) ?? runnerOfCommand(command)
  return runner === undefined ? undefined : PARSERS[runner](text.split(/\r?\n/))
}

/** A command reduced to what decides which tests it runs: env assignments, reporters and colour flags dropped, spaces collapsed. */
export const normalizeCommand = (command: string): string =>
  command
    .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    .replace(/\s+(?:--reporter[= ]\S+|--verbose|-v{1,3}|--color(?:=\S+)?|--no-color|-q|--quiet)(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()

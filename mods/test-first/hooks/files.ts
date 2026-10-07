/** Test files by name or folder, across the common ecosystems. */
const TEST_FILE = new RegExp(
  [
    '(^|/)(__tests__|tests?|spec|specs)/', // a test folder
    '[._-](test|spec)\\.[cm]?[jt]sx?$', // app.test.ts, app.spec.js
    '(^|/)test_[^/]+\\.py$|_test\\.(py|go)$', // test_app.py, app_test.go
    '_spec\\.rb$', // app_spec.rb
    '(Test|Tests|Spec)\\.(java|kt|scala|cs|php|swift)$', // AppTest.java, AppTests.cs
    '\\.(test|spec)\\.(rs|ex|exs)$', // app.test.rs
  ].join('|'),
)

/** Extensions of code whose behaviour tests pin down; config, docs and data stay open. */
const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte',
  'py', 'go', 'rs', 'java', 'kt', 'scala', 'rb', 'php', 'cs', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'ex', 'exs', 'dart', 'lua', 'zig',
])

/**
 * A test runner at the start of one part of a command line, after variables and `npx`, `poetry run`, `bundle exec` and the like:
 * `cd web && npx vitest run` runs tests, `cat jest.config.js` and `npm install -D vitest` only name a runner.
 */
const TEST_COMMAND = new RegExp(
  '^(?:\\w+=\\S*\\s+)*(?:(?:sudo|time|npx|bunx|pnpx|exec|(?:bundle|pnpm|yarn|npm) exec|(?:poetry|uv|pipenv|pdm|hatch) run)\\s+)*(?:\\S*/)?(?:' +
    [
      'vitest|jest|mocha|ava|pytest|py\\.test|phpunit|rspec|karma|playwright\\s+test',
      '(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test',
      '(?:go|cargo|deno|bun|dotnet|mix|swift|zig)\\s+test',
      'cargo\\s+nextest',
      'python[\\d.]*\\s+-m\\s+(?:pytest|unittest)',
      '(?:mvnw?|gradlew?)\\b[^|;&]*\\btest',
      'make\\s+(?:test|check)',
    ].join('|') +
    ')(?=[\\s:]|$)',
)
const COMMAND_PARTS = /&&|\|\||[;|&\n()]/

/** Output that says tests failed even though the command exited 0 (a pipe, `|| true`). */
const FAILED_OUTPUT = /\b[1-9]\d* (failed|failing|failures?)\b|^(FAIL|FAILED)\b|^--- FAIL:/m

export const isTestFile = (path: string): boolean => TEST_FILE.test(path.replace(/\\/g, '/'))

export const isProductionCode = (path: string): boolean => {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 && CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) && !isTestFile(path)
}

export const isTestCommand = (command: string): boolean => command.split(COMMAND_PARTS).some(part => TEST_COMMAND.test(part.trim()))

export const looksFailed = (output: string): boolean => FAILED_OUTPUT.test(output)

/** The command as the band shows it: its first line, at most `max` characters. */
export const shortCommand = (command: string, max = 40): string => {
  const line = (command.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

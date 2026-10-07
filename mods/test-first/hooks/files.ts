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

/** A shell command that runs a test suite. */
const TEST_COMMAND = new RegExp(
  [
    '\\b(vitest|jest|mocha|ava|pytest|py\\.test|phpunit|rspec|karma|playwright test)\\b',
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b',
    '\\b(go|cargo|deno|bun|dotnet|mix|swift|zig)\\s+test\\b',
    '\\bcargo\\s+nextest\\b',
    '\\bpython3?\\s+-m\\s+(pytest|unittest)\\b',
    '\\b(mvn|mvnw|gradle|gradlew)\\b[^|;&]*\\btest\\b',
    '\\bmake\\s+(test|check)\\b',
  ].join('|'),
)

/** Output that says tests failed even though the command exited 0 (a pipe, `|| true`). */
const FAILED_OUTPUT = /\b[1-9]\d* (failed|failing|failures?)\b|^(FAIL|FAILED)\b|^--- FAIL:/m

export const isTestFile = (path: string): boolean => TEST_FILE.test(path.replace(/\\/g, '/'))

export const isProductionCode = (path: string): boolean => {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 && CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) && !isTestFile(path)
}

export const isTestCommand = (command: string): boolean => TEST_COMMAND.test(command)

export const looksFailed = (output: string): boolean => FAILED_OUTPUT.test(output)

/** The command as the band shows it: its first line, at most `max` characters. */
export const shortCommand = (command: string, max = 40): string => {
  const line = (command.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

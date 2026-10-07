import type { TestWatchPlan, TestWatchRun } from '../types'
import { basename, dirname, extension, join, relativeTo } from './project'

export type Runner = TestWatchPlan['runner']

/** Where to look for a source file's tests: a directory and the file names that would be them. */
export type Lookup = { dir: string; names: readonly string[] }

type Counts = { passed: number | null; failed: number | null }

export const SCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'])
export const PYTHON_EXTENSIONS = new Set(['py'])

const TEST_FILE = /(^|\/)__tests__\/|[._](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/
const MIRROR_ROOTS = ['test', 'tests', '__tests__']
const SOURCE_ROOTS = /^(src|lib|app)(\/|$)/
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

export const isTestFile = (path: string): boolean => TEST_FILE.test(path)

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

export const stemOf = (file: string): string => {
  const base = basename(file)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/** The test-folder mirrors of a source directory: `src/a/b` → `tests/a/b`, `test/a/b`, ... */
const mirrorsOf = (root: string, dir: string): string[] => {
  const inside = relativeTo(root, dir)
  const stripped = inside.replace(SOURCE_ROOTS, '')
  return MIRROR_ROOTS.flatMap(top => [...new Set([join(root, top, stripped), join(root, top, inside)])])
}

/**
 * Where the tests of a JS/TS source file would be: beside it as
 * `name.test.ts` / `name.spec.ts`, in `__tests__/`, or mirrored under
 * `test/`, `tests/` or `__tests__/` at the project root.
 */
export const scriptTestLookups = (file: string, root: string): Lookup[] => {
  const stem = stemOf(file)
  const extensions = [...new Set([extension(file), 'ts', 'tsx', 'js', 'jsx'])]
  const names = ['test', 'spec'].flatMap(kind => extensions.map(ext => `${stem}.${kind}.${ext}`))
  const dir = dirname(file)
  return [
    { dir, names },
    { dir: join(dir, '__tests__'), names: [...names, ...extensions.map(ext => `${stem}.${ext}`)] },
    ...mirrorsOf(root, dir).map(mirror => ({ dir: mirror, names })),
  ]
}

/** Where the tests of a Python module would be: `test_name.py` or `name_test.py`, beside it or under `tests/`. */
export const pythonTestLookups = (file: string, root: string): Lookup[] => {
  const stem = stemOf(file)
  const names = [`test_${stem}.py`, `${stem}_test.py`]
  const dir = dirname(file)
  return [{ dir, names }, { dir: join(dir, 'tests'), names }, ...mirrorsOf(root, dir).map(mirror => ({ dir: mirror, names }))]
}

/** The argv that runs `tests` (relative to `cwd`) with `runner`, its executable already resolved. */
export const commandFor = (runner: Runner, executable: string, tests: readonly string[]): string[] => {
  switch (runner) {
    case 'vitest':
      return [executable, 'run', ...tests]
    case 'jest':
      return [executable, '--ci', '--runTestsByPath', ...tests]
    case 'pytest':
      return [executable, '-q', ...tests]
    case 'go':
      return [executable, 'test', '-v', ...tests]
    case 'cargo':
      return [executable, 'test', ...tests]
  }
}

const sumOf = (text: string, pattern: RegExp): number | null => {
  const found = [...text.matchAll(pattern)]
  return found.length === 0 ? null : found.reduce((sum, match) => sum + Number(match[1]), 0)
}

const countIn = (line: string | undefined): Counts => ({
  passed: line === undefined ? null : sumOf(line, /(\d+) passed/g),
  failed: line === undefined ? null : sumOf(line, /(\d+) (?:failed|errors?)\b/g),
})

/** The passed and failed counts a runner's summary reports; null where it says none. */
export const summarize = (runner: Runner, output: string): Counts => {
  const lines = output.split('\n')
  switch (runner) {
    case 'vitest':
      return countIn(lines.findLast(line => /^\s*Tests\s+\d/.test(line)))
    case 'jest':
      return countIn(lines.findLast(line => /^\s*Tests:\s+\d/.test(line)))
    case 'pytest':
      return countIn(lines.findLast(line => /\d+ (passed|failed|errors?)\b/.test(line)))
    case 'go': {
      const passed = (output.match(/^\s*--- PASS:/gm) ?? []).length
      const failed = (output.match(/^\s*--- FAIL:/gm) ?? []).length
      return passed + failed === 0 ? { passed: null, failed: null } : { passed, failed }
    }
    case 'cargo':
      return {
        passed: sumOf(output, /test result: \w+\. (\d+) passed/g),
        failed: sumOf(output, /test result: \w+\. \d+ passed; (\d+) failed/g),
      }
  }
}

/** The status line for a finished run: `✓ 12 passed`, `✗ 2 failed · 10 passed`, or why it could not run. */
export const statusOf = (run: TestWatchRun): string => {
  if (run.outcome === 'error') return `✗ tests: ${run.reason ?? 'could not run'}`
  if (run.outcome === 'passed') return run.passed === null ? '✓ tests passed' : `✓ ${run.passed} passed`
  if (run.failed === null || run.failed === 0) return '✗ tests failed'
  return run.passed === null || run.passed === 0 ? `✗ ${run.failed} failed` : `✗ ${run.failed} failed · ${run.passed} passed`
}

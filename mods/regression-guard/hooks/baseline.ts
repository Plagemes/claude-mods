import type { GuardOutcome, GuardRegression } from '../types'
import type { TestResult } from './parse'

/** The most test names the baseline keeps; past it, new names are compared but not added. */
export const MAX_BASELINE = 20_000

/** One test run folded into the session's baseline. */
export type Applied = {
  baseline: Record<string, GuardOutcome>
  regressions: GuardRegression[]
  /** Regressions this run found that were not known before it. */
  added: GuardRegression[]
  /** Names of regressions this run saw pass again. */
  fixed: string[]
  passed: number
  failed: number
}

/** One result per name; a test the output reports both ways (a retry, a summary) counts as failed. */
export function dedupe(results: readonly TestResult[]): TestResult[] {
  const byName = new Map<string, TestResult>()
  for (const result of results) {
    const known = byName.get(result.name)
    if (known === undefined || (known.outcome === 'pass' && result.outcome === 'fail')) {
      byName.set(result.name, { ...result, group: result.group ?? known?.group })
    }
  }
  return [...byName.values()]
}

/** A test file Claude edited: its unknown failing tests may be new ones, not regressions. */
const TEST_FILE = new RegExp(
  [
    '(^|/)(__tests__|tests?|spec|specs)/',
    '[._-](test|spec)\\.[cm]?[jt]sx?$',
    '(^|/)test_[^/]+\\.py$|_test\\.(py|go)$',
    '_spec\\.rb$',
    '(Test|Tests|Spec)\\.(java|kt|scala|cs|php|swift)$',
  ].join('|'),
)

export const isTestFile = (path: string): boolean => TEST_FILE.test(path.replace(/\\/g, '/'))

/**
 * Whether a file or package was touched by an edit of one of `edited` (test
 * files, absolute): a file group by its path's tail (`src/a.test.ts`), a Go
 * package by its last path segment against an edited `_test.go` file's folder.
 */
export function touchedBy(edited: readonly string[]): (group: string) => boolean {
  const paths = edited.map(file => file.replace(/\\/g, '/'))
  return group => {
    const lastSegment = group.split('/').pop() ?? group
    return paths.some(path => {
      if (path === group || path.endsWith(`/${group}`)) return true
      const dir = path.slice(0, path.lastIndexOf('/'))
      return path.endsWith('_test.go') && (dir === lastSegment || dir.endsWith(`/${lastSegment}`))
    })
  }
}

/**
 * Folds one run into the baseline: a test seen for the first time this
 * session enters it with its outcome; a test the baseline holds as passing
 * that now fails is a regression; a regression that passes again is fixed.
 *
 * Runners that list only failures (Jest, Vitest, go test without -v) put
 * whole files or packages in the baseline. A test seen for the first time,
 * failing, in a file that passed in full is a regression too, unless Claude
 * edited that test file this session (`isTouched`): then it may be a new
 * test (test-first work). A failing file counts by itself only when the run
 * named none of its tests: with test-level detail the tests decide.
 */
export function applyRun(
  baseline: Readonly<Record<string, GuardOutcome>>,
  regressions: readonly GuardRegression[],
  results: readonly TestResult[],
  at: number,
  command: string,
  isTouched: (group: string) => boolean = () => false,
): Applied {
  const next: Record<string, GuardOutcome> = { ...baseline }
  let size = Object.keys(next).length
  const current = new Map(regressions.map(regression => [regression.name, regression]))
  const added: GuardRegression[] = []
  const fixed: string[] = []
  const runResults = dedupe(results)
  const detailed = new Set(
    runResults.flatMap(result => (result.isGroup !== true && result.outcome === 'fail' && result.group !== undefined ? [result.group] : [])),
  )
  const fix = (name: string): void => {
    if (current.delete(name)) fixed.push(name)
  }
  const brokeInPassingGroup = (result: TestResult): boolean =>
    result.isGroup !== true && result.group !== undefined && baseline[result.group] === 'pass' && !isTouched(result.group)

  for (const result of runResults) {
    const known = baseline[result.name]
    const isRegression =
      result.outcome === 'fail' &&
      (known === 'pass'
        ? !(result.isGroup === true && detailed.has(result.name))
        : known === undefined && brokeInPassingGroup(result))
    if (known === undefined && size < MAX_BASELINE) {
      next[result.name] = isRegression ? 'pass' : result.outcome
      size += 1
    }
    if (isRegression && !current.has(result.name)) {
      const regression: GuardRegression = {
        name: result.name,
        ...(result.group === undefined ? {} : { group: result.group }),
        since: at,
        command,
      }
      current.set(result.name, regression)
      added.push(regression)
    }
    if (result.outcome === 'pass') {
      fix(result.name)
      if (result.isGroup === true) {
        for (const regression of [...current.values()]) {
          if (regression.group === result.name) fix(regression.name)
        }
      }
    }
  }

  const tests = runResults.some(result => result.isGroup !== true)
    ? runResults.filter(result => result.isGroup !== true)
    : runResults

  return {
    baseline: next,
    regressions: [...current.values()],
    added,
    fixed,
    passed: tests.filter(result => result.outcome === 'pass').length,
    failed: tests.filter(result => result.outcome === 'fail').length,
  }
}

export const plural = (count: number, word: string, many = `${word}s`): string => `${count} ${count === 1 ? word : many}`

/** How long ago `ms` was, in words. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

/** The prompt the band's button sends: the regressions, and how to see them fail. */
export function fixPrompt(regressions: readonly GuardRegression[]): string {
  const commands = [...new Set(regressions.map(regression => regression.command))]
  return [
    `These tests passed earlier in this session and now fail (${plural(regressions.length, 'regression')}):`,
    ...regressions.map(regression => `- ${regression.name}`),
    '',
    `Re-run ${commands.map(command => `\`${command}\``).join(' or ')} to see the failures, find which of this session's changes broke them, and fix the code so they pass again. Do not weaken or delete the tests; if a change in behaviour was intended, tell me instead.`,
  ].join('\n')
}

/** The note the model reads after a test run that broke tests which passed before. */
export function modelNote(added: readonly GuardRegression[], total: number): string {
  const names = added.slice(0, 10).map(regression => regression.name).join('; ')
  const more = added.length > 10 ? `; and ${added.length - 10} more` : ''
  return `regression-guard: ${plural(added.length, 'test')} that passed earlier in this session now ${added.length === 1 ? 'fails' : 'fail'}: ${names}${more}. ${total > added.length ? `${total} regressions are open in all. ` : ''}Fix the cause before moving on, or tell the user if the change in behaviour is intended.`
}

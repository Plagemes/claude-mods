import type { FlakyRecord, FlakyRun } from '../types'
import { normalizeCommand } from './runners'
import type { RunReport, Runner } from './runners'

export type { FlakyRecord, FlakyRun }

/** One project's test history, as kept in the store. */
export type History = { records: Record<string, FlakyRecord>; recent: FlakyRun[] }

/** A test run as the history takes it: the parsed report, the command, the code fingerprint, the time. */
export type RunInput = { report: RunReport; command: string; fingerprint: string; at: number }

export type Applied = {
  history: History
  /** Tests marked flaky by this run. */
  newlyFlaky: FlakyRecord[]
  /** Known flaky tests that failed in this run. */
  flakyFailures: FlakyRecord[]
}

const MAX_OUTCOMES = 20
const MAX_RECORDS = 400
const MAX_RECENT = 6
const MAX_RECENT_PASSES = 3_000

export const emptyHistory = (): History => ({ records: {}, recent: [] })

/** Whether an earlier run, or this one, shows `id` passing: by name, by its whole file passing, or by the whole run passing. */
const passedIn = (run: FlakyRun, id: string, scope: string | undefined, runner: Runner): boolean =>
  run.runner === runner && (run.passed.includes(id) || (scope !== undefined && run.passedScopes.includes(scope)))

/**
 * Folds one run into the history. Only tests that have failed are tracked;
 * a pass counts for them when the run names them, passes their whole file
 * (or package), or is the same command that failed them and ended with
 * every test passing or with them not among the failures. A change of
 * outcome under the same code fingerprint is a flip, and a test that flips
 * is flaky.
 */
export const applyRun = (previous: History, input: RunInput): Applied => {
  const { report, fingerprint, at } = input
  const command = normalizeCommand(input.command)
  const records: Record<string, FlakyRecord> = { ...previous.records }
  const failures = new Map(report.tests.filter(test => test.outcome === 'fail').map(test => [test.id, test]))
  const explicitPasses = new Set(report.tests.filter(test => test.outcome === 'pass').map(test => test.id))
  const newlyFlaky: FlakyRecord[] = []

  const record = (id: string, scope: string | undefined, outcome: 'pass' | 'fail'): void => {
    const known = records[id]
    const outcomes = known?.outcomes ?? []
    const last = outcomes.at(-1)
    let flips = known?.flips ?? 0
    let lastFlipAt = known?.lastFlipAt ?? null
    const isNew = known === undefined
    // A first failure flips from a pass an earlier run showed under the same code.
    const before = last ?? (outcome === 'fail' ? previous.recent.find(run => run.fingerprint === fingerprint && passedIn(run, id, scope, report.runner)) : undefined)
    const beforeOutcome = last?.outcome ?? (before === undefined ? undefined : 'pass')
    if (before !== undefined && beforeOutcome !== outcome && before.fingerprint === fingerprint && fingerprint !== '') {
      flips += 1
      lastFlipAt = at
    }
    const next: FlakyRecord = {
      id,
      runner: report.runner,
      scope: scope ?? known?.scope ?? null,
      outcomes: [...outcomes, { at, outcome, fingerprint, command }].slice(-MAX_OUTCOMES),
      flips,
      lastFlipAt,
      lastFailAt: outcome === 'fail' ? at : (known?.lastFailAt ?? at),
    }
    records[id] = next
    if (flips > 0 && (isNew || known.flips === 0)) newlyFlaky.push(next)
  }

  for (const failure of failures.values()) record(failure.id, failure.scope, 'fail')
  for (const known of Object.values(previous.records)) {
    if (known.runner !== report.runner || failures.has(known.id)) continue
    const lastCommand = known.outcomes.at(-1)?.command
    if (known.scope !== null && report.failedScopes.includes(known.scope)) continue
    const isPassed =
      explicitPasses.has(known.id) ||
      (known.scope !== null && report.passedScopes.includes(known.scope)) ||
      (report.isComplete && lastCommand === command)
    if (isPassed) record(known.id, known.scope ?? undefined, 'pass')
  }

  const run: FlakyRun = {
    runner: report.runner,
    command,
    fingerprint,
    at,
    passed: [...explicitPasses].slice(0, MAX_RECENT_PASSES),
    passedScopes: report.passedScopes,
  }
  const kept = Object.values(records)
    .sort((a, b) => Number(b.flips > 0) - Number(a.flips > 0) || (b.outcomes.at(-1)?.at ?? 0) - (a.outcomes.at(-1)?.at ?? 0))
    .slice(0, MAX_RECORDS)
  return {
    history: { records: Object.fromEntries(kept.map(one => [one.id, one])), recent: [run, ...previous.recent].slice(0, MAX_RECENT) },
    newlyFlaky,
    flakyFailures: [...failures.keys()].map(id => records[id]).filter((one): one is FlakyRecord => one !== undefined && one.flips > 0 && !newlyFlaky.includes(one)),
  }
}

/** A history read back from the store, or an empty one when it is missing or not this shape. */
export const asHistory = (value: unknown): History => {
  if (typeof value !== 'object' || value === null) return emptyHistory()
  const candidate = value as Partial<History>
  return typeof candidate.records === 'object' && candidate.records !== null && Array.isArray(candidate.recent)
    ? { records: candidate.records, recent: candidate.recent }
    : emptyHistory()
}

/** Tests to show: flaky ones by flips, then the ones failing now that have not flipped (fixed ones stay tracked, unshown). */
export const suspectsOf = (history: History): { flaky: FlakyRecord[]; watching: FlakyRecord[] } => {
  const all = Object.values(history.records)
  return {
    flaky: all.filter(one => one.flips > 0).sort((a, b) => b.flips - a.flips || (b.lastFlipAt ?? 0) - (a.lastFlipAt ?? 0)),
    watching: all
      .filter(one => one.flips === 0 && one.outcomes.at(-1)?.outcome === 'fail')
      .sort((a, b) => b.lastFailAt - a.lastFailAt),
  }
}

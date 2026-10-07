import { expect, test } from 'claude-code/testing'

import type { AutopilotCriterion, AutopilotRun } from '../types'
import {
  HARD_MAX_TURNS,
  afterChecks,
  afterTurn,
  checkOf,
  customCriterion,
  draftProblem,
  interactionWords,
  isNeverAsk,
  limitReason,
  newDraft,
  newRun,
  nextSubmission,
  parseArgs,
  parseMarkers,
  parsePlan,
  restored,
  settingsOf,
  submitted,
  suggestCriteria,
} from '../hooks/pilot'

const NOW = new Date(2026, 9, 7, 12, 0).getTime()
const SETTINGS = settingsOf({})

const criterion = (kind: AutopilotCriterion['kind'], command: string): AutopilotCriterion => ({ id: kind, kind, label: kind, command, isOn: true })

function runOf(neverAsk = false): AutopilotRun {
  const draft = newDraft('Make the cart total include tax', [criterion('tests', 'npm test')], SETTINGS, neverAsk ? 'off' : null)
  return newRun(draft, { id: 'run-1234abcd', now: NOW, project: '/work/shop', settings: SETTINGS })
}

/** Sends what the run asks for next and ends that turn with `answer`. */
function turn(run: AutopilotRun, answer: string, reason: 'answer' | 'error' | 'aborted' | 'refusal' = 'answer') {
  const submission = nextSubmission(run)
  if (submission === undefined) throw new Error(`nothing to submit (status ${run.status}, phase ${run.phase})`)
  return { submission, ...afterTurn(submitted(run, submission, NOW), { reason, answer }, NOW + 1) }
}

const checked = (run: AutopilotRun, ok: boolean): AutopilotRun =>
  afterChecks(run, run.criteria.map(one => ({ ...one, last: checkOf(one, { exitCode: ok ? 0 : 1, output: ok ? ' Test Files  1 passed (1)\n      Tests  3 passed (3)' : ' FAIL cart.test.ts\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)', durationMs: 900, at: NOW }) })), NOW + 2)

test('suggests the checks a project already has', () => {
  const node = suggestCriteria({
    files: ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'],
    packageJson: JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' } }),
  })
  expect(node.map(one => `${one.kind}: ${one.command}`)).toEqual(['tests: pnpm test', 'lint: pnpm run lint', 'typecheck: pnpm run typecheck', 'build: pnpm run build'])
  expect(node.every(one => one.isOn)).toBe(true)

  const fresh = suggestCriteria({ files: ['package.json', 'tsconfig.json'], packageJson: '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })
  expect(fresh.map(one => one.command)).toEqual(['npx tsc --noEmit'])

  const python = suggestCriteria({ files: ['pyproject.toml'], pyproject: '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n' })
  expect(python.map(one => one.command)).toEqual(['python -m pytest -q', 'ruff check .', 'mypy .'])
  expect(suggestCriteria({ files: ['go.mod'] }).map(one => one.command)).toEqual(['go test ./...', 'go vet ./...', 'go build ./...'])
  expect(suggestCriteria({ files: ['Makefile'], makefile: 'test:\n\tpytest\nbuild:\n\tcc main.c\nX := 1\n' }).map(one => one.command)).toEqual(['make test', 'make build'])
  expect(suggestCriteria({ files: ['README.md'] })).toEqual([])

  const custom = customCriterion('./scripts/smoke.sh', node)
  expect(custom).toMatchObject({ kind: 'command', command: './scripts/smoke.sh', isOn: true })
  expect(customCriterion('pnpm test', node)).toBeUndefined()
})

test('reads its arguments, the plan and the markers in an answer', () => {
  expect(parseArgs('')).toEqual({ kind: 'open' })
  expect(parseArgs('stop')).toEqual({ kind: 'stop' })
  expect(parseArgs('resume use postgres')).toEqual({ kind: 'resume', answer: 'use postgres' })
  expect(parseArgs('stop the memory leak in the worker')).toEqual({ kind: 'goal', goal: 'stop the memory leak in the worker' })

  const plan = parsePlan(['Here is the plan:', '', '1. **Read** the cart module', '2) Add tax to `total()`', '   1. a sub-point', '3. Run the tests', 'ASSUMPTION: 1. tax is 20%'].join('\n'))
  expect(plan).toEqual(['Read the cart module', 'Add tax to total()', 'Run the tests'])
  expect(parsePlan('I will just do it.')).toEqual([])

  const markers = parseMarkers('Done.\nASSUMPTION: VAT is 20%\n**QUESTION:** should totals round up?\nBLOCKED: which currency?')
  expect(markers).toEqual({ blocked: 'which currency?', questions: ['should totals round up?'], assumptions: ['VAT is 20%'] })
})

test('judges each check from its exit code and the runner\'s counts', () => {
  const tests = criterion('tests', 'npx vitest run')
  const failed = checkOf(tests, { exitCode: 1, output: '\u001b[31m FAIL \u001b[0m cart.test.ts\n Tests  2 failed | 10 passed (12)\n', durationMs: 4000, at: NOW })
  expect(failed).toMatchObject({ ok: false, summary: '✗ 2 failed · 10 passed', exitCode: 1 })
  expect(failed.output).not.toContain('\u001b')
  expect(checkOf(tests, { exitCode: 0, output: ' Tests  12 passed (12)', durationMs: 1, at: NOW })).toMatchObject({ ok: true, summary: '✓ 12 passed' })
  expect(checkOf(criterion('lint', 'eslint .'), { exitCode: 2, output: 'x', durationMs: 1, at: NOW })).toMatchObject({ ok: false, summary: '✗ exit 2' })
  expect(checkOf(criterion('build', 'make'), { exitCode: null, output: '', durationMs: 300_000, at: NOW, failure: 'timed out after 300s' })).toMatchObject({ ok: false, summary: '✗ timed out after 300s' })
  const long = checkOf(criterion('lint', 'eslint .'), { exitCode: 1, output: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'), durationMs: 1, at: NOW })
  expect(long.output.split('\n').length).toBeLessThanOrEqual(60)
  expect(long.output).toContain('line 499')
})

test('plans, works step by step, feeds failures back, escalates once, and stops after N failed rounds', () => {
  let run = runOf()
  const first = turn(run, '1. Find the total\n2. Add the tax')
  expect(first.submission.kind).toBe('plan')
  expect(first.submission.prompt).toContain('reply with a numbered list')
  expect(first.submission.prompt).toContain('Do not use the Workflow tool')
  expect(first.then).toBe('drive')
  run = first.run
  expect(run.steps).toEqual(['Find the total', 'Add the tax'])

  // Never two prompts in flight: while a turn is awaited nothing goes out.
  const step = nextSubmission(run)
  expect(step?.prompt).toContain('Step 1/2: Find the total')
  expect(nextSubmission(submitted(run, step!, NOW))).toBeUndefined()

  const one = turn(run, 'Read cart.ts')
  expect(one.then).toBe('checks')
  run = checked(one.run, false)
  expect(run).toMatchObject({ phase: 'execute', stepIndex: 1, failuresInRow: 0, status: 'running' })
  run = checked(turn(run, 'Added tax').run, false)
  expect(run).toMatchObject({ phase: 'fix', failuresInRow: 1, escalateNext: false })

  const fix = turn(run, 'Fixed rounding')
  expect(fix.submission.prompt).toContain('✗ 1 failed · 2 passed')
  expect(fix.submission.prompt).toContain('Do not weaken the checks')
  expect(fix.submission.isEscalated).toBe(false)
  run = checked(fix.run, false)
  expect(run).toMatchObject({ failuresInRow: 2, escalateNext: true })

  const retry = turn(run, 'Tried harder')
  expect(retry.submission.isEscalated).toBe(true)
  expect(retry.submission.prompt).toContain('stronger model (model: opus)')
  run = checked(retry.run, false)
  expect(run).toMatchObject({ status: 'failed', reason: '3 failed check rounds in a row' })
  expect(nextSubmission(run)).toBeUndefined()
  expect(run.turns).toBe(5)
})

test('stops on success, and on the turn, budget and time caps', () => {
  let run = turn(runOf(), '1. Do it').run
  run = checked(turn(run, 'Done').run, true)
  expect(run).toMatchObject({ status: 'succeeded', reason: 'all criteria pass' })

  const base = turn(runOf(), '1. Do it').run
  expect(limitReason(base, NOW)).toBeUndefined()
  expect(limitReason({ ...base, turns: base.maxTurns }, NOW)).toContain('turn limit')
  expect(limitReason({ ...base, spentUsd: 5.01 }, NOW)).toContain('budget ($5.00)')
  expect(limitReason(base, NOW + 61 * 60_000)).toContain('time limit (60 min)')
  expect(settingsOf({ maxTurns: 10_000, maxFailures: 99 })).toMatchObject({ maxTurns: HARD_MAX_TURNS, maxFailures: 10 })

  // A cap reached while a turn runs ends the run after that turn's checks.
  const capped = { ...turn(base, 'Partly').run, stopAfterTurn: 'the budget ($5.00) is spent' }
  expect(checked(capped, false)).toMatchObject({ status: 'stopped', reason: 'the budget ($5.00) is spent' })
})

test('interaction off: never blocks, parks the question and goes on', () => {
  expect(isNeverAsk('hub', 'off')).toBe(true)
  expect(isNeverAsk('hub', 'auto')).toBe(false)
  expect(isNeverAsk('hub', null)).toBe(false)
  expect(isNeverAsk('never', 'on')).toBe(true)
  expect(interactionWords({ interaction: 'hub', hubInteraction: 'off' })).toContain('never asks')

  const quiet = runOf(true)
  expect(quiet.neverAsk).toBe(true)
  const planned = turn(quiet, '1. Pick a database\n2. Write the migration\nBLOCKED: Postgres or SQLite?')
  expect(planned.submission.prompt).toContain('Never ask me anything')
  expect(planned.run).toMatchObject({ status: 'running', phase: 'execute', questions: ['Postgres or SQLite?'] })

  const asking = turn(runOf(), '1. Pick a database\nBLOCKED: Postgres or SQLite?')
  expect(asking.run).toMatchObject({ status: 'blocked', blockedQuestion: 'Postgres or SQLite?' })
  expect(asking.then).toBe('none')
})

test('a run restored after a restart waits for Resume and sends its step again', () => {
  const run = turn(runOf(), '1. Do it').run
  const inFlight = submitted(run, nextSubmission(run)!, NOW)
  const back = restored(inFlight, NOW + 60_000)
  expect(back).toMatchObject({ status: 'paused', awaiting: null })
  expect(back.reason).toContain('restored')
  expect(draftProblem({ ...newDraft('', [], SETTINGS, null) })).toBe('Write the goal first.')
  expect(draftProblem({ ...newDraft('x', [], SETTINGS, null), budgetUsd: 0 })).toContain('budget')
})

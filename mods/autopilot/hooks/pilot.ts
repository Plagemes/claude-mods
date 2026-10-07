// The autopilot's brain, pure (no `$`): suggesting criteria from the project, the prompts it sends, reading
// Claude's answers, judging the checks, and the run's state machine with its hard limits.

import type {
  AutopilotAwait,
  AutopilotCheck,
  AutopilotCriterion,
  AutopilotCriterionKind,
  AutopilotDraft,
  AutopilotEntry,
  AutopilotInteraction,
  AutopilotRun,
  AutopilotStatus,
} from '../types'
import { describeRun, stripAnsi, summarizeRun } from './shared/test-runners'

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────────

/** Whatever the configuration says, a run never submits more turns than this. */
export const HARD_MAX_TURNS = 100
/** Whatever the configuration says, a run never fails more rounds in a row than this. */
export const HARD_MAX_FAILURES = 10
export const MAX_STEPS = 10
const MAX_TIMELINE = 60
const MAX_PARKED = 20
const MAX_GOAL_CHARS = 4000
const OUTPUT_LINES = 60
const OUTPUT_CHARS = 3000
const LINE_CHARS = 200

export type PilotSettings = {
  maxFailures: number
  maxTurns: number
  budgetUsd: number
  maxMinutes: number
  allowWorkflow: boolean
}

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n >= low ? Math.min(high, n) : fallback
}

/** The configuration, clamped to the hard limits. */
export function settingsOf(options: Record<string, unknown>): PilotSettings {
  return {
    maxFailures: Math.round(clamp(options.maxFailures, 1, HARD_MAX_FAILURES, 3)),
    maxTurns: Math.round(clamp(options.maxTurns, 2, HARD_MAX_TURNS, 30)),
    budgetUsd: clamp(options.budgetUsd, 0.01, 1000, 5),
    maxMinutes: Math.round(clamp(options.maxMinutes, 1, 24 * 60, 60)),
    allowWorkflow: options.allowWorkflow === true,
  }
}

// ── Small text helpers ──────────────────────────────────────────────────────────────────────────────

export const oneLine = (text: string, width = LINE_CHARS): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}

export const usd = (value: number): string => `$${value.toFixed(2)}`

/** `45s`, `12m`, `2h 5m`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// ── /autopilot arguments ────────────────────────────────────────────────────────────────────────────

export type PilotCommand =
  | { kind: 'open' }
  | { kind: 'goal'; goal: string }
  | { kind: 'go' }
  | { kind: 'stop' }
  | { kind: 'pause' }
  | { kind: 'resume'; answer: string }
  | { kind: 'status' }
  | { kind: 'cancel' }

export const USAGE = '/autopilot <goal> · go · pause · resume [answer] · stop · status · cancel'

/** A single control word is a command; anything else is a goal (`resume` may carry your answer). */
export function parseArgs(args: string): PilotCommand {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [head = '', ...rest] = text.split(/\s+/)
  const word = head.toLowerCase()
  if (word === 'resume' || word === 'continue') return { kind: 'resume', answer: text.slice(head.length).trim() }
  if (rest.length === 0) {
    if (word === 'go' || word === 'start') return { kind: 'go' }
    if (word === 'stop' || word === 'abort') return { kind: 'stop' }
    if (word === 'pause') return { kind: 'pause' }
    if (word === 'status') return { kind: 'status' }
    if (word === 'cancel' || word === 'discard') return { kind: 'cancel' }
  }
  return { kind: 'goal', goal: text }
}

// ── Criteria suggested from the project ─────────────────────────────────────────────────────────────

/** What autopilot reads of the project to suggest criteria: the root's file names and three manifests. */
export type ProjectFacts = { files: readonly string[]; packageJson?: string; pyproject?: string; makefile?: string }

export const LABELS: Record<AutopilotCriterionKind, string> = {
  tests: 'Tests pass',
  lint: 'Lint clean',
  typecheck: 'Typecheck clean',
  build: 'Build OK',
  command: 'Command exits 0',
}

const NPM_PLACEHOLDER_TEST = /no test specified/

function scriptsOf(packageJson: string | undefined): Record<string, string> {
  if (packageJson === undefined) return {}
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown }
    const scripts = parsed.scripts
    if (scripts === null || typeof scripts !== 'object') return {}
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

/** How the project runs a package script: npm, pnpm, yarn or bun, by its lockfile. */
function scriptRunner(files: ReadonlySet<string>): (script: string) => string {
  if (files.has('pnpm-lock.yaml')) return script => (script === 'test' ? 'pnpm test' : `pnpm run ${script}`)
  if (files.has('yarn.lock')) return script => `yarn ${script}`
  if (files.has('bun.lockb') || files.has('bun.lock')) return script => `bun run ${script}`
  return script => (script === 'test' ? 'npm test' : `npm run ${script}`)
}

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'types', 'tsc']

/** The checks a project already has: package scripts, Python, Rust, Go and Makefile conventions, first found wins. */
export function suggestCriteria(facts: ProjectFacts): AutopilotCriterion[] {
  const files = new Set(facts.files)
  const found = new Map<AutopilotCriterionKind, string>()
  const offer = (kind: AutopilotCriterionKind, command: string | undefined): void => {
    if (command !== undefined && !found.has(kind)) found.set(kind, command)
  }

  if (files.has('package.json')) {
    const scripts = scriptsOf(facts.packageJson)
    const run = scriptRunner(files)
    if (scripts.test !== undefined && !NPM_PLACEHOLDER_TEST.test(scripts.test)) offer('tests', run('test'))
    if (scripts.lint !== undefined) offer('lint', run('lint'))
    const typecheck = TYPECHECK_SCRIPTS.find(name => scripts[name] !== undefined)
    if (typecheck !== undefined) offer('typecheck', run(typecheck))
    else if (files.has('tsconfig.json')) offer('typecheck', 'npx tsc --noEmit')
    if (scripts.build !== undefined) offer('build', run('build'))
  }
  const pyproject = facts.pyproject ?? ''
  if (files.has('pyproject.toml') || files.has('setup.py') || files.has('pytest.ini') || files.has('setup.cfg') || files.has('tox.ini')) {
    offer('tests', 'python -m pytest -q')
    if (/\[tool\.ruff/.test(pyproject) || files.has('ruff.toml') || files.has('.ruff.toml')) offer('lint', 'ruff check .')
    else if (/\[tool\.flake8|flake8/.test(pyproject) || files.has('.flake8')) offer('lint', 'flake8')
    if (/\[tool\.mypy/.test(pyproject) || files.has('mypy.ini')) offer('typecheck', 'mypy .')
    else if (/\[tool\.pyright/.test(pyproject) || files.has('pyrightconfig.json')) offer('typecheck', 'pyright')
  }
  if (files.has('Cargo.toml')) {
    offer('tests', 'cargo test')
    offer('lint', 'cargo clippy -- -D warnings')
    offer('typecheck', 'cargo check')
    offer('build', 'cargo build')
  }
  if (files.has('go.mod')) {
    offer('tests', 'go test ./...')
    offer('lint', 'go vet ./...')
    offer('build', 'go build ./...')
  }
  if (files.has('Makefile') && facts.makefile !== undefined) {
    const targets = new Set([...facts.makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map(match => match[1]))
    if (targets.has('test')) offer('tests', 'make test')
    if (targets.has('lint')) offer('lint', 'make lint')
    if (targets.has('typecheck')) offer('typecheck', 'make typecheck')
    if (targets.has('build')) offer('build', 'make build')
  }

  const order: AutopilotCriterionKind[] = ['tests', 'lint', 'typecheck', 'build']
  return order.flatMap(kind => {
    const command = found.get(kind)
    return command === undefined ? [] : [{ id: kind, kind, label: LABELS[kind], command, isOn: true }]
  })
}

/** A custom criterion from a command the person typed on the card. */
export function customCriterion(command: string, existing: readonly AutopilotCriterion[]): AutopilotCriterion | undefined {
  const text = command.trim()
  if (text === '' || existing.some(criterion => criterion.command === text)) return undefined
  const count = existing.filter(criterion => criterion.kind === 'command').length
  return { id: `command-${count + 1}`, kind: 'command', label: LABELS.command, command: text, isOn: true }
}

// ── The setup card ──────────────────────────────────────────────────────────────────────────────────

export function newDraft(goal: string, criteria: AutopilotCriterion[], settings: PilotSettings, hubInteraction: AutopilotDraft['hubInteraction']): AutopilotDraft {
  return {
    goal: goal.trim(),
    criteria,
    isBudgetOn: true,
    budgetUsd: settings.budgetUsd,
    isTimeOn: true,
    maxMinutes: settings.maxMinutes,
    interaction: 'hub',
    allowWorkflow: settings.allowWorkflow,
    hubInteraction,
    error: '',
  }
}

/** Interaction off means Claude never stops to ask: chosen on the card, or the hub's mode when the card follows it. */
export function isNeverAsk(interaction: AutopilotInteraction, hubInteraction: AutopilotDraft['hubInteraction']): boolean {
  if (interaction === 'never') return true
  if (interaction === 'ask') return false
  return hubInteraction === 'off'
}

/** How the card names the interaction policy. */
export function interactionWords(draft: Pick<AutopilotDraft, 'interaction' | 'hubInteraction'>): string {
  if (draft.interaction === 'never') return 'never asks: states assumptions and parks questions'
  if (draft.interaction === 'ask') return 'asks you when blocked'
  if (draft.hubInteraction === null) return 'follows the hub (not installed): asks you when blocked'
  return draft.hubInteraction === 'off'
    ? 'follows the hub (interaction off): never asks, parks questions'
    : `follows the hub (interaction ${draft.hubInteraction}): asks you when blocked`
}

/** Why the card cannot start, or undefined when it can. */
export function draftProblem(draft: AutopilotDraft): string | undefined {
  if (draft.goal.trim() === '') return 'Write the goal first.'
  if (draft.goal.length > MAX_GOAL_CHARS) return `The goal is too long (${draft.goal.length} characters, at most ${MAX_GOAL_CHARS}).`
  if (draft.isBudgetOn && !(draft.budgetUsd > 0)) return 'The budget must be more than $0.'
  if (draft.isTimeOn && !(draft.maxMinutes >= 1)) return 'The time limit must be at least 1 minute.'
  return undefined
}

export function newRun(draft: AutopilotDraft, opts: { id: string; now: number; project: string; settings: PilotSettings }): AutopilotRun {
  const neverAsk = isNeverAsk(draft.interaction, draft.hubInteraction)
  const run: AutopilotRun = {
    id: opts.id,
    goal: draft.goal.trim(),
    project: opts.project,
    criteria: draft.criteria.map(({ last: _last, ...criterion }) => criterion),
    budgetUsd: draft.isBudgetOn ? draft.budgetUsd : null,
    maxMinutes: draft.isTimeOn ? draft.maxMinutes : null,
    maxTurns: opts.settings.maxTurns,
    maxFailures: opts.settings.maxFailures,
    neverAsk,
    allowWorkflow: draft.allowWorkflow,
    status: 'running',
    phase: 'plan',
    steps: [],
    stepIndex: 0,
    turns: 0,
    failuresInRow: 0,
    escalateNext: false,
    spentUsd: 0,
    startedAt: opts.now,
    activeMs: 0,
    runningSince: opts.now,
    awaiting: null,
    isChecking: false,
    questions: [],
    assumptions: [],
    blockedQuestion: '',
    approvalId: '',
    pendingAnswer: null,
    stopAfterTurn: '',
    reason: '',
    timeline: [],
    endedAt: null,
  }
  const checks = activeCriteria(run).map(criterion => criterion.label).join(', ')
  return withEntry(run, { at: opts.now, kind: 'start', text: `Started${checks === '' ? ' (no checks)' : `: ${checks}`}${neverAsk ? ' · interaction off' : ''}` })
}

// ── Reading Claude's answers ────────────────────────────────────────────────────────────────────────

const NUMBERED = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:step\s+)?(\d{1,2})\s*[.):]\s*(?:\*\*)?\s*(.+?)\s*$/i
const MARKER_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(BLOCKED|QUESTION|ASSUMPTION)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i

/** The plan's steps: the first run of lines numbered 1, 2, 3 … (markdown kept out), at most MAX_STEPS. */
export function parsePlan(answer: string): string[] {
  const steps: string[] = []
  for (const line of answer.split('\n')) {
    if (MARKER_LINE.test(line)) continue
    const found = NUMBERED.exec(line)
    if (found === null) continue
    const number = Number(found[1])
    const text = (found[2] ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim()
    if (number === steps.length + 1 && text !== '') steps.push(oneLine(text, 400))
    if (steps.length >= MAX_STEPS) break
  }
  return steps
}

export type Markers = { blocked: string | undefined; questions: string[]; assumptions: string[] }

/** `BLOCKED:`, `QUESTION:` and `ASSUMPTION:` lines of an answer. */
export function parseMarkers(answer: string): Markers {
  const markers: Markers = { blocked: undefined, questions: [], assumptions: [] }
  for (const line of answer.split('\n')) {
    const found = MARKER_LINE.exec(line)
    if (found === null) continue
    const kind = (found[1] ?? '').toUpperCase()
    const text = oneLine(found[2] ?? '')
    if (kind === 'BLOCKED') markers.blocked = text
    else if (kind === 'QUESTION') markers.questions.push(text)
    else markers.assumptions.push(text)
  }
  return markers
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────

/** The end of a command's output: the last lines, capped, without colour codes. */
export function outputTail(output: string): string {
  const lines = stripAnsi(output).replace(/\r/g, '').trimEnd().split('\n')
  const tail = lines.slice(-OUTPUT_LINES).join('\n')
  return tail.length > OUTPUT_CHARS ? `…${tail.slice(-OUTPUT_CHARS)}` : tail
}

export type CommandRun = { exitCode: number | null; output: string; durationMs: number; at: number; failure?: string }

/** How one criterion's command went: exit 0 passes; tests also read the runner's counts. */
export function checkOf(criterion: Pick<AutopilotCriterion, 'kind' | 'command'>, ran: CommandRun): AutopilotCheck {
  const base = { at: ran.at, durationMs: ran.durationMs, exitCode: ran.exitCode, output: outputTail(ran.output) }
  if (ran.exitCode === null) return { ...base, ok: false, summary: `✗ ${ran.failure ?? 'did not run'}` }
  if (criterion.kind === 'tests') {
    const summary = summarizeRun(criterion.command, ran.output, ran.exitCode !== 0)
    const ok = ran.exitCode === 0 && summary.outcome === 'passed'
    return { ...base, ok, summary: ok || summary.outcome !== 'passed' ? describeRun(summary) : `✗ exit ${ran.exitCode}` }
  }
  return { ...base, ok: ran.exitCode === 0, summary: ran.exitCode === 0 ? '✓ exit 0' : `✗ exit ${ran.exitCode}` }
}

export const activeCriteria = (run: Pick<AutopilotRun, 'criteria'>): AutopilotCriterion[] => run.criteria.filter(criterion => criterion.isOn)

/** Whether every criterion that is on passed its last check (false when there are none, or one has not run). */
export function allPassed(criteria: readonly AutopilotCriterion[]): boolean {
  const active = criteria.filter(criterion => criterion.isOn)
  return active.length > 0 && active.every(criterion => criterion.last?.ok === true)
}

export const failing = (criteria: readonly AutopilotCriterion[]): AutopilotCriterion[] =>
  criteria.filter(criterion => criterion.isOn && criterion.last !== undefined && !criterion.last.ok)

/** `✓ 3/3 checks pass`, or the failing ones. */
export function checksLine(criteria: readonly AutopilotCriterion[]): string {
  const active = criteria.filter(criterion => criterion.isOn)
  const bad = failing(active)
  if (bad.length === 0) return `✓ ${active.length}/${active.length} checks pass`
  return `✗ ${bad.map(criterion => `${criterion.label}: ${criterion.last?.summary ?? '?'}`).join(' · ')}`
}

// ── The prompts it sends (as your words) ────────────────────────────────────────────────────────────

export const markerOf = (run: Pick<AutopilotRun, 'id' | 'turns'>, kind: AutopilotAwait['kind']): string => `[autopilot ${run.id.slice(0, 8)} ${kind} ${run.turns + 1}]`

function criteriaLines(run: AutopilotRun): string[] {
  const active = activeCriteria(run)
  if (active.length === 0) return ['No commands to check: the goal is reached when the plan is done.']
  return [
    'Success criteria: after each of your turns I run these myself; the goal is reached when all of them exit 0:',
    ...active.map(criterion => `- ${criterion.label}: \`${criterion.command}\``),
  ]
}

function limitsLine(run: AutopilotRun): string {
  const parts = [
    run.budgetUsd === null ? undefined : `budget ${usd(run.budgetUsd)}`,
    run.maxMinutes === null ? undefined : `${run.maxMinutes} min`,
    `${run.maxTurns} turns`,
  ].filter((part): part is string => part !== undefined)
  return `Limits: ${parts.join(' · ')}.`
}

/** smart-router's rules for splitting work, and whether a workflow is allowed (the person's tick on the card). */
export function routingRules(allowWorkflow: boolean): string[] {
  return [
    'How to run the work:',
    '- Small steps inline; a self-contained, read-heavy chunk to one subagent with a concise summary back.',
    '- Independent subtasks as parallel subagents: all their Agent calls in ONE message, each prompt opening with the same shared context block; subtasks that change the same files run one after another.',
    '- Set each subagent\'s model by difficulty: light → haiku (search, read, mechanical edits), standard → sonnet (clear features, tests, bugs with a repro), deep → opus (design, cross-cutting changes, security, root causes).',
    allowWorkflow
      ? '- The Workflow tool is allowed in this run (I ticked "allow workflow"): use it only for a big or structured step (6+ subtasks or a multi-stage fan-out).'
      : '- Do not use the Workflow tool in this run.',
    '- Do not push, deploy or publish anything unless the goal says so.',
  ]
}

export function interactionRule(neverAsk: boolean): string {
  return neverAsk
    ? 'Nobody will answer questions during this run (interaction is off). Never ask me anything and never stop to wait: when something is unclear, pick the most reasonable option, say it in a line starting `ASSUMPTION:` and carry on. Put anything you would have asked in lines starting `QUESTION:` at the end; I will read them later.'
    : 'If you truly cannot continue without a decision only I can make, end your answer with one line `BLOCKED: <your question>` and stop. Otherwise decide sensibly, state it in a line starting `ASSUMPTION:` and carry on.'
}

/** The escalation of a retry: harder thinking and a stronger model. */
export const ESCALATION =
  'This is a retry after a fix that did not work: think harder before changing anything (re-read the failure, form a hypothesis and test it), and hand this subtask to one subagent on a stronger model (model: opus) unless you already run on the strongest one.'

function footer(run: AutopilotRun, kind: AutopilotAwait['kind']): string[] {
  return ['', ...routingRules(run.allowWorkflow), '', interactionRule(run.neverAsk), '', markerOf(run, kind)]
}

export function planPrompt(run: AutopilotRun): string {
  return [
    `[Autopilot] Goal: ${run.goal}`,
    '',
    ...criteriaLines(run),
    limitsLine(run),
    '',
    `First, plan only: reply with a numbered list of at most ${MAX_STEPS} concrete, verifiable steps (one line each, in order). Do not change any files yet.`,
    ...footer(run, 'plan'),
  ].join('\n')
}

export function stepPrompt(run: AutopilotRun): string {
  const step = run.steps[run.stepIndex] ?? run.goal
  const total = Math.max(1, run.steps.length)
  const done = run.stepIndex === 0 ? [] : [`Done so far: steps 1–${run.stepIndex}.`]
  return [
    `[Autopilot] Step ${run.stepIndex + 1}/${total}: ${step}`,
    '',
    `Goal: ${run.goal}`,
    ...done,
    'Do this step now, and only this one. End with two short lines: what you changed, and how you checked it.',
    ...footer(run, 'step'),
  ].join('\n')
}

export function fixPrompt(run: AutopilotRun, isEscalated: boolean): string {
  const bad = failing(run.criteria)
  const good = activeCriteria(run).filter(criterion => criterion.last?.ok === true)
  const sections = bad.flatMap(criterion => [
    `### ${criterion.label}: \`${criterion.command}\` → ${criterion.last?.summary ?? 'failed'}`,
    '```',
    criterion.last?.output.trim() || '(no output)',
    '```',
  ])
  return [
    `[Autopilot] The success checks fail (round ${run.failuresInRow} of ${run.maxFailures}). Goal: ${run.goal}`,
    '',
    ...sections,
    ...(good.length > 0 ? [`Passing: ${good.map(criterion => criterion.label).join(', ')}.`] : []),
    '',
    'Find the root cause and fix it. Do not weaken the checks: no skipped or deleted tests, no loosened lint or type rules, no edited check commands.',
    ...(isEscalated ? [ESCALATION] : []),
    ...footer(run, 'fix'),
  ].join('\n')
}

export function answerPrompt(run: AutopilotRun, answer: string): string {
  const what =
    run.phase === 'plan' ? 'Now make the plan as asked.' : run.phase === 'execute' ? `Continue step ${run.stepIndex + 1}: ${run.steps[run.stepIndex] ?? run.goal}` : 'Continue fixing the failing checks.'
  return [
    `[Autopilot] About your question (“${oneLine(run.blockedQuestion, 300)}”): ${answer.trim() === '' ? 'no answer: proceed with your best judgement and state it as an ASSUMPTION.' : answer.trim()}`,
    '',
    what,
    ...footer(run, 'answer'),
  ].join('\n')
}

export type Submission = { kind: AutopilotAwait['kind']; prompt: string; isEscalated: boolean; marker: string }

/** What to send next, or undefined when nothing should go (not running, a turn or checks in flight). */
export function nextSubmission(run: AutopilotRun): Submission | undefined {
  if (run.status !== 'running' || run.awaiting !== null || run.isChecking || run.stopAfterTurn !== '') return undefined
  if (run.pendingAnswer !== null) return { kind: 'answer', prompt: answerPrompt(run, run.pendingAnswer), isEscalated: false, marker: markerOf(run, 'answer') }
  if (run.phase === 'plan') return { kind: 'plan', prompt: planPrompt(run), isEscalated: false, marker: markerOf(run, 'plan') }
  if (run.phase === 'execute') return { kind: 'step', prompt: stepPrompt(run), isEscalated: false, marker: markerOf(run, 'step') }
  return { kind: 'fix', prompt: fixPrompt(run, run.escalateNext), isEscalated: run.escalateNext, marker: markerOf(run, 'fix') }
}

// ── The state machine ───────────────────────────────────────────────────────────────────────────────

export const isActive = (run: Pick<AutopilotRun, 'status'> | null): boolean =>
  run !== null && (run.status === 'running' || run.status === 'paused' || run.status === 'blocked')

export const isOver = (status: AutopilotStatus): boolean => status === 'succeeded' || status === 'failed' || status === 'stopped'

export function withEntry(run: AutopilotRun, entry: AutopilotEntry): AutopilotRun {
  return { ...run, timeline: [...run.timeline, { ...entry, text: oneLine(entry.text, 300) }].slice(-MAX_TIMELINE) }
}

/** Running time so far: paused and blocked stretches do not count. */
export const elapsedOf = (run: AutopilotRun, now: number): number => run.activeMs + (run.runningSince === null ? 0 : Math.max(0, now - run.runningSince))

/** Stops the clock of the running stretch. */
const halted = (run: AutopilotRun, now: number): AutopilotRun => ({ ...run, activeMs: elapsedOf(run, now), runningSince: null })

/** Why the run must stop now (a cap was hit), or undefined. */
export function limitReason(run: AutopilotRun, now: number): string | undefined {
  if (run.turns >= Math.min(run.maxTurns, HARD_MAX_TURNS)) return `the turn limit (${run.maxTurns}) was reached`
  if (run.budgetUsd !== null && run.spentUsd >= run.budgetUsd) return `the budget (${usd(run.budgetUsd)}) is spent`
  if (run.maxMinutes !== null && elapsedOf(run, now) >= run.maxMinutes * 60_000) return `the time limit (${run.maxMinutes} min) was reached`
  return undefined
}

export function finish(run: AutopilotRun, status: 'succeeded' | 'failed' | 'stopped', reason: string, now: number): AutopilotRun {
  const ended = { ...halted(run, now), status, reason, endedAt: now, awaiting: null, isChecking: false, pendingAnswer: null, stopAfterTurn: '' }
  const glyph = status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : '■'
  return withEntry(ended, { at: now, kind: status === 'stopped' ? 'stop' : 'done', text: `${glyph} ${reason}`, ok: status === 'succeeded' })
}

export function pause(run: AutopilotRun, reason: string, now: number): AutopilotRun {
  if (run.status !== 'running') return run
  return withEntry({ ...halted(run, now), status: 'paused', reason }, { at: now, kind: 'pause', text: `Paused: ${reason}` })
}

/** Back to running; from blocked, the answer (or "use your judgement") goes out next. */
export function resume(run: AutopilotRun, answer: string, now: number): AutopilotRun {
  if (run.status !== 'paused' && run.status !== 'blocked') return run
  const pendingAnswer = run.status === 'blocked' ? answer : run.pendingAnswer
  const text = run.status === 'blocked' ? `Answered: ${answer.trim() === '' ? '(use your judgement)' : answer}` : 'Resumed'
  return withEntry({ ...run, status: 'running', runningSince: now, reason: '', blockedQuestion: run.status === 'blocked' ? run.blockedQuestion : '', pendingAnswer }, { at: now, kind: 'resume', text })
}

/** A run restored from the store in a new session: the turn it waited on is gone, so it waits for Resume. */
export function restored(run: AutopilotRun, now: number): AutopilotRun {
  if (!isActive(run)) return run
  const cleared = { ...run, awaiting: null }
  if (run.status === 'running') return pause(cleared, 'restored after a restart; press Resume to go on', now)
  return cleared
}

const parked = (list: readonly string[], more: readonly string[]): string[] => [...new Set([...list, ...more])].slice(-MAX_PARKED)

export type TurnEnd = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string }
export type AfterTurn = { run: AutopilotRun; then: 'checks' | 'drive' | 'none' }

/** The turn autopilot waited on ended: read the answer, move the plan on, and say what comes next. */
export function afterTurn(run: AutopilotRun, end: TurnEnd, now: number): AfterTurn {
  const kind = run.awaiting?.kind ?? 'step'
  let next: AutopilotRun = { ...run, awaiting: null }
  if (end.reason === 'aborted') return { run: pause(next, 'you interrupted the turn', now), then: 'none' }
  if (end.reason === 'refusal') return { run: finish(next, 'failed', 'Claude declined the task', now), then: 'none' }
  if (end.reason === 'error') {
    next = withEntry({ ...next, failuresInRow: next.failuresInRow + 1 }, { at: now, kind: 'error', text: 'The turn ended on an API error', ok: false })
    if (next.failuresInRow >= next.maxFailures) return { run: finish(next, 'failed', `${next.failuresInRow} failures in a row`, now), then: 'none' }
    return { run: next, then: next.stopAfterTurn !== '' ? 'none' : 'drive' }
  }

  const markers = parseMarkers(end.answer)
  next = { ...next, assumptions: parked(next.assumptions, markers.assumptions), pendingAnswer: kind === 'answer' ? null : next.pendingAnswer }
  const questions = [...markers.questions, ...(markers.blocked !== undefined && next.neverAsk ? [markers.blocked] : [])]
  if (questions.length > 0) {
    next = withEntry({ ...next, questions: parked(next.questions, questions) }, { at: now, kind: 'question', text: `Parked: ${questions.join(' · ')}` })
  }
  if (markers.blocked !== undefined && !next.neverAsk) {
    next = withEntry({ ...halted(next, now), status: 'blocked', blockedQuestion: markers.blocked, reason: 'Claude needs an answer' }, { at: now, kind: 'blocked', text: `Needs you: ${markers.blocked}` })
    return { run: next, then: 'none' }
  }

  if (next.phase === 'plan') {
    const parsedSteps = parsePlan(end.answer)
    const steps = parsedSteps.length > 0 ? parsedSteps : [next.goal]
    next = withEntry({ ...next, phase: 'execute', steps, stepIndex: 0 }, { at: now, kind: 'plan', text: parsedSteps.length > 0 ? `Plan: ${steps.length} steps` : 'No numbered plan came back: one step, the goal itself' })
    if (next.stopAfterTurn !== '') return { run: finish(next, 'stopped', next.stopAfterTurn, now), then: 'none' }
    return { run: next, then: 'drive' }
  }
  return { run: { ...next, isChecking: true }, then: 'checks' }
}

/** The checks ran: done when all pass; else the next step, or a fix round (escalated on a retry), or the end. */
export function afterChecks(run: AutopilotRun, criteria: AutopilotCriterion[], now: number): AutopilotRun {
  let next: AutopilotRun = { ...run, criteria, isChecking: false }
  const active = activeCriteria(next)
  if (active.length > 0) next = withEntry(next, { at: now, kind: 'check', text: checksLine(criteria), ok: allPassed(criteria) })
  if (allPassed(criteria)) return finish(next, 'succeeded', 'all criteria pass', now)

  if (next.phase === 'execute') {
    const stepIndex = next.stepIndex + 1
    next = withEntry({ ...next, stepIndex, failuresInRow: 0 }, { at: now, kind: 'step', text: `Step ${next.stepIndex + 1}/${next.steps.length} done`, ok: true })
    if (stepIndex < next.steps.length) return next.stopAfterTurn !== '' ? finish(next, 'stopped', next.stopAfterTurn, now) : next
    if (active.length === 0) return finish(next, 'succeeded', 'the plan is done (no checks to run)', now)
    next = { ...next, phase: 'fix', failuresInRow: 1, escalateNext: false }
    if (next.failuresInRow >= next.maxFailures) return finish(next, 'failed', 'the checks still fail after the plan', now)
    next = withEntry(next, { at: now, kind: 'fix', text: 'Plan done; feeding the failures back' })
  } else {
    const failuresInRow = next.failuresInRow + 1
    next = { ...next, failuresInRow, escalateNext: failuresInRow >= 2 }
    if (failuresInRow >= next.maxFailures) return finish(next, 'failed', `${failuresInRow} failed check rounds in a row`, now)
    next = withEntry(next, next.escalateNext ? { at: now, kind: 'escalate', text: 'Retry with harder thinking and a stronger model' } : { at: now, kind: 'fix', text: 'Feeding the failures back' })
  }
  return next.stopAfterTurn !== '' ? finish(next, 'stopped', next.stopAfterTurn, now) : next
}

/** What the run looks like once a prompt for it went out. */
export function submitted(run: AutopilotRun, submission: Submission, now: number): AutopilotRun {
  const awaiting: AutopilotAwait = { kind: submission.kind, marker: submission.marker, submittedAt: now, isEscalated: submission.isEscalated }
  const text =
    submission.kind === 'plan'
      ? 'Asked for a plan'
      : submission.kind === 'step'
        ? `Step ${run.stepIndex + 1}/${run.steps.length}: ${run.steps[run.stepIndex] ?? ''}`
        : submission.kind === 'answer'
          ? 'Sent your answer'
          : `Fix round ${run.failuresInRow}${submission.isEscalated ? ' (escalated)' : ''}`
  const kind = submission.kind === 'fix' ? 'fix' : submission.kind === 'plan' ? 'plan' : 'step'
  return withEntry({ ...run, awaiting, turns: run.turns + 1, pendingAnswer: submission.kind === 'answer' ? null : run.pendingAnswer }, { at: now, kind, text: `→ ${text}` })
}

/** The status line while a run is on, or undefined once it is over. */
export function statusText(run: AutopilotRun | null, now: number): string | undefined {
  if (run === null || isOver(run.status)) return undefined
  if (run.status === 'paused') return '✈ autopilot · paused'
  if (run.status === 'blocked') return '✈ autopilot · needs you'
  const where = run.phase === 'plan' ? 'planning' : run.phase === 'execute' ? `step ${Math.min(run.stepIndex + 1, run.steps.length)}/${run.steps.length}` : `fixing ${run.failuresInRow}/${run.maxFailures}`
  return `✈ autopilot · ${where} · ${usd(run.spentUsd)} · ${span(elapsedOf(run, now))}`
}

/** What the current step is, in a few words, for the tab. */
export function currentWords(run: AutopilotRun): string {
  if (run.isChecking) return 'Running the checks'
  if (run.phase === 'plan') return 'Planning'
  if (run.phase === 'execute') return `Step ${Math.min(run.stepIndex + 1, run.steps.length)}/${run.steps.length}: ${run.steps[run.stepIndex] ?? ''}`
  return `Fixing failed checks (round ${run.failuresInRow}/${run.maxFailures}${run.escalateNext ? ', escalated' : ''})`
}

/** What a plan worth keeping looks like, for workflow-studio's `/recipe save` (~/.claude/claude-mods/autopilot/last-plan.json). */
export type SavedPlan = {
  version: 1
  goal: string
  project: string
  steps: string[]
  checks: { name: string; command: string }[]
  allowWorkflow: boolean
  finishedAt: string
}

export function savedPlanOf(run: AutopilotRun): SavedPlan {
  return {
    version: 1,
    goal: run.goal,
    project: run.project,
    steps: run.steps,
    checks: activeCriteria(run).map(criterion => ({ name: criterion.label, command: criterion.command })),
    allowWorkflow: run.allowWorkflow,
    finishedAt: new Date(run.endedAt ?? run.startedAt).toISOString(),
  }
}

/** `/autopilot status` as text. */
export function reportText(run: AutopilotRun | null, now: number): string {
  if (run === null) return 'No autopilot run yet. Start one with /autopilot <goal>.'
  const head = `✈ ${run.status} · ${oneLine(run.goal, 80)}`
  const lines = [
    head,
    `${currentWords(run)} · turns ${run.turns}/${run.maxTurns} · spent ${usd(run.spentUsd)}${run.budgetUsd === null ? '' : `/${usd(run.budgetUsd)}`} · ${span(elapsedOf(run, now))}${run.maxMinutes === null ? '' : `/${run.maxMinutes}m`}`,
    ...activeCriteria(run).map(criterion => `${criterion.last === undefined ? '·' : criterion.last.ok ? '✓' : '✗'} ${criterion.label} — ${criterion.command}`),
  ]
  if (run.reason !== '') lines.push(`Reason: ${run.reason}`)
  if (run.blockedQuestion !== '' && run.status === 'blocked') lines.push(`Question: ${run.blockedQuestion} — answer with /autopilot resume <answer>`)
  if (run.questions.length > 0) lines.push(`Parked questions: ${run.questions.join(' · ')}`)
  return lines.join('\n')
}

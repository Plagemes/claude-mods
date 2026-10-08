import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ShiftOutcome, ShiftReport, ShiftResult, ShiftRun, ShiftTask, ShiftView } from '../types'
import {
  EMPTY_VIEW,
  changedBetween,
  clockOf,
  countDone,
  dateOf,
  glyphOf,
  listText,
  nextOccurrence,
  oneLine,
  parseClock,
  parseShiftArgs,
  reportMarkdown,
  reportText,
  snapshotOf,
  span,
  statusText,
  summarize,
} from './shift'
import { paneFailure } from './shared/render-safe'

const PANE = 'night-shift'
const PANE_TITLE = 'Night shift'
const PANE_ROWS = 20
const STORE_PREFIX = 'shift:'
const REPORT_DIR = '.claude/night-shift'
const TICK_MS = 60_000
/** Breathing room between one task's end and the next. */
const SETTLE_MS = 3_000
/** A start missed by more than this (the session was closed or busy) is not made up later. */
const MISSED_GRACE_MS = 2 * 60 * 60 * 1000
/** A submitted task whose turn has not started by then is given up. */
const START_TIMEOUT_MS = 3 * 60 * 1000
const MAX_FAILURES_IN_ROW = 2
const MAX_QUEUED = 30
const MAX_TASK_CHARS = 20_000
const MAX_NEW_FILES_LISTED = 50
const GIT_TIMEOUT_MS = 15_000
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
/** Sent after each task: nobody is there to answer questions. (A plugin's prompt carries no hidden context, so it is part of the text.) */
const UNATTENDED_NOTE =
  '(night-shift: this task runs unattended, nobody can answer questions until morning. Make reasonable, conservative ' +
  'decisions and note them, stay focused on the task, do not commit or push, and end with a short summary of what you ' +
  'changed, how you verified it, and what is left for a human.)'
/** How soon the first task goes once a shift starts, after the command or press that started it has answered. */
const FIRST_TASK_DELAY_MS = 500
/** How a task ended, as a `task.finished` event says it. */
const TASK_OUTCOME: Record<ShiftOutcome, 'ok' | 'failed' | 'cancelled'> = { done: 'ok', interrupted: 'cancelled', failed: 'failed', 'timed-out': 'failed' }
const TITLE_CHARS = 80
const OUTCOME_COLORS: Record<ShiftOutcome, string> = { done: 'success', interrupted: 'warning', failed: 'error', 'timed-out': 'warning' }

const viewAtom = atom({ plugin: 'night-shift', key: 'view' } as const, EMPTY_VIEW)

type Settings = { allowDirty: boolean; maxTasks: number; taskMs: number }

/** What this load knows of the session beside the shift itself. */
type Session = {
  root: string | undefined
  isTurnRunning: boolean
  personSubmitting: number
  isSubmitting: boolean
  failuresInRow: number
  /** The turn this plugin stopped for running past the task limit. */
  timedOutTurn: string | undefined
  /** git's view of the changed files when the current task started. */
  before: Map<string, string>
  /** Files the current task edited through Edit, Write or NotebookEdit. */
  touched: Set<string>
  pending: Timer | undefined
  /** The minute check; started at session start, or again by the next event after a hot reload dropped it. */
  ticker: Timer | undefined
  /** The status line last shown, so the minute tick only redraws it when it changed. */
  status: string | undefined
  /** How far mods-hub's `control.*` events were read. */
  controlSeenAt: number
}

function readSettings(options: PluginOptions): Settings {
  const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
    const n = Math.round(Number(value))
    return Number.isFinite(n) && n >= low ? Math.min(high, n) : fallback
  }
  return {
    allowDirty: options.allowDirty === true,
    maxTasks: clamp(options.maxTasks, 1, 50, 10),
    taskMs: clamp(options.taskMinutes, 5, 240, 45) * 60_000,
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const isBusy = (session: Session): boolean => session.isTurnRunning || session.isSubmitting || session.personSubmitting > 0

function showStatus($: EngineInterface, session: Session, view: ShiftView, now: number): void {
  const text = statusText(view, now)
  if (text === session.status) return
  session.status = text
  $.ui.status(text)
}

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return session.root
}

async function git($: EngineInterface, session: Session, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const run = await $.process.run(['git', ...args], { cwd: await rootOf($, session), timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

/** Applies `change`, refreshes the status line and saves the shift for the project. */
async function commit($: EngineInterface, session: Session, change: (view: ShiftView) => ShiftView): Promise<ShiftView> {
  const view = await update($, viewAtom, change)
  showStatus($, session, view, await $.clock.now())
  try {
    await $.store.set(`${STORE_PREFIX}${await rootOf($, session)}`, view)
  } catch (error) {
    $.ui.log(`night-shift: could not save: ${messageOf(error)}`, { to: 'debug' })
  }
  return view
}

/** Reads the project's shift back; a shift the last session left running is closed with what it had done. */
async function restore($: EngineInterface, session: Session): Promise<void> {
  const stored = (await $.store.get(`${STORE_PREFIX}${await rootOf($, session)}`).catch(() => undefined)) as Partial<ShiftView> | undefined
  const view: ShiftView = {
    tasks: Array.isArray(stored?.tasks) ? stored.tasks.filter(task => typeof task?.text === 'string').slice(0, MAX_QUEUED) : [],
    at: typeof stored?.at === 'number' ? stored.at : null,
    isOnAway: stored?.isOnAway === true,
    run: stored?.run !== null && typeof stored?.run === 'object' && Array.isArray(stored.run.tasks) ? stored.run : null,
    last: stored?.last !== null && typeof stored?.last === 'object' ? stored.last : null,
  }
  await update($, viewAtom, () => view)
  showStatus($, session, view, await $.clock.now())
  if (view.run !== null) $.clock.after(0, () => void endShift($, session, 'the session closed during the shift'))
}

async function freeReportPath($: EngineInterface, session: Session, date: string): Promise<string> {
  const root = await rootOf($, session)
  for (let n = 1; n < 10; n += 1) {
    const path = `${REPORT_DIR}/${date}${n === 1 ? '' : `-${n}`}.md`
    if (!(await $.fs.exists(`${root}/${path}`).catch(() => false))) return path
  }
  return `${REPORT_DIR}/${date}-${crypto.randomUUID().slice(0, 8)}.md`
}

async function writeReport($: EngineInterface, session: Session, run: ShiftRun, opts: { endedAt: number; reason: string; overall: string; isFinal: boolean }): Promise<void> {
  try {
    await $.fs.write(`${await rootOf($, session)}/${run.reportPath}`, reportMarkdown(run, opts))
  } catch (error) {
    $.ui.log(`night-shift: could not write ${run.reportPath}: ${messageOf(error)}`)
  }
}

/** git's changed files against the shift's base commit, with a fingerprint each. */
async function snapshot($: EngineInterface, session: Session, base: string): Promise<Map<string, string>> {
  if (base === '') return new Map()
  const [numstat, others] = await Promise.all([
    git($, session, ['diff', '--numstat', '-z', base]),
    git($, session, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return numstat.ok ? snapshotOf(numstat.out, others.ok ? others.out : '') : new Map()
}

// ── mods-hub: tasks on the bus, a shift that starts when you leave, stop/pause from anywhere ────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface, session: Session): Promise<void> {
  if ((await hubMode($)) === undefined) return
  session.controlSeenAt = await $.clock.now()
  await hubHello($, { version: await ownVersion($), publishes: ['task.started', 'task.finished'], consumes: ['session.away', 'control.stop', 'control.pause'] })
}

/** A task of the shift on the hub's bus (autopilot, workflow-studio, mission-control); nothing without the hub. */
async function publishTask($: EngineInterface, task: { id: string; text: string }, outcome?: ShiftOutcome): Promise<void> {
  const title = oneLine(task.text, TITLE_CHARS)
  if (outcome === undefined) await hubPublish($, { topic: 'task.started', data: { id: task.id, title } })
  else await hubPublish($, { topic: 'task.finished', data: { id: task.id, title, outcome: TASK_OUTCOME[outcome] } })
}

/**
 * A stop or pause raised through mods-hub (a STOP from your phone, mission-control): a running shift ends after
 * the task it is on, and a scheduled one is called off; the tasks stay queued. Read on the minute tick.
 */
async function obeyControl($: EngineInterface, session: Session): Promise<void> {
  let events
  try {
    events = await $.mods.recent({ prefix: 'control.', since: session.controlSeenAt })
  } catch {
    return
  }
  for (const event of events) {
    session.controlSeenAt = Math.max(session.controlSeenAt, event.at)
    if (event.topic !== 'control.stop' && event.topic !== 'control.pause') continue
    const by = String((event.data as { by?: unknown }).by ?? event.source)
    const why = `${event.topic === 'control.stop' ? 'stopped' : 'paused'} by ${by}`
    await commit($, session, view =>
      view.run !== null
        ? { ...view, run: { ...view.run, stopReason: view.run.stopReason || why } }
        : { ...view, at: null, isOnAway: false },
    )
  }
}

/** Whether mods-hub says you are away (no activity in any session, or you said so); false without it. */
async function isAway($: EngineInterface): Promise<boolean> {
  return (await hubMode($))?.presence === 'away'
}

/** Leaves a report that says why the shift did not run; the tasks stay queued. */
async function noShift($: EngineInterface, session: Session, reason: string): Promise<string> {
  const now = await $.clock.now()
  await commit($, session, view => ({
    ...view,
    at: null,
    isOnAway: false,
    last: { path: '', startedAt: now, endedAt: now, done: 0, total: view.tasks.length, reason, results: [], isSeen: false },
  }))
  await hubNotify($, { level: 'error', title: `🌙 night shift did not start: ${reason}`, topic: 'task.started' })
  return `Did not start: ${reason}.`
}

/** Why the shift may not start here, or undefined when it may. */
async function blocker($: EngineInterface, session: Session, settings: Settings): Promise<string | undefined> {
  if (settings.allowDirty) return undefined
  if (!(await git($, session, ['rev-parse', '--show-toplevel'])).ok) {
    return 'this is not a git repository, so the night\'s changes could not be reviewed (turn on allowDirty to run anyway)'
  }
  const status = await git($, session, ['status', '--porcelain'])
  if (!status.ok) return 'git status failed'
  if (status.out.trim() !== '') return 'the working tree has uncommitted changes; commit or stash them first (or turn on allowDirty)'
  return undefined
}

async function startShift($: EngineInterface, session: Session, settings: Settings): Promise<string> {
  const view = await read($, viewAtom)
  if (view.run !== null) return 'A shift is already running.'
  if (view.tasks.length === 0) {
    await commit($, session, latest => ({ ...latest, at: null }))
    return 'Nothing to run: add tasks with /night-shift add <task>.'
  }
  const why = await blocker($, session, settings)
  if (why !== undefined) return noShift($, session, why)

  const now = await $.clock.now()
  const head = await git($, session, ['rev-parse', '--verify', '-q', 'HEAD'])
  const tasks = view.tasks.slice(0, settings.maxTasks)
  const date = dateOf(now)
  const run: ShiftRun = {
    startedAt: now,
    date,
    reportPath: await freeReportPath($, session, date),
    base: head.ok ? head.out.trim() : '',
    tasks,
    results: [],
    current: null,
    stopReason: '',
  }
  const taken = new Set(tasks.map(task => task.id))
  await commit($, session, latest => ({ ...latest, at: null, isOnAway: false, run, tasks: latest.tasks.filter(task => !taken.has(task.id)) }))
  session.failuresInRow = 0
  await writeReport($, session, run, { endedAt: now, reason: '', overall: '', isFinal: false })
  await hubNotify($, { level: 'info', title: `🌙 night shift started: ${plural(tasks.length, 'task')} · report in ${run.reportPath}`, topic: 'task.started' })
  later($, session, settings, FIRST_TASK_DELAY_MS)
  return `Started: ${plural(tasks.length, 'task')}. The report goes to ${run.reportPath}.`
}

function later($: EngineInterface, session: Session, settings: Settings, ms: number): void {
  session.pending?.cancel()
  session.pending = $.clock.after(ms, () => {
    session.pending = undefined
    void nextTask($, session, settings).catch(error => $.ui.log(`night-shift: ${messageOf(error)}`, { to: 'debug' }))
  })
}

/** Submits the shift's next task, only while the session is idle; ends the shift when nothing is left or it must stop. */
async function nextTask($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  const { run } = await read($, viewAtom)
  if (run === null || run.current !== null || isBusy(session)) return
  if (run.stopReason !== '') return endShift($, session, run.stopReason)
  const task = run.tasks[run.results.length]
  if (task === undefined) return endShift($, session, 'all tasks ran')

  session.before = await snapshot($, session, run.base)
  session.touched = new Set()
  session.timedOutTurn = undefined
  if (isBusy(session)) return
  const startedAt = await $.clock.now()
  await commit($, session, view => (view.run === null || view.run.current !== null ? view : { ...view, run: { ...view.run, current: { ...task, startedAt } } }))
  session.isSubmitting = true
  try {
    const sent = await $.prompt.submit({ text: `${task.text}\n\n${UNATTENDED_NOTE}`, asUser: true })
    if (sent.drop === undefined) await publishTask($, task)
    if (sent.drop !== undefined) await recordResult($, session, settings, 'failed', 0, `A hook refused the task: ${sent.drop}`)
  } catch (error) {
    await recordResult($, session, settings, 'failed', 0, `The task could not be submitted: ${messageOf(error)}`)
  } finally {
    session.isSubmitting = false
  }
}

/** Files the current task changed, relative to the project root. */
async function filesOfTask($: EngineInterface, session: Session, base: string): Promise<string[]> {
  const root = await rootOf($, session)
  const fromGit = changedBetween(session.before, await snapshot($, session, base))
  const fromTools = [...session.touched].map(path => (root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path))
  return [...new Set([...fromGit, ...fromTools])].sort()
}

/** Files the current task's outcome, rewrites the report, and lines up the next task (or the end). */
async function recordResult($: EngineInterface, session: Session, settings: Settings, outcome: ShiftOutcome, durationMs: number, summary: string): Promise<void> {
  const { run } = await read($, viewAtom)
  const current = run?.current
  if (run === null || current === null || current === undefined) return
  const result: ShiftResult = {
    id: current.id,
    text: current.text,
    outcome,
    startedAt: current.startedAt,
    durationMs,
    files: await filesOfTask($, session, run.base),
    summary,
  }
  await publishTask($, current, outcome)
  session.failuresInRow = outcome === 'done' ? 0 : session.failuresInRow + 1
  const stopReason =
    run.stopReason ||
    (outcome === 'interrupted'
      ? 'you interrupted a task'
      : session.failuresInRow >= MAX_FAILURES_IN_ROW
        ? `${MAX_FAILURES_IN_ROW} tasks in a row did not finish`
        : '')
  const view = await commit($, session, latest =>
    latest.run === null ? latest : { ...latest, run: { ...latest.run, results: [...latest.run.results, result], current: null, stopReason } },
  )
  if (view.run !== null) await writeReport($, session, view.run, { endedAt: await $.clock.now(), reason: stopReason, overall: '', isFinal: false })
  later($, session, settings, SETTLE_MS)
}

async function endShift($: EngineInterface, session: Session, reason: string): Promise<void> {
  session.pending?.cancel()
  const { run } = await read($, viewAtom)
  if (run === null) return
  const endedAt = await $.clock.now()
  let overall = ''
  if (run.base !== '') {
    const [stat, others] = await Promise.all([
      git($, session, ['diff', '--stat', run.base]),
      git($, session, ['ls-files', '--others', '--exclude-standard']),
    ])
    const added = others.out.split('\n').filter(Boolean)
    overall = [
      stat.out.trimEnd(),
      ...added.slice(0, MAX_NEW_FILES_LISTED).map(path => ` new file: ${path}`),
      ...(added.length > MAX_NEW_FILES_LISTED ? [` … and ${added.length - MAX_NEW_FILES_LISTED} more new files`] : []),
    ]
      .filter(Boolean)
      .join('\n')
  }
  const finished: ShiftRun = run.current === null ? run : { ...run, current: null }
  await writeReport($, session, finished, { endedAt, reason, overall, isFinal: true })
  const report: ShiftReport = {
    path: run.reportPath,
    startedAt: run.startedAt,
    endedAt,
    done: countDone(run.results),
    total: run.tasks.length,
    reason,
    results: run.results,
    isSeen: false,
  }
  const notRun = run.tasks.slice(run.results.length)
  await commit($, session, view => ({ ...view, run: null, last: report, tasks: [...notRun, ...view.tasks].slice(0, MAX_QUEUED) }))
  // The morning news, on your channels too while you are away: success when every task got done.
  await hubNotify($, {
    level: report.done === report.total ? 'success' : 'error',
    title: `🌙 night shift over: ${report.done}/${report.total} done · ${report.path}`,
    topic: 'task.finished',
  })
}

function ensureTicker($: EngineInterface, session: Session, settings: Settings): void {
  if (session.ticker !== undefined) return
  session.ticker = $.clock.every(TICK_MS, () => void tick($, session, settings).catch(error => $.ui.log(`night-shift: ${messageOf(error)}`, { to: 'debug' })))
}

/** Every minute: start a due shift, stop a task that ran too long, retry a task that waited for Claude to be free. */
async function tick($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  const now = await $.clock.now()
  await obeyControl($, session)
  const view = await read($, viewAtom)
  showStatus($, session, view, now)
  if (view.run !== null) {
    const { current } = view.run
    if (current === null) return nextTask($, session, settings)
    if (current.turnId === undefined && !session.isTurnRunning && now - current.startedAt > START_TIMEOUT_MS) {
      return recordResult($, session, settings, 'failed', now - current.startedAt, 'The task never started.')
    }
    if (current.turnId !== undefined && now - current.startedAt > settings.taskMs && session.timedOutTurn !== current.turnId) {
      session.timedOutTurn = current.turnId
      await $.turn.abort({ turnId: current.turnId }).catch(error => {
        session.timedOutTurn = undefined
        $.ui.log(`night-shift: could not stop an overlong task: ${messageOf(error)}`, { to: 'debug' })
      })
    }
    return
  }
  if (view.isOnAway === true && view.tasks.length > 0 && !isBusy(session) && (await isAway($))) {
    await startShift($, session, settings)
    return
  }
  if (view.at === null || now < view.at || isBusy(session)) return
  if (now - view.at > MISSED_GRACE_MS) {
    await noShift($, session, `it missed its ${clockOf(view.at)} start (the session was closed or busy)`)
    return
  }
  await startShift($, session, settings)
}

async function schedule($: EngineInterface, session: Session, hour: number, minute: number): Promise<string> {
  const now = await $.clock.now()
  const at = nextOccurrence(now, hour, minute)
  const view = await commit($, session, latest => ({ ...latest, at, isOnAway: false }))
  const tasks = view.tasks.length === 0 ? ' Add tasks with /night-shift add <task>.' : ` ${plural(view.tasks.length, 'task')} queued.`
  return `Scheduled for ${clockOf(at)} (in ${span(at - now)}).${tasks} Keep this session open; it needs a clean git tree.`
}

async function runNow($: EngineInterface, session: Session, settings: Settings): Promise<string> {
  const view = await read($, viewAtom)
  if (view.run !== null) return 'A shift is already running.'
  if (view.tasks.length === 0) return 'Nothing to run: add tasks with /night-shift add <task>.'
  if (isBusy(session)) {
    const now = await $.clock.now()
    await commit($, session, latest => ({ ...latest, at: Math.min(latest.at ?? now, now) }))
    return 'Claude is busy: the shift starts once this turn is over.'
  }
  return startShift($, session, settings)
}

/** `/night-shift away`: start the next shift as soon as mods-hub says you are away; it needs the hub to know. */
async function whenAway($: EngineInterface, session: Session): Promise<string> {
  if ((await hubMode($)) === undefined) {
    return 'Starting when you are away needs mods-hub, which knows when you leave. Use /night-shift at <HH:MM> instead.'
  }
  const view = await commit($, session, latest => ({ ...latest, at: null, isOnAway: true }))
  const tasks = view.tasks.length === 0 ? ' Add tasks with /night-shift add <task>.' : ` ${plural(view.tasks.length, 'task')} queued.`
  return `The shift starts once you are away (no activity for a while, or /hub away).${tasks} Keep this session open; it needs a clean git tree.`
}

async function stop($: EngineInterface, session: Session): Promise<string> {
  const view = await read($, viewAtom)
  if (view.run !== null) {
    await commit($, session, latest => (latest.run === null ? latest : { ...latest, run: { ...latest.run, stopReason: latest.run.stopReason || 'you stopped it' } }))
    return 'The shift stops after the current task; the rest stay queued.'
  }
  if (view.isOnAway === true) {
    await commit($, session, latest => ({ ...latest, isOnAway: false }))
    return `Cancelled the shift that would start when you are away; ${plural(view.tasks.length, 'task')} stay queued.`
  }
  if (view.at === null) return 'Nothing is scheduled.'
  await commit($, session, latest => ({ ...latest, at: null }))
  return `Cancelled the ${clockOf(view.at)} shift; ${plural(view.tasks.length, 'task')} stay queued.`
}

async function addTask($: EngineInterface, session: Session, text: string): Promise<string> {
  if (text.length > MAX_TASK_CHARS) return `That task is too long (${text.length} characters, the limit is ${MAX_TASK_CHARS}).`
  if ((await read($, viewAtom)).tasks.length >= MAX_QUEUED) return `The night shift holds ${MAX_QUEUED} tasks at most.`
  const task: ShiftTask = { id: crypto.randomUUID(), text }
  const view = await commit($, session, latest => ({ ...latest, tasks: [...latest.tasks, task] }))
  const when = view.at !== null ? `the ${clockOf(view.at)} shift` : 'the next shift (/night-shift at <HH:MM> or now)'
  return `Added #${view.tasks.length} to ${when}: ${oneLine(text, 60)}`
}

async function removeTask($: EngineInterface, session: Session, id: string): Promise<void> {
  await commit($, session, view => ({ ...view, tasks: view.tasks.filter(task => task.id !== id) }))
}

async function runCommand($: EngineInterface, session: Session, settings: Settings, args: string): Promise<string> {
  const command = parseShiftArgs(args)
  const now = await $.clock.now()
  switch (command.kind) {
    case 'open':
      await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
      return listText(await read($, viewAtom), now)
    case 'list':
      return listText(await read($, viewAtom), now)
    case 'add':
      return addTask($, session, command.text)
    case 'remove': {
      const task = (await read($, viewAtom)).tasks[command.position - 1]
      if (task === undefined) return `There is no task #${command.position}. /night-shift list shows the numbers.`
      await removeTask($, session, task.id)
      return `Removed #${command.position}: ${oneLine(task.text, 60)}`
    }
    case 'clear': {
      const count = (await read($, viewAtom)).tasks.length
      await commit($, session, view => ({ ...view, tasks: [] }))
      return `Cleared ${plural(count, 'task')}.`
    }
    case 'at':
      return schedule($, session, command.hour, command.minute)
    case 'now':
      return runNow($, session, settings)
    case 'away':
      return whenAway($, session)
    case 'off':
      return stop($, session)
    case 'report': {
      const { last } = await read($, viewAtom)
      if (last === null) return 'No shift has run yet.'
      await commit($, session, view => (view.last === null ? view : { ...view, last: { ...view.last, isSeen: true } }))
      return reportText(last)
    }
    case 'usage':
      return `Usage: ${command.why}`
  }
}

/** The morning toast: the first prompt you type after a shift says how it went. */
async function greet($: EngineInterface, session: Session): Promise<void> {
  const { last, run } = await read($, viewAtom)
  if (run !== null || last === null || last.isSeen) return
  const where = last.path === '' ? last.reason : `${last.done}/${last.total} done · ${last.path}`
  $.ui.toast(`🌙 night shift: ${where}`, { timeoutMs: 12_000 })
  await commit($, session, view => (view.last === null ? view : { ...view, last: { ...view.last, isSeen: true } }))
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const session: Session = {
    root: undefined,
    isTurnRunning: false,
    personSubmitting: 0,
    isSubmitting: false,
    failuresInRow: 0,
    timedOutTurn: undefined,
    before: new Map(),
    touched: new Set(),
    pending: undefined,
    ticker: undefined,
    status: undefined,
    controlSeenAt: 0,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'night-shift',
      description: 'Run queued tasks at a set time (like overnight) and write a report',
      argumentHint: 'add <task> | at <HH:MM> | now | off | list | report',
      immediate: true,
    })
    try {
      await restore($, session)
    } catch (error) {
      $.ui.log(`night-shift: could not load: ${messageOf(error)}`, { to: 'debug' })
    }
    ensureTicker($, session, settings)
    afterStart($, 'night-shift', () => greetHub($, session))
    return next(e)
  })

  on('command.run', { command: 'night-shift' }, async ($, e) => {
    ensureTicker($, session, settings)
    try {
      return { text: await runCommand($, session, settings, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    session.personSubmitting += 1
    try {
      const { run } = await read($, viewAtom)
      if (run !== null && run.stopReason === '') {
        // You are back: the shift ends after the task it is on.
        await commit($, session, view => (view.run === null ? view : { ...view, run: { ...view.run, stopReason: 'you took over' } }))
      }
      await greet($, session)
      return await next(e)
    } finally {
      session.personSubmitting -= 1
    }
  })

  on('turn.start', async ($, e, next) => {
    session.isTurnRunning = true
    const { run } = await read($, viewAtom)
    if (run?.current !== null && run?.current !== undefined && run.current.turnId === undefined) {
      await update($, viewAtom, view =>
        view.run?.current && view.run.current.turnId === undefined
          ? { ...view, run: { ...view.run, current: { ...view.run.current, turnId: e.turnId } } }
          : view,
      )
    }
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    if (ran.deny === undefined && ran.isError !== true && typeof path === 'string') session.touched.add(path)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    session.isTurnRunning = false
    ensureTicker($, session, settings)
    const { run, at } = await read($, viewAtom)
    const current = run?.current
    if (current !== null && current !== undefined && (current.turnId === undefined || current.turnId === e.turnId)) {
      const outcome: ShiftOutcome =
        e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? (session.timedOutTurn === e.turnId ? 'timed-out' : 'interrupted') : 'failed'
      const summary = e.reason === 'refusal' ? 'Claude declined the task.' : summarize(e.answer)
      const { durationMs } = e
      $.clock.after(0, () => void recordResult($, session, settings, outcome, durationMs, summary))
    } else if (run !== null) {
      later($, session, settings, SETTLE_MS)
    } else if (at !== null && at <= (await $.clock.now())) {
      $.clock.after(SETTLE_MS, () => void tick($, session, settings))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const view = await read($, viewAtom)
    const now = await $.clock.now()
    const rowText = Math.max(12, e.props.bodyColumns - 14)
    const { run, last } = view
    const results: readonly ShiftResult[] = run?.results ?? []

    const headline =
      run !== null
        ? `Running task ${Math.min(run.tasks.length, run.results.length + 1)} of ${run.tasks.length}${run.stopReason ? ` · stopping: ${run.stopReason}` : ''}`
        : view.at !== null
          ? `Starts at ${clockOf(view.at)} · in ${span(view.at - now)}`
          : view.isOnAway === true
            ? 'Starts as soon as you are away'
            : 'Not scheduled'
    const resultRow = (result: ShiftResult) => (
      <Box key={`result:${result.id}`} flexDirection="row" gap={1}>
        <Text color={OUTCOME_COLORS[result.outcome]}>{glyphOf(result.outcome)}</Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{oneLine(result.text, rowText)}</Text>
        </Box>
        <Text dimColor>{span(result.durationMs)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="headline" flexDirection="column">
          <Text bold color={run !== null ? 'suggestion' : undefined}>
            🌙 {headline}
          </Text>
          {run === null && (
            <Text dimColor>
              {settings.allowDirty ? 'Runs even with uncommitted changes.' : 'Needs a clean git tree when it starts.'} Keep this session open.
            </Text>
          )}
        </Box>
        {run !== null && (
          <Box flexDirection="column">
            {results.map(resultRow)}
            {run.current !== null && (
              <Box key="current" flexDirection="row" gap={1}>
                <Text color="suggestion">▶</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">{oneLine(run.current.text, rowText)}</Text>
                </Box>
                <Text dimColor>{span(now - run.current.startedAt)}</Text>
              </Box>
            )}
            <Text dimColor>Report: {run.reportPath}</Text>
          </Box>
        )}
        {view.tasks.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{run !== null ? 'Queued for the next shift' : 'Tasks'}</Text>
            {view.tasks.map((task, index) => (
              <Box key={`task:${task.id}`} flexDirection="row" gap={1}>
                <Text dimColor>{String(index + 1).padStart(2)}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">{oneLine(task.text, rowText)}</Text>
                </Box>
                <Button key={`remove:${task.id}`} label="✕" plain onPress={() => void removeTask($, session, task.id)} />
              </Box>
            ))}
          </Box>
        )}
        {view.tasks.length === 0 && run === null && <Text dimColor>No tasks yet: add one below or with /night-shift add {'<task>'}.</Text>}
        {Input !== undefined && (
          <Box flexDirection="column">
            <Input key="add" label="Add task " placeholder="what to do while you sleep" submitLabel="add" onSubmit={value => void addTask($, session, value.trim())} />
            {run === null && (
              <Input
                key="at"
                label="Start at "
                placeholder="02:00"
                submitLabel="schedule"
                onSubmit={value => {
                  const clock = parseClock(value)
                  if (clock === undefined) $.ui.toast(`"${value}" is not a time, try 02:00`)
                  else void schedule($, session, clock.hour, clock.minute)
                }}
              />
            )}
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {run === null && view.tasks.length > 0 && <Button key="now" label="Run now" hotkey="n" variant="primary" onPress={() => void runNow($, session, settings)} />}
          {run === null && view.at !== null && <Button key="cancel" label="Cancel schedule" hotkey="x" onPress={() => void stop($, session)} />}
          {run !== null && run.stopReason === '' && <Button key="stop" label="Stop after this task" hotkey="s" onPress={() => void stop($, session)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {run === null && last !== null && (
          <Box key="last" flexDirection="column">
            <Text dimColor>
              Last shift {clockOf(last.startedAt)}: {last.done}/{last.total} done · {last.reason}
            </Text>
            {last.results.map(resultRow)}
            {last.path !== '' && <Text dimColor>{last.path}</Text>}
          </Box>
        )}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'night-shift', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts

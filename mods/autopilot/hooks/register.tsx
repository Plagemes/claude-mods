import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput, Timer, TurnUsage } from 'claude-code'

import type { AutopilotCriterion, AutopilotDraft, AutopilotInteraction, AutopilotRun } from '../types'
import {
  activeCriteria,
  afterChecks,
  afterTurn,
  checkOf,
  currentWords,
  customCriterion,
  draftProblem,
  elapsedOf,
  finish,
  interactionWords,
  isActive,
  isOver,
  limitReason,
  newDraft,
  newRun,
  nextSubmission,
  oneLine,
  parseArgs,
  pause,
  reportText,
  restored,
  resume,
  savedPlanOf,
  settingsOf,
  span,
  statusText,
  submitted,
  suggestCriteria,
  usd,
  withEntry,
  USAGE,
} from './pilot'
import type { CommandRun, PilotSettings, Submission, TurnEnd } from './pilot'
import { costOf } from './shared/prices'
import { summarizeRun } from './shared/test-runners'

const PANE = 'autopilot'
const PANE_TITLE = 'Autopilot'
const TAB = 'autopilot'
const TAB_ORDER = 40
const VERSION = '1.0.0'
const STORE_PREFIX = 'run:'
const FILES_DIR = '.claude/claude-mods/autopilot'
/** How often a live run checks its caps, the hub and a prompt that never started. */
const TICK_MS = 5_000
/** Breathing room between a turn's end and the next prompt. */
const SETTLE_MS = 2_000
/** A submitted prompt whose turn has not started by then counts as a failed turn. */
const START_TIMEOUT_MS = 3 * 60_000
const TIMELINE_ROWS = 12
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** What a stop, pause or resume from your phone looks like (a channel's inbound message). */
const REMOTE_STOP = /^\s*\/?(?:autopilot\s+)?(?:stop|abort)\b/i
const REMOTE_PAUSE = /^\s*\/?(?:autopilot\s+)?pause\b/i
const REMOTE_RESUME = /^\s*\/?(?:autopilot\s+)?(?:resume|continue|go on)\b/i
/** A hub-wide emergency stop any mod may raise (mods-hub has no stop verb of its own yet). */
const HUB_STOP_TOPIC = /^x\.[a-z0-9-]+\.(?:stop-all|emergency-stop)$/
const INTERACTIONS: readonly AutopilotInteraction[] = ['hub', 'ask', 'never']
const INTERACTION_LABEL: Record<AutopilotInteraction, string> = { hub: 'Follow the hub', ask: 'Ask when blocked', never: 'Never ask' }

const draftAtom = atom({ plugin: 'autopilot', key: 'draft' } as const, null as AutopilotDraft | null)
const runAtom = atom({ plugin: 'autopilot', key: 'run' } as const, null as AutopilotRun | null)

/** What this load knows beside the run itself (lost on a hot reload, by design: the run lives in $.state and $.store). */
type Ctx = {
  settings: PilotSettings
  checkTimeoutMs: number
  root: string | undefined
  isTurnRunning: boolean
  isSubmitting: boolean
  personSubmitting: number
  isDriving: boolean
  isCheckingNow: boolean
  lastTurnEndAt: number
  ticker: Timer | undefined
  pending: Timer | undefined
  hubSince: number
  status: string | undefined
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function contextOf(options: PluginOptions): Ctx {
  const seconds = Number(options.checkTimeoutSeconds)
  return {
    settings: settingsOf(options),
    checkTimeoutMs: (Number.isFinite(seconds) && seconds >= 5 ? Math.min(600, seconds) : 300) * 1000,
    root: undefined,
    isTurnRunning: false,
    isSubmitting: false,
    personSubmitting: 0,
    isDriving: false,
    isCheckingNow: false,
    lastTurnEndAt: 0,
    ticker: undefined,
    pending: undefined,
    hubSince: 0,
    status: undefined,
  }
}

const isBusy = (ctx: Ctx): boolean => ctx.isTurnRunning || ctx.isSubmitting || ctx.personSubmitting > 0

// ── Persistence ─────────────────────────────────────────────────────────────────────────────────────

async function rootOf($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.root === undefined) ctx.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return ctx.root
}

function showStatus($: EngineInterface, ctx: Ctx, run: AutopilotRun | null, now: number): void {
  const text = statusText(run, now)
  if (text === ctx.status) return
  ctx.status = text
  $.ui.status(text)
}

/** Applies `change` to the run, saves it for the project (so a restart can resume it) and refreshes the status line. */
async function commit($: EngineInterface, ctx: Ctx, change: (run: AutopilotRun | null) => AutopilotRun | null): Promise<AutopilotRun | null> {
  const run = await update($, runAtom, change)
  showStatus($, ctx, run, await $.clock.now())
  try {
    await $.store.set(`${STORE_PREFIX}${await rootOf($, ctx)}`, run)
  } catch (error) {
    $.ui.log(`autopilot: could not save the run: ${messageOf(error)}`, { to: 'debug' })
  }
  return run
}

/** Reads the project's run back; one left running by a closed session waits for Resume. */
async function restore($: EngineInterface, ctx: Ctx): Promise<void> {
  const stored = (await $.store.get(`${STORE_PREFIX}${await rootOf($, ctx)}`).catch(() => undefined)) as AutopilotRun | null | undefined
  if (stored === null || stored === undefined || typeof stored !== 'object' || typeof stored.goal !== 'string' || !Array.isArray(stored.timeline)) return
  const now = await $.clock.now()
  const run = await commit($, ctx, () => restored(stored, now))
  if (isActive(run)) {
    ctx.hubSince = now
    ensureTicker($, ctx)
  }
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined || home === '' ? undefined : home.replace(/[\\/]+$/, '')
}

/** Keeps the last successful plan where workflow-studio's `/recipe save` finds it. */
async function savePlan($: EngineInterface, run: AutopilotRun): Promise<void> {
  try {
    const home = await homeOf($)
    if (home === undefined) return
    await $.fs.write(`${home}/${FILES_DIR}/last-plan.json`, `${JSON.stringify(savedPlanOf(run), null, 2)}\n`)
  } catch (error) {
    $.ui.log(`autopilot: could not save the plan: ${messageOf(error)}`, { to: 'debug' })
  }
}

// ── The hub, beyond the vendored client ─────────────────────────────────────────────────────────────

/** The hub's events since `since`; [] without the hub. */
async function hubRecent($: EngineInterface, since: number): Promise<Awaited<ReturnType<EngineInterface['mods']['recent']>>> {
  try {
    return await $.mods.recent({ since, limit: 50 })
  } catch {
    return []
  }
}

async function hubInteractionOf($: EngineInterface): Promise<AutopilotDraft['hubInteraction']> {
  const mode = await hubMode($)
  return mode === undefined ? null : mode.interaction
}

// ── The setup card ──────────────────────────────────────────────────────────────────────────────────

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

/** The checks the project already has, from its root's files and manifests. */
async function suggestFor($: EngineInterface, ctx: Ctx): Promise<AutopilotCriterion[]> {
  const root = await rootOf($, ctx)
  if (root === '') return []
  const entries = await $.fs.list(root).catch(() => [])
  const files = entries.map(entry => entry.name)
  const has = (name: string): boolean => files.includes(name)
  return suggestCriteria({
    files,
    packageJson: has('package.json') ? await readText($, `${root}/package.json`) : undefined,
    pyproject: has('pyproject.toml') ? await readText($, `${root}/pyproject.toml`) : undefined,
    makefile: has('Makefile') ? await readText($, `${root}/Makefile`) : undefined,
  })
}

/** Shows the Autopilot tab of the hub's panel, or this mod's own pane without the hub. */
async function showSurface($: EngineInterface): Promise<void> {
  if (await hubShowTab($, TAB)) return
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true }).catch(() => undefined)
}

async function openSetup($: EngineInterface, ctx: Ctx, goal: string): Promise<AutopilotDraft> {
  const draft = newDraft(goal, await suggestFor($, ctx), ctx.settings, await hubInteractionOf($))
  await update($, draftAtom, () => draft)
  await showSurface($)
  return draft
}

async function changeDraft($: EngineInterface, change: (draft: AutopilotDraft) => AutopilotDraft): Promise<void> {
  await update($, draftAtom, draft => (draft === null ? null : { ...change(draft), error: '' }))
}

const numberIn = (text: string): number => Number(text.replace(/[$\s,]/g, ''))

async function startRun($: EngineInterface, ctx: Ctx): Promise<string> {
  const draft = await read($, draftAtom)
  if (draft === null) return 'Nothing to start: /autopilot <goal> opens the setup card.'
  const current = await read($, runAtom)
  if (isActive(current)) return 'A run is already on: /autopilot stop it first.'
  const problem = draftProblem(draft)
  if (problem !== undefined) {
    await update($, draftAtom, latest => (latest === null ? null : { ...latest, error: problem }))
    return problem
  }
  const now = await $.clock.now()
  const run = newRun(draft, { id: crypto.randomUUID(), now, project: await rootOf($, ctx), settings: ctx.settings })
  await commit($, ctx, () => run)
  await update($, draftAtom, () => null)
  ctx.hubSince = now
  await hubPublish($, { topic: 'task.started', data: { id: run.id, title: `Autopilot: ${oneLine(run.goal, 120)}` } })
  await hubPublish($, { topic: 'x.autopilot.started', data: { id: run.id, goal: run.goal, criteria: activeCriteria(run).map(criterion => criterion.command), neverAsk: run.neverAsk } })
  ensureTicker($, ctx)
  later($, ctx, 0)
  const checks = activeCriteria(run).length
  return `Autopilot started: ${oneLine(run.goal, 80)} · ${checks} check${checks === 1 ? '' : 's'}${run.neverAsk ? ' · interaction off' : ''}. It waits for the session to be idle before each prompt.`
}

// ── Driving turns ───────────────────────────────────────────────────────────────────────────────────

function later($: EngineInterface, ctx: Ctx, ms: number): void {
  ctx.pending?.cancel()
  ctx.pending = $.clock.after(ms, () => {
    ctx.pending = undefined
    void drive($, ctx).catch(error => $.ui.log(`autopilot: ${messageOf(error)}`, { to: 'debug' }))
  })
}

function ensureTicker($: EngineInterface, ctx: Ctx): void {
  if (ctx.ticker !== undefined) return
  ctx.ticker = $.clock.every(TICK_MS, () => void tick($, ctx).catch(error => $.ui.log(`autopilot: ${messageOf(error)}`, { to: 'debug' })))
}

function stopTicker(ctx: Ctx): void {
  ctx.ticker?.cancel()
  ctx.ticker = undefined
  ctx.pending?.cancel()
  ctx.pending = undefined
}

/** Sends the next prompt when the run is running, nothing is in flight and the session is idle; ends a run past a cap. */
async function drive($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isDriving) return
  ctx.isDriving = true
  try {
    const run = await read($, runAtom)
    if (run === null || run.status !== 'running') return
    const now = await $.clock.now()
    const cap = limitReason(run, now)
    if (cap !== undefined) {
      if (run.awaiting !== null || run.isChecking) {
        if (run.stopAfterTurn === '') await commit($, ctx, latest => (latest === null ? null : { ...latest, stopAfterTurn: cap }))
      } else await endRun($, ctx, 'stopped', cap)
      return
    }
    if (run.isChecking && !ctx.isCheckingNow) {
      // A reload interrupted the checks: run them again.
      $.clock.after(0, () => void runChecks($, ctx))
      return
    }
    if (isBusy(ctx)) return
    const wait = ctx.lastTurnEndAt + SETTLE_MS - now
    if (wait > 0) {
      later($, ctx, wait)
      return
    }
    const submission = nextSubmission(run)
    if (submission !== undefined) await submit($, ctx, submission)
  } finally {
    ctx.isDriving = false
  }
}

/** Submits one prompt as your own words; the run records what it waits for before the prompt goes out. */
async function submit($: EngineInterface, ctx: Ctx, submission: Submission): Promise<void> {
  const now = await $.clock.now()
  const run = await commit($, ctx, latest => (latest === null ? null : submitted({ ...latest, blockedQuestion: submission.kind === 'answer' ? '' : latest.blockedQuestion }, submission, now)))
  if (run === null) return
  await hubPublish($, { topic: 'x.autopilot.step', data: { id: run.id, kind: submission.kind, turn: run.turns, step: run.stepIndex + 1, steps: run.steps.length, isEscalated: submission.isEscalated } })
  ctx.isSubmitting = true
  try {
    const sent = await $.prompt.submit({ text: submission.prompt, asUser: true })
    if (sent.drop !== undefined) await failedTurn($, ctx, `a hook refused the prompt: ${sent.drop}`)
  } catch (error) {
    await failedTurn($, ctx, `the prompt could not be sent: ${messageOf(error)}`)
  } finally {
    ctx.isSubmitting = false
  }
}

/** A prompt that never became a turn: counts as a failure, and the same prompt goes again (within the limits). */
async function failedTurn($: EngineInterface, ctx: Ctx, why: string): Promise<void> {
  const now = await $.clock.now()
  const run = await commit($, ctx, latest => {
    if (latest === null) return null
    const next = withEntry({ ...latest, awaiting: null, failuresInRow: latest.failuresInRow + 1 }, { at: now, kind: 'error', text: why, ok: false })
    return next.failuresInRow >= next.maxFailures ? finish(next, 'failed', `${next.failuresInRow} failures in a row (${why})`, now) : next
  })
  if (run !== null && isOver(run.status)) await announce($, ctx, run)
  else later($, ctx, SETTLE_MS)
}

/** The turn it waited on ended: read it, then check, go on, or stop. */
async function onTurnEnd($: EngineInterface, ctx: Ctx, end: TurnEnd): Promise<void> {
  const now = await $.clock.now()
  const before = await read($, runAtom)
  if (before === null || before.awaiting === null) return
  const result = afterTurn(before, end, now)
  const run = await commit($, ctx, () => result.run)
  if (run === null) return
  if (isOver(run.status)) return announce($, ctx, run)
  if (run.status === 'blocked') return announceBlocked($, ctx, run)
  if (result.then === 'checks') return runChecks($, ctx)
  if (result.then === 'drive') later($, ctx, SETTLE_MS)
}

/** Runs every criterion's command itself (sh -c, in the project root, with a timeout), then moves the run on. */
async function runChecks($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isCheckingNow) return
  ctx.isCheckingNow = true
  try {
    const run = await read($, runAtom)
    if (run === null || !run.isChecking) return
    const root = await rootOf($, ctx)
    const criteria: AutopilotCriterion[] = []
    for (const criterion of run.criteria) {
      if (!criterion.isOn) {
        criteria.push(criterion)
        continue
      }
      const ran = await runCommand($, ctx, root, criterion.command)
      const last = checkOf(criterion, ran)
      criteria.push({ ...criterion, last })
      await publishCheck($, criterion, ran, last.ok)
    }
    const now = await $.clock.now()
    const latest = await read($, runAtom)
    if (latest === null || latest.id !== run.id || !latest.isChecking) return
    const next = await commit($, ctx, () => afterChecks(latest, criteria, now))
    if (next === null) return
    await hubPublish($, { topic: 'x.autopilot.check', data: { id: next.id, ok: criteria.every(one => !one.isOn || one.last?.ok === true), results: criteria.filter(one => one.isOn).map(one => ({ label: one.label, ok: one.last?.ok === true, summary: one.last?.summary ?? '' })) } })
    if (isOver(next.status)) await announce($, ctx, next)
    else later($, ctx, SETTLE_MS)
  } finally {
    ctx.isCheckingNow = false
  }
}

async function runCommand($: EngineInterface, ctx: Ctx, root: string, command: string): Promise<CommandRun> {
  const at = await $.clock.now()
  try {
    const ran = await $.process.run(['sh', '-c', command], { ...(root === '' ? {} : { cwd: root }), timeoutMs: ctx.checkTimeoutMs })
    const output = [ran.stdout, ran.stderr].filter(text => text.trim() !== '').join('\n')
    return { exitCode: ran.exitCode, output, durationMs: (await $.clock.now()) - at, at }
  } catch (error) {
    const message = messageOf(error)
    const failure = /still running/.test(message) ? `timed out after ${Math.round(ctx.checkTimeoutMs / 1000)}s` : /ENOENT|failed to start/.test(message) ? 'could not start (no sh?)' : oneLine(message, 120)
    return { exitCode: null, output: '', durationMs: (await $.clock.now()) - at, at, failure }
  }
}

/** A test or build check is a real run: other mods hear about it as they would from anyone. */
async function publishCheck($: EngineInterface, criterion: AutopilotCriterion, ran: CommandRun, ok: boolean): Promise<void> {
  if (criterion.kind === 'tests' && ran.exitCode !== null) {
    const summary = summarizeRun(criterion.command, ran.output, ran.exitCode !== 0)
    await hubPublish($, { topic: 'test.result', data: { runner: summary.runner ?? 'unknown', outcome: summary.outcome, passed: summary.passed, failed: summary.failed, durationMs: ran.durationMs, command: criterion.command } })
  } else if (criterion.kind === 'build') {
    await hubPublish($, { topic: 'build.result', data: { tool: criterion.command.split(/\s+/)[0] ?? 'build', outcome: ran.exitCode === null ? 'error' : ok ? 'passed' : 'failed', durationMs: ran.durationMs, command: criterion.command } })
  }
}

async function endRun($: EngineInterface, ctx: Ctx, status: 'succeeded' | 'failed' | 'stopped', reason: string): Promise<void> {
  const now = await $.clock.now()
  const run = await commit($, ctx, latest => (latest === null || isOver(latest.status) ? latest : finish(latest, status, reason, now)))
  if (run !== null && run.endedAt === now) await announce($, ctx, run)
}

/** A run ended: notify (through the hub when it is there), publish, keep a good plan for /recipe save. */
async function announce($: EngineInterface, ctx: Ctx, run: AutopilotRun): Promise<void> {
  stopTicker(ctx)
  const now = await $.clock.now()
  const figures = `${run.turns} turns · ${usd(run.spentUsd)} · ${span(elapsedOf(run, now))}`
  if (run.status === 'succeeded') {
    await hubNotify($, { level: 'success', title: `Autopilot: goal reached`, body: `${oneLine(run.goal, 160)} — ${figures}`, topic: 'x.autopilot.finished' })
    await savePlan($, run)
  } else if (run.status === 'failed') {
    await hubNotify($, { level: 'error', title: 'Autopilot failed', body: `${run.reason} — ${oneLine(run.goal, 120)} (${figures})`, topic: 'x.autopilot.finished' })
  } else {
    await hubNotify($, { level: run.reason === 'you stopped it' ? 'info' : 'warning', title: 'Autopilot stopped', body: `${run.reason} — ${oneLine(run.goal, 120)} (${figures})`, topic: 'x.autopilot.finished' })
  }
  const outcome = run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'failed' : 'cancelled'
  await hubPublish($, { topic: 'task.finished', data: { id: run.id, title: `Autopilot: ${oneLine(run.goal, 120)}`, outcome } })
  await hubPublish($, { topic: 'x.autopilot.finished', data: { id: run.id, status: run.status, reason: run.reason, turns: run.turns, usd: run.spentUsd, ms: elapsedOf(run, now), questions: run.questions } })
}

/** Claude needs an answer: ask (a question the hub may route to your phone) and wait. */
async function announceBlocked($: EngineInterface, ctx: Ctx, run: AutopilotRun): Promise<void> {
  const approvalId = `autopilot-${run.id.slice(0, 8)}-${run.turns}`
  await commit($, ctx, latest => (latest === null ? null : { ...latest, approvalId }))
  await hubPublish($, { topic: 'approval.requested', data: { id: approvalId, question: `Autopilot: ${run.blockedQuestion}` } })
  await hubPublish($, { topic: 'x.autopilot.blocked', data: { id: run.id, question: run.blockedQuestion } })
  await hubNotify($, { level: 'warning', kind: 'question', title: 'Autopilot needs you', body: `${run.blockedQuestion} — answer with /autopilot resume <answer>`, topic: 'x.autopilot.blocked' })
}

async function pauseRun($: EngineInterface, ctx: Ctx, reason: string): Promise<string> {
  const now = await $.clock.now()
  const run = await read($, runAtom)
  if (run === null || run.status !== 'running') return run?.status === 'paused' ? 'Already paused.' : 'No run is going.'
  await commit($, ctx, latest => (latest === null ? null : pause(latest, reason, now)))
  await hubPublish($, { topic: 'x.autopilot.paused', data: { id: run.id, reason } })
  return `Paused (${reason}). /autopilot resume to go on.`
}

async function resumeRun($: EngineInterface, ctx: Ctx, answer: string): Promise<string> {
  const now = await $.clock.now()
  const run = await read($, runAtom)
  if (run === null || (run.status !== 'paused' && run.status !== 'blocked')) return run?.status === 'running' ? 'It is already running.' : 'Nothing to resume.'
  const next = await commit($, ctx, latest => (latest === null ? null : resume(latest, answer, now)))
  ctx.hubSince = Math.max(ctx.hubSince, now)
  ensureTicker($, ctx)
  if (next?.isChecking === true) $.clock.after(0, () => void runChecks($, ctx))
  else later($, ctx, 0)
  return run.status === 'blocked' ? 'Resumed with your answer.' : 'Resumed.'
}

async function stopRun($: EngineInterface, ctx: Ctx, reason: string): Promise<string> {
  const run = await read($, runAtom)
  if (!isActive(run)) return 'No run is going.'
  await endRun($, ctx, 'stopped', reason)
  return `Stopped: ${reason}. A turn already running finishes on its own.`
}

/** Every few seconds while a run is on: caps, a prompt that never started, the hub's stop and answers, and driving. */
async function tick($: EngineInterface, ctx: Ctx): Promise<void> {
  const run = await read($, runAtom)
  if (!isActive(run) || run === null) {
    stopTicker(ctx)
    return
  }
  const now = await $.clock.now()
  showStatus($, ctx, run, now)
  await pollHub($, ctx, run)
  const latest = await read($, runAtom)
  if (latest === null || latest.status !== 'running') return
  const { awaiting } = latest
  if (awaiting !== null && awaiting.turnId === undefined && !ctx.isTurnRunning && !ctx.isSubmitting && now - awaiting.submittedAt > START_TIMEOUT_MS) {
    await failedTurn($, ctx, 'the prompt never started a turn')
    return
  }
  await drive($, ctx)
}

/** Reads what reached the hub since the last look: a stop or answer from your phone, an approval, a hub-wide stop, a spent budget. */
async function pollHub($: EngineInterface, ctx: Ctx, run: AutopilotRun): Promise<void> {
  // After a hot reload the cursor is gone: never read back past the run's own start.
  const events = await hubRecent($, Math.max(ctx.hubSince, run.startedAt))
  for (const event of events) {
    ctx.hubSince = Math.max(ctx.hubSince, event.at + 1)
    if (event.source === 'autopilot') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.topic === 'channel.inbound' && data.isOwner === true && typeof data.text === 'string') {
      const text = data.text
      if (REMOTE_STOP.test(text)) await stopRun($, ctx, `stopped from ${String(data.channel ?? 'a channel')}`)
      else if (REMOTE_PAUSE.test(text)) await pauseRun($, ctx, `paused from ${String(data.channel ?? 'a channel')}`)
      else if (REMOTE_RESUME.test(text)) await resumeRun($, ctx, text.replace(REMOTE_RESUME, '').trim())
      else if (run.status === 'blocked') await resumeRun($, ctx, text)
    } else if (event.topic === 'approval.answered' && run.approvalId !== '' && data.id === run.approvalId) {
      if (data.answer === 'deny') await stopRun($, ctx, `denied by ${String(data.by ?? 'you')}`)
      else await resumeRun($, ctx, '')
    } else if (HUB_STOP_TOPIC.test(event.topic)) {
      await stopRun($, ctx, `stopped by ${event.source} (hub stop)`)
    } else if (event.topic === 'budget.threshold' && typeof data.percent === 'number' && data.percent >= 100) {
      await stopRun($, ctx, `${event.source} says the ${String(data.scope ?? '')} budget is spent`.replace(/\s+/g, ' '))
    }
    if (!isActive(await read($, runAtom))) return
  }
}

async function addSpend($: EngineInterface, ctx: Ctx, usage: TurnUsage | undefined): Promise<void> {
  if (usage === undefined) return
  const cost = costOf(usage, usage.model).usd
  if (cost <= 0) return
  await commit($, ctx, latest => (latest === null || isOver(latest.status) ? latest : { ...latest, spentUsd: latest.spentUsd + cost }))
}

// ── /autopilot ──────────────────────────────────────────────────────────────────────────────────────

async function runCommandText($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const command = parseArgs(args)
  const now = await $.clock.now()
  switch (command.kind) {
    case 'open':
      await showSurface($)
      return reportText(await read($, runAtom), now)
    case 'goal': {
      if (isActive(await read($, runAtom))) return 'A run is on: /autopilot stop it first (or /autopilot status).'
      const draft = await openSetup($, ctx, command.goal)
      const checks = draft.criteria.map(criterion => `${criterion.label} (${criterion.command})`).join(', ')
      return [
        `Setup card opened for: ${oneLine(draft.goal, 100)}`,
        `Checks found: ${checks === '' ? 'none (add a command on the card)' : checks}`,
        `Budget ${usd(draft.budgetUsd)} · ${draft.maxMinutes} min · interaction: ${interactionWords(draft)}`,
        'Press Start on the card, or /autopilot go.',
      ].join('\n')
    }
    case 'go':
      return startRun($, ctx)
    case 'stop':
      return stopRun($, ctx, 'you stopped it')
    case 'pause':
      return pauseRun($, ctx, 'you paused it')
    case 'resume':
      return resumeRun($, ctx, command.answer)
    case 'status':
      return reportText(await read($, runAtom), now)
    case 'cancel':
      await update($, draftAtom, () => null)
      return 'Setup card discarded.'
  }
}

// ── Drawing (the hub's Autopilot tab and the own pane share it) ─────────────────────────────────────

type PaneInput = RenderInput<'Pane'>

const CHECK_GLYPH = (criterion: AutopilotCriterion): string => (criterion.last === undefined ? '·' : criterion.last.ok ? '✓' : '✗')
const STATUS_COLOR: Record<AutopilotRun['status'], string> = { running: 'suggestion', paused: 'warning', blocked: 'warning', succeeded: 'success', failed: 'error', stopped: 'subtle' }

function drawDraft($: EngineInterface, e: PaneInput, ctx: Ctx, draft: AutopilotDraft): RenderElement {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const width = Math.max(20, e.props.bodyColumns - 4)
  const toggle = (isOn: boolean, label: string): string => `${isOn ? '[x]' : '[ ]'} ${label}`
  return (
    <Box key="setup" flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>✈ New autopilot run</Text>
        <Text wrap="wrap">Goal: {draft.goal === '' ? '(none yet)' : draft.goal}</Text>
        {Input !== undefined && <Input key="goal" label="Goal " value={draft.goal} placeholder="what should be true when it is done" submitLabel="set" onSubmit={value => void changeDraft($, d => ({ ...d, goal: value.trim() }))} />}
      </Box>
      <Box key="criteria" flexDirection="column">
        <Text bold>Success criteria</Text>
        {draft.criteria.length === 0 && <Text dimColor>No test, lint, typecheck or build command found here: add one below.</Text>}
        {draft.criteria.map(criterion => (
          <Box key={`row-${criterion.id}`} flexDirection="row" columnGap={1}>
            <Button key={`crit-${criterion.id}`} plain label={toggle(criterion.isOn, criterion.label)} onPress={() => void changeDraft($, d => ({ ...d, criteria: d.criteria.map(one => (one.id === criterion.id ? { ...one, isOn: !one.isOn } : one)) }))} />
            <Text dimColor wrap="truncate-end">
              {oneLine(criterion.command, width)}
            </Text>
          </Box>
        ))}
        {Input !== undefined && (
          <Input
            key="custom"
            label="Custom command "
            placeholder="must exit 0, e.g. ./scripts/smoke.sh"
            submitLabel="add"
            onSubmit={value =>
              void changeDraft($, d => {
                const added = customCriterion(value, d.criteria)
                return added === undefined ? d : { ...d, criteria: [...d.criteria, added] }
              })
            }
          />
        )}
        <Box key="budget-row" flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button key="budget-on" plain label={toggle(draft.isBudgetOn, `Budget ≤ ${usd(draft.budgetUsd)}`)} onPress={() => void changeDraft($, d => ({ ...d, isBudgetOn: !d.isBudgetOn }))} />
          {Input !== undefined && <Input key="budget" label="$ " value={String(draft.budgetUsd)} submitLabel="set" onSubmit={value => void changeDraft($, d => ({ ...d, budgetUsd: numberIn(value) }))} />}
        </Box>
        <Box key="time-row" flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button key="time-on" plain label={toggle(draft.isTimeOn, `Max time ${draft.maxMinutes} min`)} onPress={() => void changeDraft($, d => ({ ...d, isTimeOn: !d.isTimeOn }))} />
          {Input !== undefined && <Input key="minutes" label="min " value={String(draft.maxMinutes)} submitLabel="set" onSubmit={value => void changeDraft($, d => ({ ...d, maxMinutes: Math.round(numberIn(value)) }))} />}
        </Box>
      </Box>
      <Box key="policy" flexDirection="column">
        <Text bold>Interaction</Text>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {INTERACTIONS.map(choice => (
            <Button key={`interaction-${choice}`} label={INTERACTION_LABEL[choice]} variant={draft.interaction === choice ? 'primary' : 'secondary'} onPress={() => void changeDraft($, d => ({ ...d, interaction: choice }))} />
          ))}
        </Box>
        <Text dimColor wrap="wrap">
          {interactionWords(draft)}
        </Text>
        <Button key="workflow" plain label={toggle(draft.allowWorkflow, 'Allow workflow (Claude may use the Workflow tool for a big step)')} onPress={() => void changeDraft($, d => ({ ...d, allowWorkflow: !d.allowWorkflow }))} />
      </Box>
      {draft.error !== '' && <Text color="error">{draft.error}</Text>}
      <Box key="setup-buttons" flexDirection="row" columnGap={1}>
        <Button key="start" label="Start" hotkey="s" variant="primary" onPress={() => void startRun($, ctx)} />
        <Button key="cancel" label="Cancel" onPress={() => void update($, draftAtom, () => null)} />
      </Box>
      <Text dimColor wrap="wrap">
        Limits: {ctx.settings.maxTurns} turns, {ctx.settings.maxFailures} failed rounds in a row. It never sends a prompt while a turn runs; typing yourself pauses it.
      </Text>
    </Box>
  )
}

function drawRun($: EngineInterface, e: PaneInput, ctx: Ctx, run: AutopilotRun, now: number): RenderElement {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const width = Math.max(20, e.props.bodyColumns - 6)
  const elapsed = elapsedOf(run, now)
  const isBudgetOk = run.budgetUsd === null || run.spentUsd < run.budgetUsd
  const isTimeOk = run.maxMinutes === null || elapsed < run.maxMinutes * 60_000
  const active = isActive(run)
  return (
    <Box key="run" flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={STATUS_COLOR[run.status]}>
          ✈ Autopilot · {run.status}
          {run.reason === '' ? '' : ` — ${run.reason}`}
        </Text>
        <Text wrap="wrap">Goal: {run.goal}</Text>
      </Box>
      <Box key="criteria" flexDirection="column">
        {activeCriteria(run).map(criterion => (
          <Box key={`crit-${criterion.id}`} flexDirection="row" columnGap={1}>
            <Text color={criterion.last === undefined ? 'subtle' : criterion.last.ok ? 'success' : 'error'}>{CHECK_GLYPH(criterion)}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">
                {criterion.label} — {oneLine(criterion.command, width)}
                {criterion.last === undefined ? '' : ` · ${criterion.last.summary}`}
              </Text>
            </Box>
          </Box>
        ))}
        {run.budgetUsd !== null && (
          <Box key="crit-budget" flexDirection="row" columnGap={1}>
            <Text color={isBudgetOk ? 'success' : 'error'}>{isBudgetOk ? '✓' : '✗'}</Text>
            <Text>
              Budget {usd(run.spentUsd)} / {usd(run.budgetUsd)}
            </Text>
          </Box>
        )}
        {run.maxMinutes !== null && (
          <Box key="crit-time" flexDirection="row" columnGap={1}>
            <Text color={isTimeOk ? 'success' : 'error'}>{isTimeOk ? '✓' : '✗'}</Text>
            <Text>
              Time {span(elapsed)} / {run.maxMinutes}m
            </Text>
          </Box>
        )}
      </Box>
      <Box key="now" flexDirection="column">
        {active && <Text wrap="truncate-end">Now: {currentWords(run)}</Text>}
        <Text dimColor>
          Turns {run.turns}/{run.maxTurns} · failures in a row {run.failuresInRow}/{run.maxFailures} · spent {usd(run.spentUsd)}
          {run.neverAsk ? ' · interaction off' : ''}
        </Text>
        {run.steps.length > 0 && (
          <Text dimColor wrap="truncate-end">
            Plan: {run.steps.map((step, index) => `${index < run.stepIndex || run.phase === 'fix' || run.status === 'succeeded' ? '✓' : index === run.stepIndex && active ? '▶' : '·'}${index + 1} ${oneLine(step, 24)}`).join('  ')}
          </Text>
        )}
      </Box>
      {run.status === 'blocked' && (
        <Box key="blocked" flexDirection="column">
          <Text color="warning" wrap="wrap">
            Needs you: {run.blockedQuestion}
          </Text>
          {Input !== undefined && <Input key="answer" label="Answer " placeholder="your answer (empty: use your judgement)" submitLabel="send" onSubmit={value => void resumeRun($, ctx, value)} />}
        </Box>
      )}
      {run.questions.length > 0 && (
        <Box key="parked" flexDirection="column">
          <Text bold>Parked questions ({run.questions.length})</Text>
          {run.questions.slice(-5).map((question, index) => (
            <Text key={`q-${index}`} dimColor wrap="truncate-end">
              ? {question}
            </Text>
          ))}
        </Box>
      )}
      <Box key="timeline" flexDirection="column">
        <Text bold>Timeline</Text>
        {run.timeline.slice(-TIMELINE_ROWS).map((entry, index) => (
          <Box key={`t-${run.timeline.length - TIMELINE_ROWS + index}`} flexDirection="row" columnGap={1}>
            <Text dimColor>{span(entry.at - run.startedAt).padStart(6)}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end" color={entry.ok === true ? 'success' : entry.ok === false ? 'error' : undefined}>
                {entry.text}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Box key="run-buttons" flexDirection="row" columnGap={1}>
        {run.status === 'running' && <Button key="pause" label="Pause" hotkey="p" onPress={() => void pauseRun($, ctx, 'you paused it')} />}
        {(run.status === 'paused' || run.status === 'blocked') && <Button key="resume" label="Resume" hotkey="r" variant="primary" onPress={() => void resumeRun($, ctx, '')} />}
        {active && <Button key="stop" label="Stop" hotkey="x" onPress={() => void stopRun($, ctx, 'you stopped it')} />}
        {!active && <Button key="clear" label="Clear" onPress={() => void commit($, ctx, () => null)} />}
      </Box>
    </Box>
  )
}

async function drawBody($: EngineInterface, e: PaneInput, ctx: Ctx): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const draft = await read($, draftAtom)
  const run = await read($, runAtom)
  const now = await $.clock.now()
  if (draft !== null && !isActive(run)) return drawDraft($, e, ctx, draft)
  if (run !== null) return drawRun($, e, ctx, run, now)
  return (
    <Box key="empty" flexDirection="column">
      <Text bold>✈ Autopilot</Text>
      <Text dimColor wrap="wrap">
        No run yet. /autopilot {'<goal>'} opens the setup card: success criteria from this project, a budget, a time limit, and whether Claude may ask you.
      </Text>
    </Box>
  )
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const ctx = contextOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autopilot',
      description: 'Reach a goal on its own: plan, delegate, run the checks, retry until they pass',
      argumentHint: '<goal> | go | pause | resume [answer] | stop | status',
      immediate: true,
    })
    try {
      await restore($, ctx)
    } catch (error) {
      $.ui.log(`autopilot: could not restore the run: ${messageOf(error)}`, { to: 'debug' })
    }
    await hubHello(
      $,
      {
        version: VERSION,
        publishes: ['task.started', 'task.finished', 'approval.requested', 'test.result', 'build.result', 'x.autopilot.started', 'x.autopilot.step', 'x.autopilot.check', 'x.autopilot.blocked', 'x.autopilot.paused', 'x.autopilot.finished'],
        consumes: ['channel.inbound', 'approval.answered', 'budget.threshold'],
      },
      { id: TAB, title: PANE_TITLE, order: TAB_ORDER, command: 'autopilot' },
    )
    return next(e)
  })

  on('command.run', { command: 'autopilot' }, async ($, e) => {
    try {
      return { text: await runCommandText($, ctx, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}\nUsage: ${USAGE}` }
    }
  })

  // Someone else drove: you typed (or another mod spoke for you). Autopilot steps back.
  on('prompt.submit', async ($, e, next) => {
    const { origin } = e
    const isPerson = PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true && origin.name !== 'autopilot')
    if (!isPerson) return next(e)
    ctx.personSubmitting += 1
    try {
      const run = await read($, runAtom)
      if (run !== null && run.status === 'running') await pauseRun($, ctx, 'you took over (typed a prompt)')
      return await next(e)
    } finally {
      ctx.personSubmitting -= 1
    }
  })

  on('turn.start', async ($, e, next) => {
    ctx.isTurnRunning = true
    const run = await read($, runAtom)
    const awaiting = run?.awaiting
    if (awaiting !== null && awaiting !== undefined && awaiting.turnId === undefined && e.text.includes(awaiting.marker)) {
      await commit($, ctx, latest => (latest?.awaiting === null || latest?.awaiting === undefined ? latest : { ...latest, awaiting: { ...latest.awaiting, turnId: e.turnId } }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const run = await read($, runAtom)
    const isOurs = run !== null && run.awaiting?.turnId !== undefined && run.awaiting.turnId === e.turnId
    if (run !== null && (isOurs || (e.agentId !== undefined && run.status === 'running'))) await addSpend($, ctx, e.usage)
    if (e.agentId !== undefined) return result
    ctx.isTurnRunning = false
    ctx.lastTurnEndAt = await $.clock.now()
    if (isOurs) {
      const end: TurnEnd = { reason: e.reason, answer: e.answer }
      $.clock.after(0, () => void onTurnEnd($, ctx, end).catch(error => $.ui.log(`autopilot: ${messageOf(error)}`, { to: 'debug' })))
    } else if (run !== null && run.status === 'running') {
      ensureTicker($, ctx)
      later($, ctx, SETTLE_MS)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBody($, e, ctx))

  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBody($, e, ctx)}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:3ade61508f36: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts

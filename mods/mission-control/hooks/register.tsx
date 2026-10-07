import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { MissionBoard, MissionCard, MissionCommand, MissionCommandKind, MissionHeartbeat, MissionPriority, MissionPriorityFile, MissionState, MissionView } from '../types'
import {
  FILTERS,
  MISSION_USAGE,
  PRIORITY_CYCLE,
  SORTS,
  STALE_MS,
  STATE_LOOK,
  appendCommand,
  buildBoard,
  dayKey,
  describeCard,
  describeTotals,
  episodeOf,
  formatDuration,
  formatTokens,
  formatUsd,
  isLive,
  isWaiting,
  labelOf,
  oneLine,
  parseHeartbeat,
  parseHubSessions,
  parseInbox,
  parseMissionArgs,
  pendingCommands,
  projectOf,
  remember,
  resolveTarget,
  summarizeTask,
  waitsToAlert,
} from './model'
import { costOf } from './shared/prices'
import { redactText } from './shared/secrets'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const NAME = 'mission-control'
const PANE = 'mission-control'
const PANE_TITLE = 'Mission Control'
const HUB_PANE = 'claude-mods'
const TAB = 'mission'
/** Under the home directory: shared by every session. */
const DIR = '.claude/claude-mods/mission'
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
const HUB_STALE_MS = 10 * 60_000
const BEAT_MS = 5_000
/** An unchanged heartbeat is still rewritten this often, well inside STALE_MS. */
const KEEPALIVE_MS = 10_000
const INBOX_MS = 2_000
const BRANCH_MS = 60_000
const ACTIVITY_WRITE_MS = 10_000
const GIT_TIMEOUT_MS = 3_000
const MINUTE_MS = 60_000
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Detail fields of a tool's input that say best what is being approved. */
const DETAIL_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'description'] as const

const PAUSE_NOTE =
  'The person paused this session from Mission Control (another Claude Code session). Finish the step you are on, then stop: say briefly where you are and what is left, and do not start new work until they resume.'
const RESUME_NOTE = 'The person resumed this session from Mission Control: carry on where you paused.'
const RESUME_PROMPT = 'Resume: carry on where you paused.'
const VERB: Record<MissionCommandKind, string> = { pause: 'Pause', resume: 'Resume', stop: 'Stop', note: 'Note', priority: 'Priority' }

// ── State the cockpit draws from ────────────────────────────────────────────────────────────────────

const EMPTY_BOARD: MissionBoard = { cards: [], totals: { sessions: 0, working: 0, waiting: 0, paused: 0, spendToday: 0, isEstimate: false, longWaits: 0 }, at: 0 }
const boardAtom = atom({ plugin: 'mission-control', key: 'board' } as const, EMPTY_BOARD)
const viewAtom = atom({ plugin: 'mission-control', key: 'view' } as const, { sort: 'status', filter: 'all', noteFor: null } as MissionView)

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Runtime = {
  alertMs: number
  isSharing: boolean
  showStatus: boolean
  dir: string
  me: string
  beat: MissionHeartbeat
  turnId: string | undefined
  waitingTool: string | undefined
  agents: Set<string>
  notes: string[]
  isSubmitting: boolean
  pausedMidTurn: boolean
  lastWriteAt: number
  lastWritten: string
  lastBranchAt: number
  alerted: Set<string>
  selfAlerted: string
  lastActivityWriteAt: number
  shownStatus: string | undefined | null
  waitingPeers: number
  seq: number
  isPolling: boolean
  timers: Timer[]
  /** Clicks of this cockpit, written one after another (each reads, then rewrites, its own file in the target's inbox). */
  sending: Promise<unknown>
  /** How far the hub's `control.*` events were read (0: no hub), and why a hub pause holds this session's notes. */
  controlSeenAt: number
  heldBy: string
}

const blankBeat = (): MissionHeartbeat => ({
  v: 1,
  id: '',
  label: '',
  project: '',
  root: '',
  cwd: '',
  branch: '',
  model: '',
  surface: '',
  state: 'idle',
  stateSince: 0,
  task: '',
  turnStartedAt: null,
  startedAt: 0,
  updatedAt: 0,
  turns: 0,
  tokens: 0,
  usd: 0,
  isUsdEstimate: false,
  spend: { day: '', usd: 0 },
  subagents: 0,
  lastError: null,
  blocked: null,
  paused: false,
  priority: 'normal',
  acked: [],
  ended: false,
})

const newRuntime = (options: Record<string, unknown>): Runtime => ({
  alertMs: Math.max(0.5, Number(options.alertMinutes ?? 3)) * MINUTE_MS,
  isSharing: options.shareSession !== false,
  showStatus: options.statusLine !== false,
  dir: '',
  me: '',
  beat: blankBeat(),
  turnId: undefined,
  waitingTool: undefined,
  agents: new Set(),
  notes: [],
  isSubmitting: false,
  pausedMidTurn: false,
  lastWriteAt: 0,
  lastWritten: '',
  lastBranchAt: 0,
  alerted: new Set(),
  selfAlerted: '',
  lastActivityWriteAt: 0,
  shownStatus: null,
  waitingPeers: 0,
  seq: 0,
  isPolling: false,
  timers: [],
  sending: Promise.resolve(),
  controlSeenAt: 0,
  heldBy: '',
})

const paths = {
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  /** The single file of the first version: every cockpit wrote into it (kept for reading). */
  inbox: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.jsonl`,
  /** A session's inbox folder: one file per sending session, so each file has one writer and no click is lost. */
  inboxDir: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}`,
  inboxFrom: (rt: Runtime, id: string, from: string): string => `${rt.dir}/inbox/${id}/${from || 'mc'}.jsonl`,
  priority: (rt: Runtime): string => `${rt.dir}/priority.json`,
  activity: (rt: Runtime): string => `${rt.dir}/activity.json`,
}

/** Typed by the person: at the keyboard, from the phone bridge, or a plugin relaying their own words. */
const isPersonOrigin = (origin: { kind: string; asUser?: boolean }): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const startOfDay = (now: number): number => {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const describeInput = (input: unknown): string => {
  if (!isRecord(input)) return ''
  const detail = DETAIL_FIELDS.map(field => input[field]).find((value): value is string => typeof value === 'string' && value !== '')
  return detail === undefined ? '' : `: ${oneLine(redactText(detail).text, 80)}`
}

const resultText = (ran: { result?: unknown; text?: string }): string => {
  if (typeof ran.text === 'string' && ran.text !== '') return ran.text
  if (typeof ran.result === 'string') return ran.result
  const result = ran.result
  if (isRecord(result) && typeof result.stderr === 'string' && result.stderr !== '') return result.stderr
  return 'failed'
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function writeText($: EngineInterface, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text)
    return true
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
    return false
  }
}

/** Every heartbeat written since `since` (by file time), parsed; this session's own from memory. */
async function readBeats($: EngineInterface, rt: Runtime, since: number): Promise<MissionHeartbeat[]> {
  if (rt.dir === '') return []
  const entries = await $.fs.list(paths.sessions(rt)).catch(() => [])
  const beats: MissionHeartbeat[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs > 0 && entry.mtimeMs < since) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (id === rt.me) continue
    const beat = parseHeartbeat(await readJson($, paths.session(rt, id)))
    if (beat !== null) beats.push(beat)
  }
  if (rt.isSharing && rt.me !== '') beats.push({ ...rt.beat, updatedAt: await $.clock.now() })
  return beats
}

// ── This session's heartbeat ────────────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime, surface: string): Promise<void> {
  const now = await $.clock.now()
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  rt.dir = home === undefined || home === '' ? '' : `${home}/${DIR}`
  rt.me = await $.session.id()
  const cwd = await $.session.cwd()
  const root = (await $.session.repo().catch(() => null))?.root ?? cwd
  const project = projectOf(root)
  const model = await $.session.model().catch(() => '')
  rt.beat = { ...blankBeat(), id: rt.me, label: labelOf(project, rt.me), project, root, cwd, model, surface, stateSince: now, startedAt: now, spend: { day: dayKey(now), usd: 0 } }
  await $.command.register({
    name: 'mission',
    description: 'Opens Mission Control: every Claude session on this machine, what it does, its cost and blockers, with Pause, Stop, Note and Priority.',
    argumentHint: '[status | pause|resume|stop <session> | note <session> <text> | priority <session> high|normal|low | close]',
  })
  const hasHub = await hubHello($, { version: '1.0.0', publishes: ['x.mission-control.command'], consumes: ['session.*', 'cost.update', 'control.stop', 'control.pause', 'control.resume'] }, { id: TAB, title: 'Mission Control', order: 30, command: 'mission' })
  rt.controlSeenAt = hasHub ? now : 0
  for (const timer of rt.timers) timer.cancel()
  rt.timers = [$.clock.every(BEAT_MS, () => void tick($, rt)), $.clock.every(INBOX_MS, () => void poll($, rt))]
  $.clock.after(0, () => void afterStart($, rt))
}

async function afterStart($: EngineInterface, rt: Runtime): Promise<void> {
  await refreshBranch($, rt)
  await writeBeat($, rt, true)
}

async function refreshBranch($: EngineInterface, rt: Runtime): Promise<void> {
  rt.lastBranchAt = await $.clock.now()
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rt.beat.cwd, timeoutMs: GIT_TIMEOUT_MS })
    rt.beat.branch = ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    rt.beat.branch = ''
  }
}

/** Writes the heartbeat when it changed, or when the last write is getting old; follows a /clear's new id. */
async function writeBeat($: EngineInterface, rt: Runtime, force = false): Promise<void> {
  if (!rt.isSharing || rt.dir === '' || rt.me === '') return
  const id = await $.session.id().catch(() => rt.me)
  if (id !== rt.me && id !== '') {
    await writeText($, paths.session(rt, rt.me), JSON.stringify({ ...rt.beat, ended: true }))
    rt.me = id
    rt.beat = { ...rt.beat, id, label: labelOf(rt.beat.project, id), acked: [], ended: false }
  }
  const now = await $.clock.now()
  const content = JSON.stringify({ ...rt.beat, updatedAt: 0 })
  if (!force && content === rt.lastWritten && now - rt.lastWriteAt < KEEPALIVE_MS) return
  rt.beat.updatedAt = now
  if (await writeText($, paths.session(rt, rt.me), JSON.stringify(rt.beat))) {
    rt.lastWritten = content
    rt.lastWriteAt = now
  }
}

async function setState($: EngineInterface, rt: Runtime, state: MissionState, blocked: string | null): Promise<void> {
  if (rt.beat.state === state && rt.beat.blocked === blocked) return
  if (rt.beat.state !== state) rt.beat.stateSince = await $.clock.now()
  rt.beat.state = state
  rt.beat.blocked = blocked
  await writeBeat($, rt)
}

/** Back to working (a turn runs) or idle once a dialog closed. */
async function settleState($: EngineInterface, rt: Runtime): Promise<void> {
  rt.waitingTool = undefined
  await setState($, rt, rt.turnId === undefined ? 'idle' : 'working', null)
}

/** Every 5 s: heartbeat, the branch now and then, this session's own long wait, the other sessions' waits. */
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const now = await $.clock.now()
    if (now - rt.lastBranchAt >= BRANCH_MS) await refreshBranch($, rt)
    if (rt.beat.spend.day !== dayKey(now)) rt.beat.spend = { day: dayKey(now), usd: 0 }
    await writeBeat($, rt)
    await alertSelf($, rt, now)
    await scanPeers($, rt, now)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** This session waits on the person past the limit: once per wait, through the hub (your phone while away). */
async function alertSelf($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const beat = rt.beat
  if (!isWaiting(beat.state) || now - beat.stateSince < rt.alertMs) return
  const episode = episodeOf(beat)
  if (rt.selfAlerted === episode) return
  rt.selfAlerted = episode
  const what = beat.state === 'waiting-permission' ? 'an approval' : 'an answer'
  await hubNotify($, { level: 'warning', title: `${beat.label} has waited ${formatDuration(now - beat.stateSince)} for ${what}`, ...(beat.blocked === null ? {} : { body: beat.blocked }), topic: 'x.mission-control.waiting' })
}

/**
 * Other sessions: those waiting past the limit are announced in the session the person typed in last (where
 * they are looking), once per wait; the status line counts them everywhere.
 */
async function scanPeers($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const beats = (await readBeats($, rt, now - STALE_MS)).filter(beat => beat.id !== rt.me && isLive(beat, now))
  const waiting = beats.filter(beat => isWaiting(beat.state))
  const activity = await readJson($, paths.activity(rt))
  const isWhereThePersonIs = isRecord(activity) && activity.session === rt.me
  if (isWhereThePersonIs) {
    for (const beat of waitsToAlert(beats, rt.me, now, rt.alertMs, rt.alerted)) {
      rt.alerted.add(episodeOf(beat))
      $.ui.toast(`⏳ ${beat.label} has waited ${formatDuration(now - beat.stateSince)}${beat.blocked === null ? '' : `: ${beat.blocked}`} · /mission`, { timeoutMs: 8_000 })
    }
  }
  rt.waitingPeers = waiting.length
  showStatus($, rt)
}

/** One status line: this session paused, or how many others wait for the person. */
function showStatus($: EngineInterface, rt: Runtime): void {
  const n = rt.waitingPeers
  const text = rt.beat.paused ? '⏸ paused from Mission Control · /mission resume' : n > 0 ? `⏳ ${n} session${n === 1 ? '' : 's'} waiting for you · /mission` : undefined
  if (!rt.showStatus || text === rt.shownStatus) return
  rt.shownStatus = text
  $.ui.status(text)
}

/** The person acted in this session: the session other sessions' alerts go to. */
async function noteActivity($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '' || rt.me === '') return
  const now = await $.clock.now()
  if (now - rt.lastActivityWriteAt < ACTIVITY_WRITE_MS) return
  rt.lastActivityWriteAt = now
  await writeText($, paths.activity(rt), JSON.stringify({ session: rt.me, at: now }))
}

// ── The inbox: what other sessions' cockpits ask of this one ────────────────────────────────────────

/** Every 2 s: run new commands from this session's inbox, then redraw the cockpit if it is on screen. */
async function poll($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isPolling) return
  rt.isPolling = true
  try {
    if (rt.isSharing && rt.dir !== '' && rt.me !== '') {
      const text = await readInbox($, rt)
      if (text !== '') {
        const now = await $.clock.now()
        for (const command of pendingCommands(parseInbox(text), rt.beat.acked, now)) {
          rt.beat.acked = remember(rt.beat.acked, command.id)
          await runCommand($, rt, command)
        }
        await writeBeat($, rt)
      }
    }
    await obeyControl($, rt)
    if (await isBoardShown($)) await refreshBoard($, rt)
  } catch (error) {
    $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    rt.isPolling = false
  }
}

/** Every command file of this session's inbox (one per sending session, and the old single file), as one text. */
async function readInbox($: EngineInterface, rt: Runtime): Promise<string> {
  const entries = await $.fs.list(paths.inboxDir(rt, rt.me)).catch(() => [])
  const texts = [await readText($, paths.inbox(rt, rt.me))]
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) texts.push(await readText($, `${paths.inboxDir(rt, rt.me)}/${entry.name}`))
  }
  return texts.filter((text): text is string => text !== undefined && text !== '').join('\n')
}

/**
 * The hub's stop, pause and resume (a STOP from the phone, `/hub pause`): mission-control's own automatic work is
 * the notes it runs as your prompt when the session is idle. A pause holds them, a resume lets them go, a stop
 * drops them. Its own pauses (raised for a cockpit's Pause) are skipped.
 */
async function obeyControl($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.controlSeenAt === 0) return
  let events: Awaited<ReturnType<EngineInterface['mods']['recent']>>
  try {
    events = await $.mods.recent({ prefix: 'control.', since: rt.controlSeenAt })
  } catch {
    return
  }
  for (const event of events) {
    rt.controlSeenAt = Math.max(rt.controlSeenAt, event.at)
    if (event.source === NAME) continue
    const { by, reason } = (event.data ?? {}) as { by?: unknown; reason?: unknown }
    const who = `${String(by ?? event.source)}${typeof reason === 'string' && reason !== '' ? ` (${reason})` : ''}`
    if (event.topic === 'control.stop') {
      if (rt.notes.length > 0) $.ui.toast(`Mission Control: ${rt.notes.length} waiting note${rt.notes.length === 1 ? '' : 's'} dropped, stopped by ${who}.`)
      rt.notes = []
      rt.heldBy = ''
    } else if (event.topic === 'control.pause') {
      rt.heldBy = `paused by ${who}`
    } else if (event.topic === 'control.resume' && rt.heldBy !== '') {
      rt.heldBy = ''
      $.clock.after(0, () => void deliverNotes($, rt))
    }
  }
}

async function runCommand($: EngineInterface, rt: Runtime, command: MissionCommand): Promise<void> {
  const from = command.from.session === rt.me ? 'this session' : command.from.label || 'another session'
  switch (command.kind) {
    case 'pause':
      if (rt.beat.paused) return
      rt.beat.paused = true
      if (rt.turnId !== undefined) {
        rt.pausedMidTurn = true
        await appendNote($, PAUSE_NOTE)
      }
      $.ui.toast(`⏸ Paused from Mission Control (${from}): no new automatic prompts${rt.turnId === undefined ? '' : '; Claude stops after this step'}.`)
      await shareFact($, 'paused', true)
      // With mods-hub: the automatic work here (autopilot, task-queue, night-shift, workflows) pauses too.
      await hubStop($, { action: 'pause', scope: 'session', reason: 'paused from Mission Control', by: `owner via Mission Control (${from})` })
      break
    case 'resume':
      if (!rt.beat.paused) return
      rt.beat.paused = false
      if (rt.pausedMidTurn && rt.turnId !== undefined) await appendNote($, RESUME_NOTE)
      else if (rt.pausedMidTurn) rt.notes.unshift(RESUME_PROMPT)
      rt.pausedMidTurn = false
      $.ui.toast(`▶ Resumed from Mission Control (${from}).`)
      await shareFact($, 'paused', false)
      await hubStop($, { action: 'resume', scope: 'session', reason: 'resumed from Mission Control', by: `owner via Mission Control (${from})` })
      break
    case 'stop':
      if (rt.turnId === undefined) return
      try {
        await $.turn.abort({ turnId: rt.turnId })
        $.ui.toast(`⏹ Turn stopped from Mission Control (${from}).`)
      } catch (error) {
        $.ui.log(`${NAME}: could not stop the turn: ${messageOf(error)}`, { to: 'debug' })
      }
      break
    case 'note':
      rt.notes.push(command.text ?? '')
      $.ui.toast(`✉ Note from Mission Control (${from})${rt.turnId === undefined ? '' : ': it runs when Claude is idle'}.`)
      break
    case 'priority':
      await setPriority($, rt, command.priority ?? 'normal')
      $.ui.toast(`Priority ${rt.beat.priority} (set from Mission Control, ${from}).`)
      break
  }
  showStatus($, rt)
  await hubPublish($, { topic: 'x.mission-control.command', data: { kind: command.kind, from: command.from.label, session: rt.beat.label } })
  $.clock.after(0, () => void deliverNotes($, rt))
}

/** A line the model reads in the running turn (from its next step), not shown as the person's prompt. */
async function appendNote($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (error) {
    $.ui.log(`${NAME}: could not tell Claude: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** Notes (and a resume) run as the person's own prompt once the session is idle, one at a time. */
async function deliverNotes($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.turnId !== undefined || rt.isSubmitting || rt.heldBy !== '') return
  const text = rt.notes.shift()
  if (text === undefined) return
  rt.isSubmitting = true
  try {
    const submitted = await $.prompt.submit({ text, asUser: true })
    if (submitted.drop !== undefined) $.ui.toast(`The note did not run: ${oneLine(submitted.drop, 120)}`)
  } catch (error) {
    $.ui.log(`${NAME}: could not run the note: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    rt.isSubmitting = false
  }
}

async function setPriority($: EngineInterface, rt: Runtime, priority: MissionPriority): Promise<void> {
  rt.beat.priority = priority
  await shareFact($, 'priority', priority)
  if (rt.dir === '') return
  const now = await $.clock.now()
  const stored = await readJson($, paths.priority(rt))
  const sessions = isRecord(stored) && isRecord(stored.sessions) ? { ...(stored.sessions as MissionPriorityFile['sessions']) } : {}
  for (const [id, entry] of Object.entries(sessions)) if (!isRecord(entry) || now - Number(entry.at) > 24 * 60 * MINUTE_MS) delete sessions[id]
  if (priority === 'normal') delete sessions[rt.me]
  else sessions[rt.me] = { priority, label: rt.beat.label, root: rt.beat.root, at: now }
  const file: MissionPriorityFile = { v: 1, updatedAt: now, sessions }
  await writeText($, paths.priority(rt), `${JSON.stringify(file, null, 2)}\n`)
}

// ── Sending: a click in this cockpit becomes a line in the other session's inbox ────────────────────

async function sendCommand($: EngineInterface, rt: Runtime, target: { id: string; label: string }, kind: MissionCommandKind, extra: { text?: string; priority?: MissionPriority } = {}): Promise<string> {
  if (rt.dir === '') return 'No home folder: Mission Control cannot reach other sessions.'
  const now = await $.clock.now()
  rt.seq += 1
  const command: MissionCommand = { id: `${rt.me.slice(0, 8) || 'mc'}-${now.toString(36)}-${rt.seq}`, at: now, kind, from: { session: rt.me, label: rt.beat.label }, ...extra }
  const sent = rt.sending.then(() => writeCommand($, rt, target.id, command))
  rt.sending = sent.catch(() => false)
  if (!(await sent.catch(() => false))) return `Could not reach ${target.label}.`
  await noteActivity($, rt)
  if (target.id === rt.me) $.clock.after(0, () => void poll($, rt))
  return kind === 'note' ? `Note sent to ${target.label}: it runs there as your prompt when that session is idle.` : `${VERB[kind]} sent to ${target.label}.`
}

/** Appends a command to this session's own file in the target's inbox (pruning what the target handled). */
async function writeCommand($: EngineInterface, rt: Runtime, target: string, command: MissionCommand): Promise<boolean> {
  const path = paths.inboxFrom(rt, target, rt.me)
  const existing = (await readText($, path)) ?? ''
  const acked = parseHeartbeat(await readJson($, paths.session(rt, target)))?.acked ?? []
  return writeText($, path, appendCommand(existing, command, acked, command.at))
}

async function sendFromCard($: EngineInterface, rt: Runtime, card: MissionCard, kind: MissionCommandKind, extra: { text?: string; priority?: MissionPriority } = {}): Promise<void> {
  $.ui.toast(await sendCommand($, rt, card, kind, extra))
  await refreshBoard($, rt)
}

async function submitNote($: EngineInterface, rt: Runtime, card: MissionCard, text: string): Promise<void> {
  await update($, viewAtom, view => ({ ...view, noteFor: null }))
  if (text.trim() === '') return
  await sendFromCard($, rt, card, 'note', { text: text.trim() })
}

// ── The cockpit ─────────────────────────────────────────────────────────────────────────────────────

async function refreshBoard($: EngineInterface, rt: Runtime): Promise<MissionBoard> {
  const now = await $.clock.now()
  const view = await read($, viewAtom)
  const beats = await readBeats($, rt, startOfDay(now))
  const home = rt.dir === '' ? '' : rt.dir.slice(0, -DIR.length)
  const hub = home === '' ? [] : parseHubSessions(await readJson($, `${home}${HUB_SESSIONS}`), now, HUB_STALE_MS)
  const board = buildBoard({ beats, hub, me: rt.me, now, sort: view.sort, filter: view.filter, alertMs: rt.alertMs })
  await update($, boardAtom, () => board)
  return board
}

async function isBoardShown($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === PANE)) return true
  return panes.some(pane => pane.id === HUB_PANE) && (await hubTabIs($, TAB))
}

async function openCockpit($: EngineInterface, rt: Runtime): Promise<string> {
  await refreshBoard($, rt)
  if (await hubShowTab($, TAB)) return 'Mission Control is open in the Claude Mods panel.'
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  return opened.isPlaced ? 'Mission Control is open.' : 'Mission Control is open; widen the terminal to see it beside the conversation.'
}

async function runMission($: EngineInterface, rt: Runtime, args: string, isPerson: boolean): Promise<string> {
  const parsed = parseMissionArgs(args)
  if (!isPerson && (parsed.kind === 'command' || parsed.kind === 'note' || parsed.kind === 'priority')) {
    return 'Mission Control acts on other sessions only when you type the command or press a button yourself.'
  }
  if (isPerson) await noteActivity($, rt)
  if (parsed.kind === 'open') return openCockpit($, rt)
  if (parsed.kind === 'close') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return 'Mission Control closed.'
  }
  if (parsed.kind === 'error') return `${parsed.message}\n${MISSION_USAGE}`
  const board = await refreshBoard($, rt)
  if (parsed.kind === 'status') {
    return [describeTotals(board.totals), ...board.cards.map(card => `${describeCard(card)}${card.isMe ? ' (this session)' : ''}`)].join('\n')
  }
  const target = resolveTarget(
    board.cards.filter(card => !card.isHubOnly),
    parsed.who,
  )
  if (typeof target === 'string') return target
  if (parsed.kind === 'note') return sendCommand($, rt, target, 'note', { text: parsed.text })
  if (parsed.kind === 'priority') return sendCommand($, rt, target, 'priority', { priority: parsed.priority })
  return sendCommand($, rt, target, parsed.command)
}

const nextOf = <T,>(list: readonly T[], current: T): T => list[(list.indexOf(current) + 1) % list.length] ?? current

async function changeView($: EngineInterface, rt: Runtime, change: (view: MissionView) => MissionView): Promise<void> {
  await noteActivity($, rt)
  await update($, viewAtom, change)
  await refreshBoard($, rt)
}

async function drawBoard($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements
  const Input = 'Input' in elements && e.surface !== 'mobile' ? elements.Input : undefined
  const board = await read($, boardAtom)
  const view = await read($, viewAtom)
  const { totals } = board

  const card = (one: MissionCard): RenderElement => {
    const look = STATE_LOOK[one.state]
    const facts = [
      formatUsd(one.usd, one.isUsdEstimate),
      ...(one.tokens > 0 ? [`${formatTokens(one.tokens)} tok`] : []),
      ...(one.subagents > 0 ? [`${one.subagents} agent${one.subagents === 1 ? '' : 's'}`] : []),
      ...(one.model === '' ? [] : [one.model]),
      ...(one.priority === 'normal' ? [] : [`priority ${one.priority}`]),
    ].join(' · ')
    const state = `${one.paused ? 'paused · ' : ''}${look.word}${one.elapsedMs > 0 ? ` ${formatDuration(one.elapsedMs)}` : ''}`
    return (
      <Box key={`card-${one.id}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text wrap="truncate-end">
            <Text color={look.color}>{look.glyph} </Text>
            <Text bold>{one.project}</Text>
            <Text dimColor>{` ${one.branch === '' ? '' : `${one.branch} · `}#${one.id.slice(0, 4)}${one.isMe ? ' · this session' : ''}`}</Text>
          </Text>
          <Text color={isWaiting(one.state) ? 'warning' : one.state === 'working' ? 'claude' : undefined} dimColor={one.state === 'idle'}>
            {one.isHubOnly ? 'seen by mods-hub' : state}
          </Text>
        </Box>
        {one.task === '' ? null : <Text wrap="truncate-end">{`  ↳ ${one.task}`}</Text>}
        <Text dimColor wrap="truncate-end">{`  ${facts}`}</Text>
        {one.blocked === null ? null : <Text color="warning" wrap="truncate-end">{`  ⚠ ${one.blocked}`}</Text>}
        {one.lastError === null ? null : <Text color="error" wrap="truncate-end">{`  ✗ ${one.lastError}`}</Text>}
        {one.isHubOnly ? (
          <Text dimColor>{'  install mission-control in that session for live state and actions'}</Text>
        ) : (
          <Box key={`actions-${one.id}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key={`pause-${one.id}`} label={one.paused ? 'Resume' : 'Pause'} onPress={() => sendFromCard($, rt, one, one.paused ? 'resume' : 'pause')} />
            {one.state === 'idle' ? null : <Button key={`stop-${one.id}`} label="Stop turn" onPress={() => sendFromCard($, rt, one, 'stop')} />}
            <Button key={`note-${one.id}`} label="Note" onPress={() => changeView($, rt, current => ({ ...current, noteFor: current.noteFor === one.id ? null : one.id }))} />
            <Button key={`prio-${one.id}`} label={`Priority: ${one.priority}`} onPress={() => sendFromCard($, rt, one, 'priority', { priority: nextOf(PRIORITY_CYCLE, one.priority) })} />
          </Box>
        )}
        {view.noteFor !== one.id ? null : Input === undefined ? (
          <Text dimColor>{`  Send it with /mission note ${one.label} <text>`}</Text>
        ) : (
          <Box key={`note-box-${one.id}`} flexDirection="row" columnGap={1}>
            <Input key="note-input" label={`Note to ${one.label}: `} placeholder="runs there as your prompt when idle" submitLabel="send" autoFocus onSubmit={text => void submitNote($, rt, one, text)} />
            <Button key="note-cancel" plain label="cancel" onPress={() => changeView($, rt, current => ({ ...current, noteFor: null }))} />
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box key="mission" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text bold>Mission Control</Text>
        <Text dimColor wrap="truncate-end">{describeTotals(totals)}</Text>
      </Box>
      {totals.longWaits === 0 ? null : (
        <Text color="warning">{`⚠ ${totals.longWaits} session${totals.longWaits === 1 ? '' : 's'} waiting for you over ${formatDuration(rt.alertMs)}`}</Text>
      )}
      <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="sort" hotkey="s" label={`Sort: ${view.sort}`} onPress={() => changeView($, rt, current => ({ ...current, sort: nextOf(SORTS, current.sort) }))} />
        <Button key="filter" hotkey="f" label={`Show: ${view.filter}`} onPress={() => changeView($, rt, current => ({ ...current, filter: nextOf(FILTERS, current.filter) }))} />
        <Button key="refresh" hotkey="r" label="Refresh" onPress={() => refreshBoard($, rt)} />
      </Box>
      <Box key="cards" marginTop={1} flexDirection="column" gap={1}>
        {board.cards.length === 0 ? (
          <Text dimColor>
            {view.filter === 'all' ? 'No sessions yet: every session with mission-control installed shows up here within seconds.' : `No ${view.filter} sessions.`}
          </Text>
        ) : (
          board.cards.map(card)
        )}
      </Box>
    </Box>
  )
}

async function shareFact($: EngineInterface, name: string, value: string | boolean): Promise<void> {
  try {
    await $.mods.share({ name, value })
  } catch {
    // No hub: priority.json and the heartbeat carry it.
  }
}

// ── Turns, tools, dialogs ───────────────────────────────────────────────────────────────────────────

async function onTurnStart($: EngineInterface, rt: Runtime, turnId: string, text: string): Promise<void> {
  rt.turnId = turnId
  const now = await $.clock.now()
  rt.beat.turnStartedAt = now
  if (text.trim() !== '') {
    rt.beat.task = summarizeTask(redactText(text).text)
    rt.beat.lastError = null
  }
  rt.waitingTool = undefined
  await setState($, rt, 'working', null)
}

async function onTurnComplete($: EngineInterface, rt: Runtime, e: { agentId?: string; reason: string; usage?: Parameters<typeof costOf>[0] & { model: string } }): Promise<void> {
  const usage = e.usage
  if (usage !== undefined) {
    const costed = costOf(usage, usage.model)
    rt.beat.usd += costed.usd
    rt.beat.tokens += costed.tokens
    rt.beat.isUsdEstimate ||= !costed.isKnownModel
    const today = dayKey(await $.clock.now())
    rt.beat.spend = { day: today, usd: (rt.beat.spend.day === today ? rt.beat.spend.usd : 0) + costed.usd }
  }
  if (e.agentId !== undefined) {
    rt.agents.delete(e.agentId)
    rt.beat.subagents = rt.agents.size
    return
  }
  if (usage !== undefined) rt.beat.model = usage.model
  rt.beat.turns += 1
  rt.turnId = undefined
  rt.beat.turnStartedAt = null
  if (e.reason === 'error' || e.reason === 'refusal') rt.beat.lastError = { text: e.reason === 'error' ? 'the turn ended on an API error' : 'the model refused', at: await $.clock.now() }
  await settleState($, rt)
  $.clock.after(0, () => void deliverNotes($, rt))
}

async function onToolResult($: EngineInterface, rt: Runtime, tool: string, ran: { result?: unknown; text?: string; isError?: boolean }): Promise<void> {
  if (ran.isError === true) {
    rt.beat.lastError = { text: `${tool}: ${oneLine(redactText(resultText(ran)).text, 120)}`, at: await $.clock.now() }
  }
  if (isWaiting(rt.beat.state) && (rt.waitingTool === undefined || rt.waitingTool === tool)) await settleState($, rt)
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await startSession($, rt, e.surface ?? '')
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear goes on under a new id: the next heartbeat ends the old file and writes the new one.
    if (e.reason === 'clear') return next(e)
    for (const timer of rt.timers) timer.cancel()
    rt.beat.ended = true
    rt.beat.state = 'idle'
    await writeBeat($, rt, true)
    if (rt.beat.priority !== 'normal') await setPriority($, rt, 'normal')
    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => ({ text: await runMission($, rt, e.args, isPersonOrigin(e.origin)) }))

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin
    if (PERSON_ORIGINS.has(origin.kind)) {
      $.clock.after(0, () => void noteActivity($, rt))
      return next(e)
    }
    // Automatic prompts: another plugin's own (not one it sends as the person's words) and scheduled ones.
    const isAutomatic = (origin.kind === 'plugin' && origin.asUser !== true) || origin.kind === 'scheduled-trigger'
    if (rt.beat.paused && isAutomatic) return { drop: 'mission-control: this session is paused from Mission Control (/mission resume, or Resume on its card).' }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await onTurnStart($, rt, e.turnId, e.text).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await onTurnComplete($, rt, e).catch(() => undefined)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      rt.agents.add(spawned.agentId)
      rt.beat.subagents = rt.agents.size
    }
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    if (tool === 'AskUserQuestion') {
      const first = (e as unknown as { questions?: { question?: unknown }[] }).questions?.[0]?.question
      rt.waitingTool = tool
      await setState($, rt, 'waiting-input', `Question: ${oneLine(typeof first === 'string' ? first : 'Claude asked you something', 100)}`)
    }
    const ran = await next(e)
    await onToolResult($, rt, tool, ran).catch(() => undefined)
    return ran
  })

  // The permission dialog: waiting from the moment it is about to open until a hook beneath answers it or the tool goes on.
  on('classic.PermissionRequest', async ($, e, next) => {
    rt.waitingTool = e.tool_name
    await setState($, rt, 'waiting-permission', `Approve ${e.tool_name}${describeInput(e.tool_input)}`).catch(() => undefined)
    const answer = await next(e)
    if (answer.decision !== undefined) await settleState($, rt).catch(() => undefined)
    return answer
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'elicitation_dialog') await setState($, rt, 'waiting-input', 'An MCP server asks for input').catch(() => undefined)
    if (e.notification_type === 'permission_prompt' && rt.beat.state !== 'waiting-permission') await setState($, rt, 'waiting-permission', 'Approve a tool call').catch(() => undefined)
    return next(e)
  })

  // Its own pane (no hub). Whatever other mods draw in it (session-sync's section) comes back from next.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)
    let below: RenderElement | undefined
    try {
      below = await next(e)
    } catch {
      below = undefined
    }
    return (
      <Box flexDirection="column">
        {await drawBoard($, e, rt)}
        {below ?? null}
      </Box>
    )
  })

  // The Mission Control tab of the hub's Claude Mods panel.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBoard($, e, rt)}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts

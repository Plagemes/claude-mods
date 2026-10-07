import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { BrConnection, BrInteraction, BrLogEntry, BrMemberQa, BrMode, BrPhase, BrPrefs, BrSessionInfo } from '../types'
import { API, newerTs, nextCursor, parseJson, parseMessages, parseReply, reactionsOf, scrub, toSlack, tsAt } from './api'
import type { Inbound, Reply } from './api'
import { MAX_OPTIONS, matchAnswer, optionsFor, pendingFor, questionText, reactionAnswer, reactionHints } from './answers'
import type { Answer, Pending } from './answers'
import { helpText, parseCommand } from './commands'
import type { PhoneCommand } from './commands'
import { composeSection, noticeText, sessionsText, statusText, tagOf } from './format'
import { LEASE_RENEW_MS, backoff, isLeaseTaken, leaseAction, parseLease, pollInterval, remember } from './lease'
import type { Lease } from './lease'
import { emptyBook, memberPrompt, memberTrigger, takeQuota } from './members'
import type { RateBook } from './members'
import { ownMode } from './mode'
import { clean, oneLine } from './privacy'
import { LIVE_MS, defaultLabel, extractTag, isLive, route } from './routing'
import { channelIdOf, readSettings, userIdOf } from './settings'
import type { Settings } from './settings'

const NAME = 'slack-bridge'
const CHANNEL = 'slack'
const PLATFORM = 'Slack'
const PANE = 'slack-bridge'
const TAB_ORDER = 211
const TOOL_PREFIX = 'mcp__slack-bridge__'
const HEARTBEAT_MS = LEASE_RENEW_MS
const INBOX_MS = 3_000
const MAX_PAGES = 3
const REACTION_EVERY_POLLS = 3
const SESSION_FILE_FRESH_MS = 2 * 24 * 60 * 60_000
const LOG_KEEP = 150
const SENT_KEEP = 300
const DONE_KEEP = 400
const CONFIRM_TTL_MS = 30 * 60_000
const DEFAULT_ASK_MINUTES = 10
const MAX_ASK_MINUTES = 30
const APPROVAL_WAIT_MS = 10 * 60_000
const PACE_MS = 2_000
const RETRY_CONNECTION_MS = 60_000
const PENDING_WATCHED = 3
/** What the bridge posts to when there is no bot token: the incoming webhook has no channel id of its own. */
const WEBHOOK_CHAT = 'webhook'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const PHONE_CONTEXT =
  'This prompt was sent by the user from Slack (slack-bridge). Your final reply is relayed to their phone: ' +
  'end with a short plain-text summary of what you did or found.'

const EMPTY_CONNECTION: BrConnection = { phase: 'unconfigured', detail: '', bot: '', checkedAt: 0, isLeader: false }
const EMPTY_MODE: BrMode = { source: 'own', presence: 'here', isSilent: false, isNight: false, interaction: 'auto', canAsk: false }

const connectionAtom = atom({ plugin: 'slack-bridge', key: 'connection' } as const, EMPTY_CONNECTION)
const sessionsAtom = atom({ plugin: 'slack-bridge', key: 'sessions' } as const, [] as BrSessionInfo[])
const conversationAtom = atom({ plugin: 'slack-bridge', key: 'conversation' } as const, [] as BrLogEntry[])
const prefsAtom = atom({ plugin: 'slack-bridge', key: 'prefs' } as const, { paused: false, presence: 'auto', interaction: 'auto', confirmPrompts: true } as BrPrefs)
const modeAtom = atom({ plugin: 'slack-bridge', key: 'mode' } as const, EMPTY_MODE)
const membersAtom = atom({ plugin: 'slack-bridge', key: 'members' } as const, [] as BrMemberQa[])

/** config.json in the shared folder: what /slack owner and /slack channel learned. */
type SharedConfig = { ownerId?: string; channelId?: string }

/** One entry the leader dropped in a session's inbox. */
type InboxEntry = {
  seq: number
  key: string
  at: number
  kind: 'owner' | 'member' | 'reaction'
  /** The channel, and the message the entry is about (Slack `ts`). */
  chatId: string
  messageId: string
  author: string
  text: string
  /** A thread reply: the question it answers. */
  replyToId?: string
  emoji?: string
  targetId?: string
}

/** sessions/<id>.json: everything other sessions and the leader need to know of one session. Written by it alone. */
type SessionFile = { info: BrSessionInfo; sentIds: string[]; pending: Pending[] }

/** leader.json: the poller's own state, written by the leader alone. */
type LeaderState = {
  isReady: boolean
  /** The newest message `ts` read: the next poll asks for what is newer. */
  cursor: string
  seen: string[]
  book: RateBook
  /** People who wrote in the channel without being the owner: ids only, so setup can offer them. Never their words. */
  candidates: { id: string; at: number }[]
}

/** Everything this load of the plugin knows; one per session, passed to every top-level function. */
type Runtime = {
  settings: Settings
  dir: string
  me: string
  root: string
  realRoot: string
  project: string
  branch: string
  label: string
  isInteractive: boolean
  token: string
  webhook: string
  channel: string
  botUserId: string
  owner: string
  prefs: BrPrefs
  startedAt: number
  lastActiveAt: number
  typed: boolean
  state: 'idle' | 'working'
  turnId: string | undefined
  task: string
  turns: number
  costUsd: number
  file: SessionFile
  answers: Map<string, Answer>
  waiting: Set<string>
  lateAnswers: string[]
  phoneQueue: { text: string; chatId: string; messageId: string }[]
  phoneTurn: { chatId: string; messageId: string } | undefined
  tagged: string[]
  isSubmitting: boolean
  outbox: { level: string; source: string; title: string; body?: string; url?: string }[]
  isSending: boolean
  pendingSeq: number
  doneSeq: number
  doneIds: string[]
  isLeader: boolean
  leaseVerified: boolean
  leader: LeaderState | undefined
  pollTimer: Timer | undefined
  /** Bumped whenever a polling loop starts or stops, so a round that was in flight for an old loop ends quietly. */
  epoch: number
  backoffMs: number
  backoffUntil: number
  polls: number
  lastInboundAt: number
  timers: Timer[]
  canSleep: boolean
  isPaneOpen: boolean
  isConsuming: boolean
  lastConnectionTry: number
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const defaultPrefs = (settings: Settings): BrPrefs => ({ paused: false, presence: 'auto', interaction: settings.interaction, confirmPrompts: settings.confirmPrompts })

const emptyFile = (): SessionFile => ({
  info: { id: '', project: '', root: '', branch: '', label: '', lastSeen: 0, lastActiveAt: 0, state: 'idle', task: '', costUsd: 0, startedAt: 0, turns: 0, ended: false },
  sentIds: [],
  pending: [],
})

const emptyLeader = (): LeaderState => ({ isReady: false, cursor: '', seen: [], book: emptyBook(), candidates: [] })

const newRuntime = (settings: Settings): Runtime => ({
  settings,
  dir: '',
  me: '',
  root: '',
  realRoot: '',
  project: '',
  branch: '',
  label: '',
  isInteractive: false,
  token: settings.botToken,
  webhook: settings.webhookUrl,
  channel: settings.channelId,
  botUserId: '',
  owner: settings.ownerId,
  prefs: defaultPrefs(settings),
  startedAt: 0,
  lastActiveAt: 0,
  typed: false,
  state: 'idle',
  turnId: undefined,
  task: '',
  turns: 0,
  costUsd: 0,
  file: emptyFile(),
  answers: new Map(),
  waiting: new Set(),
  lateAnswers: [],
  phoneQueue: [],
  phoneTurn: undefined,
  tagged: [],
  isSubmitting: false,
  outbox: [],
  isSending: false,
  pendingSeq: 0,
  doneSeq: 0,
  doneIds: [],
  isLeader: false,
  leaseVerified: false,
  leader: undefined,
  pollTimer: undefined,
  epoch: 0,
  backoffMs: 0,
  backoffUntil: 0,
  polls: 0,
  lastInboundAt: 0,
  timers: [],
  canSleep: true,
  isPaneOpen: false,
  isConsuming: false,
  lastConnectionTry: 0,
})

const paths = {
  config: (rt: Runtime): string => `${rt.dir}/config.json`,
  prefs: (rt: Runtime): string => `${rt.dir}/prefs.json`,
  lease: (rt: Runtime): string => `${rt.dir}/lease.json`,
  leader: (rt: Runtime): string => `${rt.dir}/leader.json`,
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  inbox: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.jsonl`,
  done: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.done.json`,
  log: (rt: Runtime, id: string): string => `${rt.dir}/log/${id}.jsonl`,
  members: (rt: Runtime): string => `${rt.dir}/members.jsonl`,
  queue: (rt: Runtime): string => `${rt.root}/.claude/slack/queue.md`,
}

/** Whether a message can be posted: a bot token and a channel, or an incoming webhook. */
const canSend = (rt: Runtime): boolean => (rt.token !== '' && rt.channel !== '') || rt.webhook !== ''
/** Whether the mod can also read the channel, take commands and ask: bot mode with a channel and an owner. */
const canListen = (rt: Runtime): boolean => rt.token !== '' && rt.channel !== '' && rt.owner !== ''

/** The only chat the mod may ever read or write: the configured channel (or the webhook's own). */
const isAllowed = (rt: Runtime, chatId: string): boolean => chatId !== '' && (chatId === rt.channel || (chatId === WEBHOOK_CHAT && rt.webhook !== ''))
/** The bot's mention as it appears in a message. */
const mention = (rt: Runtime): string => (rt.botUserId === '' ? '' : `<@${rt.botUserId}>`)

async function readJsonFile($: EngineInterface, path: string): Promise<unknown> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? parseJson(text) : undefined
  } catch {
    return undefined
  }
}

async function writeJsonFile($: EngineInterface, path: string, value: unknown): Promise<void> {
  try {
    await $.fs.write(path, JSON.stringify(value, null, 1))
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function readLines($: EngineInterface, path: string): Promise<unknown[]> {
  try {
    const text = await $.fs.read(path)
    if (typeof text !== 'string') return []
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(parseJson)
      .filter(value => value !== undefined)
  } catch {
    return []
  }
}

async function writeLines($: EngineInterface, path: string, values: readonly unknown[]): Promise<void> {
  try {
    await $.fs.write(path, values.map(value => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : ''))
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
  }
}

function asSessionFile(value: unknown): SessionFile | null {
  if (!isRecord(value) || !isRecord(value.info) || typeof value.info.id !== 'string') return null
  return {
    info: { ...emptyFile().info, ...(value.info as Partial<BrSessionInfo>) },
    sentIds: Array.isArray(value.sentIds) ? (value.sentIds as string[]) : [],
    pending: Array.isArray(value.pending) ? (value.pending as Pending[]) : [],
  }
}

/** Every session file touched in `freshMs`; this session's own comes from memory. */
async function readSessionFiles($: EngineInterface, rt: Runtime, freshMs: number): Promise<SessionFile[]> {
  const now = await $.clock.now()
  const entries = await $.fs.list(paths.sessions(rt)).catch(() => [])
  const files: SessionFile[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs > 0 && now - entry.mtimeMs > freshMs) continue
    const id = entry.name.slice(0, -'.json'.length)
    const file = asSessionFile(id === rt.me ? rt.file : await readJsonFile($, paths.session(rt, id)))
    if (file !== null) files.push(file)
  }
  if (rt.me !== '' && !files.some(file => file.info.id === rt.me)) files.push(rt.file)
  return files
}

/** Writes this session's file with its current facts (the heartbeat other sessions and the leader read). */
async function saveSelf($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.me === '' || rt.dir === '') return
  const now = await $.clock.now()
  rt.file.info = {
    id: rt.me,
    project: rt.project,
    root: rt.root,
    branch: rt.branch,
    label: rt.label,
    lastSeen: now,
    lastActiveAt: rt.lastActiveAt,
    state: rt.state,
    task: rt.task,
    costUsd: rt.costUsd,
    startedAt: rt.startedAt,
    turns: rt.turns,
    ended: rt.file.info.ended,
  }
  rt.file.pending = rt.file.pending.filter(item => item.expiresAt > now)
  await writeJsonFile($, paths.session(rt, rt.me), rt.file)
}

async function appendLog($: EngineInterface, rt: Runtime, entry: Omit<BrLogEntry, 'at' | 'session'>): Promise<void> {
  const now = await $.clock.now()
  const text = clean(oneLine(entry.text, 400), { audience: 'owner', maxChars: 240 }).text
  const row: BrLogEntry = { at: now, session: rt.label === '' ? 'leader' : `#${rt.label}`, ...entry, text }
  const path = paths.log(rt, rt.me === '' ? 'unknown' : rt.me)
  const lines = (await readLines($, path)).slice(-(LOG_KEEP - 1))
  await writeLines($, path, [...lines, row])
  if (entry.dir === 'in' || entry.dir === 'out') await update($, conversationAtom, list => [...list, row].slice(-30))
}

/** Shared settings other sessions may have changed: owner, channel, prefs. */
async function loadShared($: EngineInterface, rt: Runtime): Promise<void> {
  const config = await readJsonFile($, paths.config(rt))
  const saved: SharedConfig = isRecord(config) ? config : {}
  rt.owner = rt.settings.ownerId !== '' ? rt.settings.ownerId : userIdOf(saved.ownerId)
  rt.channel = rt.settings.channelId !== '' ? rt.settings.channelId : channelIdOf(saved.channelId)
  const prefs = await readJsonFile($, paths.prefs(rt))
  const base = defaultPrefs(rt.settings)
  if (isRecord(prefs)) {
    rt.prefs = {
      paused: prefs.paused === true,
      presence: prefs.presence === 'away' || prefs.presence === 'here' ? prefs.presence : 'auto',
      interaction: prefs.interaction === 'on' || prefs.interaction === 'off' || prefs.interaction === 'auto' ? prefs.interaction : base.interaction,
      confirmPrompts: typeof prefs.confirmPrompts === 'boolean' ? prefs.confirmPrompts : base.confirmPrompts,
    }
  } else rt.prefs = base
}

async function savePrefs($: EngineInterface, rt: Runtime, change: (prefs: BrPrefs) => BrPrefs): Promise<BrPrefs> {
  rt.prefs = change(rt.prefs)
  await writeJsonFile($, paths.prefs(rt), rt.prefs)
  await update($, prefsAtom, () => rt.prefs)
  return rt.prefs
}

async function lastActivity($: EngineInterface, rt: Runtime): Promise<number> {
  const files = await readSessionFiles($, rt, LIVE_MS * 4)
  return Math.max(rt.lastActiveAt, ...files.map(file => file.info.lastActiveAt))
}

/** Presence, silent, night and Interaction: from mods-hub when it answers, else from this mod's own switches. */
async function currentMode($: EngineInterface, rt: Runtime): Promise<BrMode> {
  const hub = await hubMode($)
  if (hub !== undefined) {
    return { source: 'hub', presence: hub.presence, isSilent: hub.isSilent, isNight: hub.isNight, interaction: hub.interaction, canAsk: hub.canAsk }
  }
  const now = await $.clock.now()
  return ownMode({ prefs: rt.prefs, quietHours: rt.settings.quietHours, awayMinutes: rt.settings.awayMinutes, lastActiveAt: await lastActivity($, rt), now })
}

/** `silent`: null until switched off, 0 off, otherwise for that many minutes. */
type ModeChange = { presence?: 'auto' | 'away' | 'here'; interaction?: BrInteraction; isNightOn?: boolean; silent?: number | null }

/** Changes the global mode through the hub; without one, the nearest of this mod's own switches. */
async function changeMode($: EngineInterface, rt: Runtime, change: ModeChange): Promise<'hub' | 'own'> {
  try {
    if (change.presence !== undefined) await $.mods.setPresence({ presence: change.presence, reason: 'channel' })
    if (change.interaction !== undefined || change.isNightOn !== undefined || change.silent !== undefined) {
      await $.mods.setMode({
        ...(change.interaction !== undefined ? { interaction: change.interaction } : {}),
        ...(change.isNightOn !== undefined ? { isNightOn: change.isNightOn } : {}),
        ...(change.silent === undefined ? {} : change.silent === null ? { isSilent: true } : change.silent > 0 ? { silentMinutes: change.silent } : { isSilent: false }),
      })
    }
    return 'hub'
  } catch {
    await savePrefs($, rt, prefs => ({
      ...prefs,
      ...(change.presence !== undefined ? { presence: change.presence } : {}),
      ...(change.interaction !== undefined ? { interaction: change.interaction } : {}),
      ...(change.isNightOn !== undefined ? { interaction: change.isNightOn ? ('off' as const) : ('auto' as const) } : {}),
      ...(change.silent !== undefined ? { paused: change.silent !== 0 } : {}),
    }))
    return 'own'
  }
}

const modeLine = (mode: BrMode, prefs: BrPrefs): string =>
  `${mode.presence === 'away' ? 'away' : mode.presence === 'idle' ? 'idle' : 'at the keyboard'} · Interaction ${mode.interaction} (${mode.canAsk ? 'Claude may ask' : 'no questions'})` +
  `${mode.isSilent ? ' · silent' : ''}${mode.isNight ? ' · night' : ''}${prefs.paused ? ' · channel paused' : ''}${mode.source === 'own' ? ' · own settings (no hub)' : ''}`

// ── The Bot API over HTTP ────────────────────────────────────────────────────────────────────────

const failed = (error: string, status = 0): Reply => ({ ok: false, status, json: {}, error })

const query = (params: Record<string, unknown>): string =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')

/** One Web API call (GET for reads, POST with JSON for writes). Never throws: a transport error is `status: 0`, and the token never appears in a message. */
async function slCall($: EngineInterface, rt: Runtime, method: string, params: Record<string, unknown>, verb: 'GET' | 'POST' = 'POST'): Promise<Reply> {
  if (rt.token === '') return failed('no bot token')
  try {
    const response = await $.http.fetch(verb === 'GET' ? `${API}/${method}?${query(params)}` : `${API}/${method}`, {
      method: verb,
      headers: { Authorization: `Bearer ${rt.token}`, ...(verb === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      ...(verb === 'POST' ? { body: JSON.stringify(params) } : {}),
    })
    const retryAfter = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
    const reply = parseReply(response.status, response.text, retryAfter)
    return { ...reply, error: scrub(reply.error, rt.token) }
  } catch (error) {
    return failed(scrub(messageOf(error), rt.token, rt.webhook))
  }
}

const describeFailure = (reply: Reply): string =>
  reply.status === 0 ? `Slack unreachable (${oneLine(reply.error, 80)})` : `Slack said ${reply.error !== '' ? reply.error : reply.status}`

type SendInput = {
  chatId: string
  text: string
  kind: string
  /** Reactions to add to the message (Slack emoji names), so the owner can answer with one tap. */
  reactions?: readonly string[]
  audience?: 'owner' | 'member'
}

/**
 * Posts a text to the channel (or the webhook), after redaction (everyone in a team channel reads it, so the member
 * rules) and the length cap; remembers the message `ts` for reply routing. Resolves it, or '' when not sent.
 */
async function slSend($: EngineInterface, rt: Runtime, input: SendInput): Promise<string> {
  if (!canSend(rt) || !isAllowed(rt, input.chatId)) {
    await appendLog($, rt, { dir: 'drop', chatId: input.chatId, kind: input.kind, text: `not sent (chat not allowed or not set up): ${input.text}` })
    return ''
  }
  const text = clean(input.text, { audience: input.audience ?? 'member', maxChars: rt.settings.maxMessageChars, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text
  let id = ''
  let failure = ''
  if (rt.token !== '' && rt.channel !== '') {
    const reply = await slCall($, rt, 'chat.postMessage', { channel: rt.channel, text: toSlack(text), mrkdwn: true, unfurl_links: false, unfurl_media: false })
    if (reply.ok) id = typeof reply.json.ts === 'string' ? reply.json.ts : ''
    else {
      failure = describeFailure(reply)
      if (reply.status === 429) rt.backoffMs = backoff(rt.backoffMs, reply.retryAfter)
    }
  } else {
    try {
      const response = await $.http.fetch(rt.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: toSlack(text) }) })
      if (response.ok) id = WEBHOOK_CHAT
      else failure = `Slack said ${response.status}`
    } catch (error) {
      failure = `Slack unreachable (${oneLine(scrub(messageOf(error), rt.webhook), 80)})`
    }
  }
  if (id === '') {
    await appendLog($, rt, { dir: 'drop', chatId: input.chatId, kind: input.kind, text: `send failed: ${failure}` })
    return ''
  }
  if (id !== WEBHOOK_CHAT) {
    rt.file.sentIds = [...rt.file.sentIds, `${input.chatId}:${id}`].slice(-SENT_KEEP)
    for (const name of input.reactions ?? []) await slCall($, rt, 'reactions.add', { channel: rt.channel, timestamp: id, name })
  }
  await appendLog($, rt, { dir: 'out', chatId: input.chatId, kind: input.kind, text, who: 'bot' })
  return id
}

/** Where this project's updates go: the channel, or the webhook's. */
const projectChat = (rt: Runtime): string => (rt.token !== '' && rt.channel !== '' ? rt.channel : WEBHOOK_CHAT)

/** Remembers a question the owner can answer (by tapping or replying); the leader routes the answer by it. */
async function addPending($: EngineInterface, rt: Runtime, item: Omit<Pending, 'createdAt'>): Promise<Pending> {
  const pending: Pending = { ...item, createdAt: await $.clock.now() }
  rt.file.pending = [...rt.file.pending.filter(one => one.id !== pending.id), pending].slice(-20)
  await saveSelf($, rt)
  return pending
}

async function dropPending($: EngineInterface, rt: Runtime, id: string): Promise<void> {
  rt.file.pending = rt.file.pending.filter(one => one.id !== id)
  await saveSelf($, rt)
}

const newPendingId = (rt: Runtime): string => {
  rt.pendingSeq += 1
  return `${rt.me.replace(/[^\w]/g, '').slice(0, 8)}${rt.startedAt.toString(36).slice(-5)}${rt.pendingSeq}`
}

// ── The leader: one session polls Slack for all ───────────────────────────────────────────────

/** Renews, takes or follows the lease. A taken lease is trusted only once read back on the next beat. */
async function tickLease($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.isInteractive || rt.token === '' || rt.channel === '') return
  const now = await $.clock.now()
  const lease = parseLease(await readJsonFile($, paths.lease(rt)))
  const action = leaseAction(lease, rt.me, now)
  if (action === 'follow') {
    if (rt.isLeader) await stepDown($, rt)
    return
  }
  const wasMine = lease?.sessionId === rt.me
  const next: Lease = { sessionId: rt.me, heartbeatAt: now, since: wasMine && lease !== null ? lease.since : now }
  await writeJsonFile($, paths.lease(rt), next)
  if (action === 'renew' && rt.isLeader && !rt.leaseVerified) {
    rt.leaseVerified = true
    await startPolling($, rt)
  }
  if (action === 'take' || !rt.isLeader) {
    rt.isLeader = true
    rt.leaseVerified = action === 'renew'
    if (rt.leaseVerified) await startPolling($, rt)
  }
  await update($, connectionAtom, connection => ({ ...connection, isLeader: rt.isLeader }))
}

async function stepDown($: EngineInterface, rt: Runtime): Promise<void> {
  rt.isLeader = false
  rt.leaseVerified = false
  rt.epoch += 1
  rt.pollTimer?.cancel()
  rt.pollTimer = undefined
  await update($, connectionAtom, connection => ({ ...connection, isLeader: false }))
}

async function startPolling($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.pollTimer !== undefined) return
  const stored = await readJsonFile($, paths.leader(rt))
  rt.leader = { ...emptyLeader(), ...(isRecord(stored) ? (stored as Partial<LeaderState>) : {}) }
  rt.epoch += 1
  schedulePoll($, rt, 0)
}

function schedulePoll($: EngineInterface, rt: Runtime, ms: number): void {
  rt.pollTimer?.cancel()
  const epoch = rt.epoch
  rt.pollTimer = $.clock.after(ms, () => {
    rt.pollTimer = undefined
    void pollRound($, rt, epoch).catch(error => $.ui.log(`${NAME}: poll failed: ${messageOf(error)}`, { to: 'debug' }))
  })
}

/** One round of the leader: new messages, then the next round (paced by how busy the channel is). */
async function pollRound($: EngineInterface, rt: Runtime, epoch: number): Promise<void> {
  if (rt.epoch !== epoch || !rt.isLeader || !rt.leaseVerified) return
  const now = await $.clock.now()
  // A beat that came late (a suspended process) may find the lease taken: the new leader polls, never both.
  if (isLeaseTaken(parseLease(await readJsonFile($, paths.lease(rt))), rt.me, now)) return stepDown($, rt)
  let isBusy = false
  if (now >= rt.backoffUntil) isBusy = await pollChannel($, rt, epoch)
  if (rt.epoch !== epoch) return
  schedulePoll($, rt, Math.max(pollInterval({ baseSeconds: rt.settings.pollSeconds, isBusy }), rt.backoffUntil - (await $.clock.now())))
}

async function pollFailed($: EngineInterface, rt: Runtime, reply: Reply): Promise<void> {
  rt.backoffMs = backoff(rt.backoffMs, reply.retryAfter)
  rt.backoffUntil = (await $.clock.now()) + rt.backoffMs
  const detail =
    reply.error === 'invalid_auth' || reply.error === 'token_revoked' || reply.error === 'not_authed'
      ? 'Slack refused the token: check the bot token.'
      : reply.error === 'channel_not_found' || reply.error === 'not_in_channel'
        ? 'The bot cannot see the channel: invite it with /invite @yourbot.'
        : ''
  if (detail !== '') await update($, connectionAtom, connection => ({ ...connection, phase: 'error' as const, detail }))
}

/**
 * Reads what is new since the stored cursor (the newest `ts`). The first time it only notes where "now" is, so old
 * messages are never replayed. The cursor and the ids seen are saved before anything is handled: a crash loses a
 * message rather than running a prompt twice. Resolves whether the channel is busy (a question waits, a message came).
 */
async function pollChannel($: EngineInterface, rt: Runtime, epoch: number): Promise<boolean> {
  if (rt.token === '' || rt.channel === '') return false
  const leader = rt.leader ?? emptyLeader()
  rt.leader = leader
  const now = await $.clock.now()
  if (!leader.isReady) {
    const first = await slCall($, rt, 'conversations.history', { channel: rt.channel, limit: 1 }, 'GET')
    if (rt.epoch !== epoch) return false
    if (!first.ok) {
      await pollFailed($, rt, first)
      return false
    }
    const { newest } = parseMessages(first.json, rt.botUserId)
    leader.cursor = newest !== '' ? newest : tsAt(now)
    leader.isReady = true
    await writeJsonFile($, paths.leader(rt), leader)
    return false
  }
  const found: Inbound[] = []
  let newest = leader.cursor
  let page = ''
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const reply = await slCall($, rt, 'conversations.history', { channel: rt.channel, oldest: leader.cursor, limit: 100, ...(page !== '' ? { cursor: page } : {}) }, 'GET')
    // No longer the leader while the call was out: leave what it returned for whoever leads now.
    if (rt.epoch !== epoch) return false
    if (!reply.ok) {
      if (n === 0) {
        await pollFailed($, rt, reply)
        return false
      }
      break
    }
    const parsed = parseMessages(reply.json, rt.botUserId)
    found.push(...parsed.messages)
    if (parsed.newest !== '' && newerTs(parsed.newest, newest)) newest = parsed.newest
    page = nextCursor(reply.json)
    if (page === '') break
  }
  rt.backoffMs = 0
  const fresh = found.filter(one => !leader.seen.includes(one.key)).sort((a, b) => (a.ts === b.ts ? 0 : newerTs(a.ts, b.ts) ? 1 : -1))
  leader.cursor = newest
  leader.seen = remember(leader.seen, fresh.map(one => one.key))
  learn(rt, fresh, now)
  await writeJsonFile($, paths.leader(rt), leader)
  const files = await readSessionFiles($, rt, SESSION_FILE_FRESH_MS)
  for (const up of fresh) {
    try {
      await handleInbound($, rt, files, up)
    } catch (error) {
      $.ui.log(`${NAME}: could not handle a message: ${messageOf(error)}`, { to: 'debug' })
    }
  }
  rt.polls += 1
  if (rt.polls % REACTION_EVERY_POLLS === 0) await pollPending($, rt, files)
  if (fresh.length > 0) rt.lastInboundAt = now
  const isAway = (await currentMode($, rt)).presence === 'away'
  return fresh.length > 0 || isAway || files.some(file => file.pending.length > 0) || now - rt.lastInboundAt < 5 * 60_000
}

/** Notes who wrote in the channel without being the owner (ids only), so setup can offer them. */
function learn(rt: Runtime, updates: readonly Inbound[], now: number): void {
  const leader = rt.leader ?? emptyLeader()
  for (const up of updates) {
    if (up.userId === rt.owner) continue
    leader.candidates = [...leader.candidates.filter(one => one.id !== up.userId), { id: up.userId, at: now }].slice(-8)
  }
}

/** Handles one message: the owner's, or a member's. */
async function handleInbound($: EngineInterface, rt: Runtime, files: SessionFile[], up: Inbound): Promise<void> {
  const now = await $.clock.now()
  if (up.text.trim() === '') return
  if (rt.owner !== '' && up.userId === rt.owner) return handleOwnerRow($, rt, files, up, now)
  return handleMemberRow($, rt, files, up, now)
}

/**
 * Reactions and thread replies on the questions sessions wait on: the owner's ✅ ❌ 👍 and number keys, and their
 * replies in the thread, go to the session that asked. Slack's reaction reads are rate limited, so only the newest few.
 */
async function pollPending($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  for (const file of files) {
    for (const item of file.pending.filter(one => one.expiresAt > now && one.messageId !== '').slice(-PENDING_WATCHED)) {
      const reactions = await slCall($, rt, 'reactions.get', { channel: rt.channel, timestamp: item.messageId }, 'GET')
      for (const one of reactionsOf(reactions.json)) {
        const key = `r:${item.messageId}:${one.name}`
        if (!one.users.includes(rt.owner) || leader.seen.includes(key)) continue
        leader.seen = remember(leader.seen, [key])
        await deliver($, rt, file.info.id, { key, at: now, kind: 'reaction', chatId: rt.channel, messageId: item.messageId, author: rt.owner, text: '', emoji: one.name, targetId: item.messageId })
      }
      const thread = await slCall($, rt, 'conversations.replies', { channel: rt.channel, ts: item.messageId, oldest: item.messageId, limit: 20 }, 'GET')
      for (const reply of parseMessages(thread.json, rt.botUserId).messages) {
        if (reply.userId !== rt.owner || reply.ts === item.messageId || leader.seen.includes(reply.key)) continue
        leader.seen = remember(leader.seen, [reply.key])
        await deliver($, rt, file.info.id, { key: reply.key, at: now, kind: 'owner', chatId: rt.channel, messageId: reply.ts, author: rt.owner, text: reply.text, replyToId: item.messageId })
      }
    }
  }
  await writeJsonFile($, paths.leader(rt), leader)
}

const sentIndex = (files: readonly SessionFile[]): Map<string, string> => {
  const index = new Map<string, string>()
  for (const file of files) for (const id of file.sentIds) index.set(id, file.info.id)
  return index
}

const withoutMention = (text: string, botMention: string): string => (botMention === '' ? text.trim() : text.split(botMention).join('').trim())

/** The owner's message: a global command the leader answers, an answer to an open question, or a prompt for a session. */
async function handleOwnerRow($: EngineInterface, rt: Runtime, files: SessionFile[], up: Inbound, now: number): Promise<void> {
  const text = withoutMention(up.text, mention(rt))
  const parsed = parseCommand(text, rt.settings.pin)
  const isTagged = extractTag(text).tag !== undefined
  const reply = (body: string): Promise<string> => slSend($, rt, { chatId: rt.channel, kind: 'command', text: body })
  const isGlobal = !(isTagged && parsed.command.kind === 'status')
  if (isGlobal && (await handleGlobalCommand($, rt, files, up, parsed.command, parsed.needsPin && !parsed.hasPin, reply))) return
  const sessions = files.map(file => file.info)
  const kind = parsed.command.kind
  // An unquoted "2" or "sì" answers the newest open question, whichever session asked it.
  const mayAnswer = !isTagged && (kind === 'prompt' || kind === 'approve' || kind === 'reject')
  const waiting = mayAnswer
    ? files
        .flatMap(file => file.pending.filter(item => item.expiresAt > now).map(item => ({ item, id: file.info.id })))
        .filter(({ id }) => sessions.some(session => session.id === id && isLive(session, now)))
        .sort((a, b) => b.item.createdAt - a.item.createdAt)[0]
    : undefined
  const routed = waiting !== undefined ? { sessionId: waiting.id, text, reason: 'reply' as const } : route({ text, now }, { sessions, sentBy: sentIndex(files) })
  if (routed.sessionId === null) {
    const why = routed.reason === 'unknown-tag' ? `No live session is tagged ${routed.detail}. Send *sessions* to list them.` : 'No Claude Code session is running right now.'
    await reply(`🤖 ${why}`)
    return
  }
  await deliver($, rt, routed.sessionId, { key: up.key, at: now, kind: 'owner', chatId: rt.channel, messageId: up.ts, author: up.userId, text: routed.text })
}

/** A member's message: only when meant for Claude (mention or trigger word), within the limits. */
async function handleMemberRow($: EngineInterface, rt: Runtime, files: SessionFile[], up: Inbound, now: number): Promise<void> {
  const trigger = memberTrigger(up.text, { triggers: rt.settings.memberTriggers, botMention: mention(rt), isReplyToBot: false })
  if (!trigger.isTriggered) return
  const leader = rt.leader ?? emptyLeader()
  const quota = takeQuota(leader.book, up.userId, now, new Date(now).toISOString().slice(0, 10), { perTenMinutes: rt.settings.memberRate, dailyCap: rt.settings.memberDailyCap })
  leader.book = quota.book
  if (!quota.isAllowed) {
    await appendMemberLog($, rt, { at: now, member: up.userId, question: trigger.text, answer: '', outcome: 'limited' })
    return
  }
  const target = files
    .map(file => file.info)
    .filter(session => isLive(session, now))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  if (target === undefined) {
    await slSend($, rt, { chatId: rt.channel, kind: 'member', audience: 'member', text: `<@${up.userId}> 🤖 Claude is not running right now; the owner will see your message.` })
    return
  }
  await deliver($, rt, target.id, { key: up.key, at: now, kind: 'member', chatId: rt.channel, messageId: up.ts, author: up.userId, text: trigger.text })
}

/** Appends one entry to a session's inbox (written by the leader alone), trimming what it has consumed. */
async function deliver($: EngineInterface, rt: Runtime, sessionId: string, entry: Omit<InboxEntry, 'seq'>): Promise<void> {
  const done = await readJsonFile($, paths.done(rt, sessionId))
  const doneSeq = isRecord(done) && typeof done.seq === 'number' ? done.seq : 0
  const lines = (await readLines($, paths.inbox(rt, sessionId))).filter(isRecord) as unknown as InboxEntry[]
  if (lines.some(line => line.key === entry.key)) return
  const kept = lines.filter(line => line.seq > doneSeq)
  const seq = Math.max(doneSeq, ...lines.map(line => line.seq)) + 1
  await writeLines($, paths.inbox(rt, sessionId), [...kept, { ...entry, seq }])
  if (sessionId === rt.me) void consumeInbox($, rt)
}

/**
 * Commands about every session, which the leader answers itself (help, status, sessions, cost, pause, presence,
 * Interaction, silent, night, stop all). In a project group they only cover that project.
 */
async function handleGlobalCommand(
  $: EngineInterface,
  rt: Runtime,
  files: SessionFile[],
  up: Inbound,
  command: PhoneCommand,
  isMissingPin: boolean,
  reply: (text: string) => Promise<string>,
): Promise<boolean> {
  const now = await $.clock.now()
  const live = files.map(file => file.info).filter(session => isLive(session, now))
  switch (command.kind) {
    case 'help':
      await reply(helpText(PLATFORM))
      return true
    case 'status': {
      const mode = await currentMode($, rt)
      await reply(statusText(live, now, `\n\n_${modeLine(mode, rt.prefs)}_`))
      return true
    }
    case 'sessions':
      await reply(sessionsText(live, now))
      return true
    case 'cost':
      await reply('🤖 Costs are not shown in a team channel: look at the terminal, or use a private bridge.')
      return true
    case 'pause':
    case 'resume':
      await savePrefs($, rt, prefs => ({ ...prefs, paused: command.kind === 'pause' }))
      await reply(command.kind === 'pause' ? '⏸ This channel is muted (critical messages still come). Send *resume* to go on.' : '▶️ Updates resumed.')
      return true
    case 'away':
    case 'here': {
      const via = await changeMode($, rt, { presence: command.kind })
      await reply(`${command.kind === 'away' ? '🚶 Marked away: updates come here.' : '💻 Marked at the keyboard: only critical updates come here.'}${via === 'own' ? ' _(no hub: own setting)_' : ''}`)
      return true
    }
    case 'interact': {
      await changeMode($, rt, { interaction: command.value })
      await reply(
        command.value === 'off'
          ? '🔕 Interaction off: Claude will not ask you anything; it proceeds on its best judgement.'
          : command.value === 'on'
            ? '💬 Interaction on: Claude may ask you things and request approvals here (not at night).'
            : '💬 Interaction auto: Claude asks only while you are away.',
      )
      return true
    }
    case 'night':
      await changeMode($, rt, { isNightOn: command.isOn })
      await reply(command.isOn ? '🌙 Night mode on: only critical messages go out during quiet hours, and no questions.' : '☀️ Night mode off.')
      return true
    case 'silent':
      await changeMode($, rt, { silent: command.minutes })
      await reply(
        command.minutes === null
          ? '🤫 Silent until you switch it off (send "silent off"): other mods stay quiet; critical messages still come.'
          : command.minutes > 0
            ? `🤫 Silent for ${command.minutes} minutes: other mods stay quiet; critical messages still come.`
            : '🔔 Silent mode off.',
      )
      return true
    case 'stopAll': {
      if (isMissingPin) {
        await reply('🔒 STOP ALL needs your PIN: send "stop all <pin>".')
        return true
      }
      for (const session of live) await deliver($, rt, session.id, { key: `${up.key}:${session.id}`, at: now, kind: 'owner', chatId: rt.channel, messageId: up.ts, author: up.userId, text: 'stop' })
      // The automatic work (autopilot, task-queue, night-shift) is the hub's to stop, in every session.
      const isHubStopped = await hubStop($, { action: 'stop', scope: 'all', reason: 'stop all from Slack', by: 'owner via slack' })
      await reply(`⏹ Stopping ${plural(live.length, 'session')}${isHubStopped ? ' and the automatic work' : ''}.`)
      return true
    }
    case 'slash':
      await reply('🤖 Slash commands are not run from Slack. Send plain text, or *help*.')
      return true
    default:
      return false
  }
}

async function appendMemberLog($: EngineInterface, rt: Runtime, qa: BrMemberQa): Promise<void> {
  const rows = (await readLines($, paths.members(rt))).slice(-39)
  await writeLines($, paths.members(rt), [...rows, { ...qa, question: clean(oneLine(qa.question, 200), { audience: 'member', maxChars: 200 }).text }])
}

// ── Every session: its inbox ─────────────────────────────────────────────────────────────────────

/** Reads this session's inbox and handles each new entry once (by seq and key), in order. */
async function consumeInbox($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isConsuming || rt.me === '' || rt.dir === '') return
  rt.isConsuming = true
  try {
    const entries = ((await readLines($, paths.inbox(rt, rt.me))).filter(isRecord) as unknown as InboxEntry[]).sort((a, b) => a.seq - b.seq)
    for (const entry of entries) {
      if (rt.doneIds.includes(entry.key)) continue
      rt.doneIds = [...rt.doneIds, entry.key].slice(-DONE_KEEP)
      rt.doneSeq = Math.max(rt.doneSeq, entry.seq)
      await writeJsonFile($, paths.done(rt, rt.me), { seq: rt.doneSeq, ids: rt.doneIds })
      try {
        await handleEntry($, rt, entry)
      } catch (error) {
        $.ui.log(`${NAME}: could not handle a Slack message: ${messageOf(error)}`, { to: 'debug' })
      }
    }
  } finally {
    rt.isConsuming = false
  }
}

async function handleEntry($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const who = entry.kind === 'member' ? 'member' : 'owner'
  await appendLog($, rt, { dir: 'in', chatId: entry.chatId, kind: entry.kind, text: entry.kind === 'reaction' ? `reacted ${entry.emoji ?? ''}` : entry.text, who })
  if (entry.kind !== 'reaction') {
    const shown = clean(entry.text, { audience: who === 'owner' ? 'owner' : 'member', maxChars: 400 }).text
    await hubPublish($, { topic: 'channel.inbound', data: { channel: CHANNEL, from: entry.author, text: shown, isOwner: who === 'owner' } })
  }
  switch (entry.kind) {
    case 'reaction':
      return handleReactionEntry($, rt, entry)
    case 'member':
      return answerMember($, rt, entry)
    case 'owner':
      return handleOwner($, rt, entry)
  }
}

const replyTo = (entry: InboxEntry, text: string): SendInput => ({ chatId: entry.chatId, kind: 'reply', text })

/** The owner reacted to a question: settle it if the emoji means an answer. */
async function handleReactionEntry($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const pending = rt.file.pending.find(item => item.messageId === entry.targetId)
  if (pending === undefined) return
  const answer = reactionAnswer(pending, entry.emoji ?? '')
  if (answer !== null) await resolvePending($, rt, pending, answer, entry)
}

/** An owner's message: an answer to a pending question, a command, or a prompt for Claude. */
async function handleOwner($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const now = await $.clock.now()
  const parsed = parseCommand(entry.text, rt.settings.pin)
  const { command } = parsed
  const pending = pendingFor(rt.file.pending, entry.chatId, entry.replyToId, now)
  if (pending !== undefined && (command.kind === 'prompt' || command.kind === 'approve' || command.kind === 'reject')) {
    const answer = matchAnswer(pending, { text: entry.text })
    // A confirmation or a permission takes yes / no only: other words are a new request.
    if (answer !== null && (pending.kind === 'ask' || answer.verdict !== undefined)) return resolvePending($, rt, pending, answer, entry)
    if (pending.kind === 'confirm') {
      await dropPending($, rt, pending.id)
    }
  }
  switch (command.kind) {
    case 'stop':
      if (rt.state === 'working' && rt.turnId !== undefined) {
        await $.turn.abort({ turnId: rt.turnId }).catch(() => undefined)
        await slSend($, rt, replyTo(entry, `⏹ Stopped #${rt.label}.`))
      } else {
        await slSend($, rt, replyTo(entry, `#${rt.label} is idle: nothing to stop.`))
      }
      return
    case 'queue':
      return queueTask($, rt, entry, command.task)
    case 'approve':
    case 'reject':
      await slSend($, rt, replyTo(entry, 'Nothing is waiting for your approval.'))
      return
    case 'prompt':
      break
    default:
      // A command the leader answers for every session; routed here when tagged: answer for this one.
      await slSend($, rt, replyTo(entry, statusText([rt.file.info], now, '')))
      return
  }
  const text = command.text
  if (text.trim() === '') return
  const mode = await currentMode($, rt)
  if (rt.prefs.confirmPrompts && mode.canAsk) {
    const id = newPendingId(rt)
    const options = ['Run', 'Cancel']
    const messageId = await slSend($, rt, { ...replyTo(entry, `▶️ Run this on *#${rt.label}* (${rt.project})?\n«${oneLine(text, 300)}»\n_Reply yes / no, or react ✅ / ❌._`), reactions: reactionHints(options) })
    if (messageId !== '') await addPending($, rt, { id, kind: 'confirm', question: text, options, chatId: entry.chatId, messageId, expiresAt: now + CONFIRM_TTL_MS, payload: text })
    return
  }
  await submitPhonePrompt($, rt, { text, chatId: entry.chatId, messageId: entry.messageId })
}

/** The owner answered a pending item (by tapping or replying): settle it the way its kind asks. */
async function resolvePending($: EngineInterface, rt: Runtime, pending: Pending, answer: Answer, entry: InboxEntry): Promise<void> {
  await dropPending($, rt, pending.id)
  switch (pending.kind) {
    case 'ask':
      if (rt.waiting.has(pending.id)) rt.answers.set(pending.id, answer)
      else rt.lateAnswers.push(`The user answered your earlier Slack question «${oneLine(pending.question, 160)}»: ${answer.text}`)
      await slSend($, rt, replyTo(entry, `✅ Got it: «${oneLine(answer.text, 80)}» → #${rt.label}`))
      await drainPhoneQueue($, rt)
      return
    case 'permission':
      rt.answers.set(pending.id, answer)
      return
    case 'confirm':
      if (answer.verdict === 'approve') await submitPhonePrompt($, rt, { text: pending.payload ?? pending.question, chatId: pending.chatId, messageId: pending.messageId })
      else await slSend($, rt, replyTo(entry, '👌 Cancelled.'))
      return
  }
}

/** Runs a phone prompt as the owner's words when Claude is idle; otherwise it waits its turn. */
async function submitPhonePrompt($: EngineInterface, rt: Runtime, item: { text: string; chatId: string; messageId: string }): Promise<void> {
  rt.phoneQueue.push(item)
  if (rt.state === 'working' || rt.isSubmitting) {
    await slSend($, rt, { chatId: item.chatId, kind: 'reply', text: `⏳ Queued for #${rt.label}: Claude is busy and will start it next.` })
    return
  }
  await drainPhoneQueue($, rt)
}

async function drainPhoneQueue($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.state === 'working' || rt.isSubmitting) return
  const late = rt.lateAnswers.shift()
  if (late !== undefined) {
    rt.isSubmitting = true
    try {
      await $.prompt.submit({ text: late })
    } finally {
      rt.isSubmitting = false
    }
    return
  }
  const item = rt.phoneQueue.shift()
  if (item === undefined) return
  rt.isSubmitting = true
  try {
    rt.tagged.push(item.text)
    rt.phoneTurn = { chatId: item.chatId, messageId: item.messageId }
    const submitted = await $.prompt.submit({ text: item.text, asUser: true })
    if (submitted.drop !== undefined) {
      rt.phoneTurn = undefined
      await slSend($, rt, { chatId: item.chatId, kind: 'reply', text: `❌ Not run: ${oneLine(submitted.drop, 200)}` })
    } else {
      void slCall($, rt, 'reactions.add', { channel: item.chatId, timestamp: item.messageId, name: 'eyes' })
    }
  } catch (error) {
    rt.phoneTurn = undefined
    await slSend($, rt, { chatId: item.chatId, kind: 'reply', text: `❌ Could not run it: ${oneLine(messageOf(error), 200)}` })
  } finally {
    rt.isSubmitting = false
  }
}

/** `queue <task>`: into task-queue's /queue when that mod is installed, else a Markdown list in the project. */
async function queueTask($: EngineInterface, rt: Runtime, entry: InboxEntry, task: string): Promise<void> {
  const commands = await $.command.list().catch(() => [])
  if (commands.some(command => command.name === 'queue')) {
    const ran = await $.command.run({ command: 'queue', args: task }).catch(() => undefined)
    await slSend($, rt, replyTo(entry, ran === undefined ? '❌ The queue command failed.' : `✅ Queued${ran.text !== undefined && ran.text !== '' ? `: ${oneLine(ran.text, 300)}` : '.'}`))
    return
  }
  const path = paths.queue(rt)
  const before = await $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '# Tasks queued from Slack\n\n')
  await $.fs.write(path, `${before.trimEnd()}\n- [ ] ${oneLine(task, 500)} _(${new Date(await $.clock.now()).toISOString().slice(0, 10)})_\n`)
  await slSend($, rt, replyTo(entry, `📝 Saved to .claude/slack/queue.md for #${rt.label}. (Install task-queue to run queued tasks automatically.)`))
}

/** A member's question: answered in a few redacted lines by a tool-less fork of this session. */
async function answerMember($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const now = await $.clock.now()
  const forked = await $.model.fork({ prompt: memberPrompt(entry.text, entry.author, PLATFORM, rt.settings.shareCodeWithMembers) })
  let answer = forked.isAnswered ? forked.text : ''
  if (answer === '' && !forked.isAnswered && forked.reason === 'nothing-to-fork') {
    const done = await $.model.complete({
      model: 'haiku',
      prompt: `${memberPrompt(entry.text, entry.author, PLATFORM, rt.settings.shareCodeWithMembers)}\nContext: project ${rt.project}, branch ${rt.branch}, current state ${rt.state}${rt.task !== '' ? `, working on: ${rt.task}` : ''}.`,
      maxTokens: 400,
      timeoutMs: 30_000,
    })
    answer = done.isAnswered ? done.text : ''
  }
  const text = answer === '' ? `<@${entry.author}> 🤖 I could not answer right now.` : `<@${entry.author}> 🤖 ${answer}`
  await slSend($, rt, { ...replyTo(entry, text), kind: 'member', audience: 'member' })
  await appendMemberLog($, rt, { at: now, member: entry.author, question: entry.text, answer: text, outcome: answer === '' ? 'failed' : 'answered' })
}

// ── What the hub delivers, and Claude's tools ────────────────────────────────────────────────────

/** The hub's notice, as a message to this project's chat; muted channels keep only critical ones. */
async function sendNotice($: EngineInterface, rt: Runtime, notice: Runtime['outbox'][number]): Promise<void> {
  if (!canSend(rt)) return
  if (rt.prefs.paused && notice.level !== 'critical') {
    await appendLog($, rt, { dir: 'drop', chatId: '', kind: 'notice', text: `muted: ${notice.title}` })
    return
  }
  await slSend($, rt, { chatId: projectChat(rt), kind: 'notice', text: noticeText(notice, tagOf({ label: rt.label, project: rt.project })) })
}

/** Sends the queued notices one after the other, so they keep their order. */
async function flushOutbox($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isSending || rt.dir === '') return
  rt.isSending = true
  try {
    for (let notice = rt.outbox.shift(); notice !== undefined; notice = rt.outbox.shift()) await sendNotice($, rt, notice)
  } finally {
    rt.isSending = false
  }
}

const TOOL_SPECS = [
  {
    name: 'notify',
    description:
      'Post a short message to the team Slack channel. Use it when a long job finished or failed, or something needs the ' +
      "team's attention; never for routine progress. level: info, success (default), warning, error or critical (act now). " +
      "The user's routing decides whether it is posted; the result says. Everyone in the channel reads it: no secrets, " +
      'no private details. Secrets are masked and the text is capped.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message, a few lines at most.' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error', 'critical'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask',
    description:
      'Ask the owner a question in the Slack channel and wait for their answer (up to timeoutMinutes, default 10). Use it only ' +
      'when you are blocked on a decision only they can make. options (2-9) are numbered; they answer with a number, the text, ' +
      'or a reaction (✅ ❌ for yes/no). When interaction is off (night, silent or away-only mode), or Slack is push-only, it ' +
      'returns at once: then proceed with your best judgement and state the assumption. On timeout, a later answer arrives as a message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: MAX_OPTIONS },
        timeoutMinutes: { type: 'number', minimum: 1, maximum: MAX_ASK_MINUTES },
      },
      required: ['question'],
    },
  },
  {
    name: 'open_panel',
    description: 'Open the Slack panel (connection, sessions, conversation) for the user.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

async function registerTools($: EngineInterface): Promise<void> {
  for (const spec of TOOL_SPECS) {
    try {
      await $.tool.register({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema as unknown as Record<string, unknown> })
    } catch (error) {
      $.ui.log(`${NAME}: could not register ${spec.name}: ${messageOf(error)}`, { to: 'debug' })
    }
  }
}

const LEVELS: readonly string[] = ['info', 'success', 'warning', 'error', 'critical']

/** Claude's notify: through the hub, which routes team news by level and the person's settings; with no hub, by this mod's own switches. */
async function toolNotify($: EngineInterface, rt: Runtime, input: Record<string, unknown>): Promise<string> {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text === '') return 'Nothing sent: text is empty.'
  if (!canSend(rt)) return 'Not sent: Slack is not set up (/slack setup).'
  const level = typeof input.level === 'string' && LEVELS.includes(input.level) ? input.level : 'success'
  const body = text.length > 200 ? { body: text.slice(0, 2_000) } : {}
  try {
    const routed = await $.mods.notify({ level: level as 'info', title: oneLine(text, 200), ...body, audience: 'team' })
    if (routed.targets.includes(CHANNEL)) return 'Posted to the Slack channel.'
    return routed.held ? `Held until later (${routed.reason ?? 'night'}).` : `Not posted to Slack: ${routed.reason ?? "the user's routing keeps it on the terminal"}.`
  } catch {
    if (rt.settings.notifyMode === 'off') return 'Not sent: notifications are off.'
    if (rt.prefs.paused && level !== 'critical') return 'Not sent: this channel is paused.'
    const sent = await slSend($, rt, { chatId: projectChat(rt), kind: 'notify', text: noticeText({ level, source: NAME, title: oneLine(text, 200), ...body }, tagOf({ label: rt.label, project: rt.project })) })
    return sent === '' ? 'Not sent: Slack refused it (see /slack status).' : 'Posted to the Slack channel.'
  }
}

/**
 * The ask tool. With interaction off, or without a way to read the answer, it returns at once. Otherwise it posts the
 * question (with ✅ ❌ or number reactions to tap) and waits for the answer, pacing with a host `sleep` (a `$` call in flight
 * costs the hook no budget); where no `sleep` exists it waits only as long as the budget allows and returns a ticket.
 */
async function toolAsk($: EngineInterface, rt: Runtime, input: Record<string, unknown>, budgetLeft: () => number, signal: AbortSignal): Promise<string> {
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  if (question === '') return 'Not asked: the question is empty.'
  if (!canListen(rt)) return 'The owner cannot be reached through Slack here (it needs a bot token, a channel and an owner). Proceed with your best judgement and state your assumption.'
  const now = await $.clock.now()
  const mode = await currentMode($, rt)
  if (!mode.canAsk) {
    return (
      `unavailable: the user's Interaction is ${mode.interaction}${mode.isNight ? ' and it is night' : ''}, so they will not answer now. Proceed with your best ` +
      'judgement and state the assumption you made, or continue with other work.'
    )
  }
  const options = optionsFor(Array.isArray(input.options) ? input.options.map(String) : undefined)
  const minutesWanted = Math.min(MAX_ASK_MINUTES, Math.max(1, Number(input.timeoutMinutes) || DEFAULT_ASK_MINUTES))
  const chatId = projectChat(rt)
  const id = newPendingId(rt)
  const messageId = await slSend($, rt, { chatId, kind: 'ask', text: questionText(question, options, tagOf({ label: rt.label, project: rt.project })), reactions: reactionHints(options) })
  if (messageId === '') return 'The question could not be posted (Slack refused it). Proceed with your best judgement and state your assumption.'
  await addPending($, rt, { id, kind: 'ask', question, options, chatId, messageId, expiresAt: now + 24 * 60 * 60_000 })
  rt.waiting.add(id)
  try {
    const answer = await waitForAnswer($, rt, id, now + minutesWanted * 60_000, budgetLeft, signal)
    if (answer !== undefined) return `The user answered on Slack: ${answer.text}${answer.choice !== undefined ? ` (option ${answer.choice + 1})` : ''}`
    return (
      `No answer yet (ticket ${id}). The question stays open in the channel; if they answer later, the answer arrives as a ` +
      'message from the slack-bridge plugin. Meanwhile proceed with your best judgement and state your assumption.'
    )
  } finally {
    rt.waiting.delete(id)
  }
}

async function waitForAnswer(
  $: EngineInterface,
  rt: Runtime,
  id: string,
  deadline: number,
  budgetLeft: () => number,
  signal: AbortSignal,
  shouldStop: () => boolean = () => false,
): Promise<Answer | undefined> {
  for (;;) {
    const answer = rt.answers.get(id)
    if (answer !== undefined) {
      rt.answers.delete(id)
      return answer
    }
    if (signal.aborted || shouldStop() || (await $.clock.now()) >= deadline) return undefined
    await consumeInbox($, rt)
    if (rt.answers.has(id)) continue
    if (rt.canSleep) {
      const slept = await $.process.run(['sleep', String(PACE_MS / 1000)], { timeoutMs: PACE_MS * 3 }).catch(() => undefined)
      if (slept === undefined || slept.exitCode !== 0) rt.canSleep = false
      continue
    }
    if (budgetLeft() < PACE_MS + 1_500) return undefined
    await $.clock.sleep(1_000, { signal }).catch(() => undefined)
  }
}

// ── Permission prompts while away ────────────────────────────────────────────────────────────────

const describeInput = (input: unknown): string => {
  if (!isRecord(input)) return ''
  const detail = [input.command, input.file_path, input.url, input.pattern, input.description].find((value): value is string => typeof value === 'string' && value !== '')
  return detail === undefined ? '' : oneLine(detail, 120)
}

/**
 * A permission dialog opened while the owner is away: with Interaction on and remote approvals allowed, ask in the
 * channel (reply yes / no, or react ✅ / ❌) and answer the dialog through the PermissionRequest decision.
 */
async function remotePermission(
  $: EngineInterface,
  rt: Runtime,
  e: { tool_name: string; tool_input: unknown },
  budgetLeft: () => number,
  signal: AbortSignal,
): Promise<'allow' | 'deny' | undefined> {
  if (!canListen(rt) || !rt.settings.remoteApprovals) return undefined
  const mode = await currentMode($, rt)
  if (mode.presence !== 'away' || !mode.canAsk) return undefined
  const now = await $.clock.now()
  const detail = describeInput(e.tool_input)
  const what = `${e.tool_name}${detail !== '' ? ` — ${detail}` : ''}`
  const chatId = projectChat(rt)
  const id = newPendingId(rt)
  const options = ['Allow', 'Deny']
  const messageId = await slSend($, rt, { chatId, kind: 'permission', text: `🔐 *${tagOf({ label: rt.label, project: rt.project })}* needs approval:\n${what}\n\n_Reply yes / no, or react ✅ / ❌._`, reactions: reactionHints(options) })
  if (messageId === '') return undefined
  await addPending($, rt, { id, kind: 'permission', question: what, options, chatId, messageId, expiresAt: now + APPROVAL_WAIT_MS })
  rt.typed = false
  try {
    // Back at the keyboard (a keystroke): stop waiting, the dialog is theirs again.
    const answer = await waitForAnswer($, rt, id, now + APPROVAL_WAIT_MS, budgetLeft, signal, () => rt.typed)
    if (answer?.verdict === undefined) return undefined
    const verdict = answer.verdict === 'approve' ? 'allow' : 'deny'
    await hubPublish($, { topic: 'approval.answered', data: { id, answer: verdict, by: CHANNEL } })
    await slSend($, rt, { chatId, kind: 'permission', text: verdict === 'allow' ? '✅ Allowed.' : '⛔ Denied.' })
    return verdict
  } finally {
    if (rt.file.pending.some(item => item.id === id)) await dropPending($, rt, id)
  }
}

async function onTurnStart($: EngineInterface, rt: Runtime, turnId: string, text: string): Promise<void> {
  rt.state = 'working'
  rt.turnId = turnId
  rt.task = clean(oneLine(text, 200), { audience: 'owner', maxChars: 200, root: rt.root }).text
  rt.turns += 1
  await saveSelf($, rt)
}

/** After a main-loop turn: a prompt that came from the phone gets its answer back there. */
async function onTurnComplete($: EngineInterface, rt: Runtime, e: { reason: string; answer: string }): Promise<void> {
  rt.state = 'idle'
  rt.turnId = undefined
  const phone = rt.phoneTurn
  rt.phoneTurn = undefined
  if (phone !== undefined) {
    const head = e.reason === 'answer' ? '✅' : e.reason === 'aborted' ? '⏹ Stopped.' : '❌ The turn failed.'
    const body = e.answer.trim() !== '' ? `${head} *#${rt.label}*\n${e.answer}` : `${head} *#${rt.label}* finished.`
    await slSend($, rt, { chatId: phone.chatId, kind: 'answer', text: body })
  }
  const usage = await $.session.usage().catch(() => undefined)
  if (usage?.cost?.usd !== undefined) rt.costUsd = usage.cost.usd
  await saveSelf($, rt)
  $.clock.after(1_500, () => void drainPhoneQueue($, rt).catch(() => undefined))
}

async function onSessionEnd($: EngineInterface, rt: Runtime): Promise<void> {
  rt.file.info.ended = true
  if (rt.isLeader) await writeJsonFile($, paths.lease(rt), { sessionId: '', heartbeatAt: 0, since: 0 })
  await saveSelf($, rt)
  for (const timer of rt.timers) timer.cancel()
  rt.pollTimer?.cancel()
}

// ── The hub: channel, tab, status ────────────────────────────────────────────────────────────────

const STATUS_OF: Record<BrPhase, 'connected' | 'connecting' | 'error' | 'unconfigured'> = {
  ready: 'connected',
  connecting: 'connecting',
  error: 'error',
  'push-only': 'connected',
  unconfigured: 'unconfigured',
  'no-owner': 'unconfigured',
}

/** Tells the hub this channel exists (push: it answers `mods.deliver`) and says hello with the tab. Without a hub: nothing. */
async function registerWithHub($: EngineInterface): Promise<void> {
  try {
    await $.mods.registerChannel({ id: CHANNEL, title: PLATFORM, audience: 'team', delivery: 'push', status: 'connecting' })
  } catch {
    // No hub answering: this mod keeps its own simple settings.
  }
  await hubHello($, { version: '1.0.0', publishes: ['channel.inbound', 'approval.answered'], consumes: [] }, { id: CHANNEL, title: PLATFORM, order: TAB_ORDER, command: CHANNEL })
}

async function setConnection($: EngineInterface, connection: BrConnection): Promise<void> {
  await update($, connectionAtom, () => connection)
  try {
    await $.mods.channelStatus({ id: CHANNEL, status: STATUS_OF[connection.phase], ...(connection.detail !== '' ? { detail: connection.detail } : {}) })
  } catch {
    // No hub answering.
  }
}

/** auth.test and conversations.info: who the bot is, whether it is in the channel, and what is still missing. */
async function checkConnection($: EngineInterface, rt: Runtime): Promise<BrConnection> {
  const now = await $.clock.now()
  rt.lastConnectionTry = now
  const base = { checkedAt: now, isLeader: rt.isLeader }
  let connection: BrConnection
  if (rt.token === '' && rt.webhook === '') {
    connection = { ...base, phase: 'unconfigured', bot: '', detail: 'No Slack credentials: set the botToken and channelId options, or an incoming webhookUrl for posting only.' }
  } else if (rt.token === '') {
    connection = { ...base, phase: 'push-only', bot: '', detail: 'Incoming webhook only: Claude posts here, but cannot read the channel, ask or take commands.' }
  } else {
    const auth = await slCall($, rt, 'auth.test', {})
    if (!auth.ok) {
      connection = { ...base, phase: 'error', bot: '', detail: auth.status === 0 ? describeFailure(auth) : `Slack refused the token (${auth.error}): check the bot token.` }
    } else {
      rt.botUserId = typeof auth.json.user_id === 'string' ? auth.json.user_id : ''
      const bot = `@${typeof auth.json.user === 'string' ? auth.json.user : 'bot'}`
      if (rt.channel === '') {
        connection = { ...base, phase: 'unconfigured', bot, detail: 'Set the channelId option (or /slack channel <id>): the one channel to post to and read.' }
      } else {
        const info = await slCall($, rt, 'conversations.info', { channel: rt.channel }, 'GET')
        const isMember = isRecord(info.json.channel) && info.json.channel.is_member !== false
        if (!info.ok || !isMember) connection = { ...base, phase: 'error', bot, detail: `The bot is not in the channel (${info.error || 'not a member'}): invite it with /invite ${bot}.` }
        else connection = rt.owner === '' ? { ...base, phase: 'no-owner', bot, detail: 'Say something in the channel, then run /slack setup to pick yourself as the owner.' } : { ...base, phase: 'ready', bot, detail: '' }
      }
    }
  }
  await setConnection($, connection)
  return connection
}

async function startUp($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  rt.dir = `${home.replace(/\/+$/, '')}/.claude/claude-mods/slack`
  if (rt.token === '') rt.token = ((await $.env.get('SLACK_BOT_TOKEN').catch(() => undefined)) ?? '').trim()
  if (rt.webhook === '') rt.webhook = ((await $.env.get('SLACK_WEBHOOK_URL').catch(() => undefined)) ?? '').trim()
  rt.me = await $.session.id()
  rt.root = await $.session.root().catch(() => '')
  rt.realRoot = (await $.fs.stat(rt.root, { resolve: true }).catch(() => undefined))?.realPath ?? rt.root
  rt.project = rt.root.split('/').filter(Boolean).at(-1) ?? 'project'
  const repo = await $.session.repo().catch(() => null)
  const branch = repo !== null ? await $.process.run(['git', 'branch', '--show-current'], { cwd: repo.root, timeoutMs: 5_000 }).catch(() => undefined) : undefined
  rt.branch = branch?.exitCode === 0 ? branch.stdout.trim() : ''
  rt.isInteractive = isInteractive
  rt.startedAt = await $.clock.now()
  rt.lastActiveAt = rt.startedAt
  await loadShared($, rt)
  const others = (await readSessionFiles($, rt, LIVE_MS)).filter(file => file.info.id !== rt.me && isLive(file.info, rt.startedAt))
  const kept = asSessionFile(await readJsonFile($, paths.session(rt, rt.me)))
  rt.label = kept?.info.label || defaultLabel(rt.project, rt.branch, others.map(file => file.info.label))
  if (kept !== null) rt.file = { ...kept, info: { ...kept.info, ended: false } }
  const done = await readJsonFile($, paths.done(rt, rt.me))
  if (isRecord(done)) {
    rt.doneSeq = typeof done.seq === 'number' ? done.seq : 0
    rt.doneIds = Array.isArray(done.ids) ? done.ids.map(String) : []
  }
  await saveSelf($, rt)
  await registerWithHub($)
  await refreshPane($, rt)
  void checkConnection($, rt).catch(() => undefined)
  void flushOutbox($, rt).catch(() => undefined)
  if (!isInteractive) return
  rt.timers.push($.clock.every(HEARTBEAT_MS, () => void heartbeat($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
  rt.timers.push($.clock.every(INBOX_MS, () => void consumeInbox($, rt).catch(() => undefined)))
  void tickLease($, rt).catch(() => undefined)
}

/** Every ten seconds: shared settings, this session's file, the lease, the panel. */
async function heartbeat($: EngineInterface, rt: Runtime): Promise<void> {
  await loadShared($, rt)
  if (rt.typed) {
    rt.typed = false
    rt.lastActiveAt = await $.clock.now()
  }
  await saveSelf($, rt)
  await tickLease($, rt)
  const connection = await read($, connectionAtom)
  if (connection.phase !== 'ready' && (await $.clock.now()) - rt.lastConnectionTry >= RETRY_CONNECTION_MS) await checkConnection($, rt)
  else if (connection.phase === 'no-owner' && rt.owner !== '') await checkConnection($, rt)
  await refreshPane($, rt)
  if (rt.state === 'idle') await drainPhoneQueue($, rt)
}

/** Fills the panel's atoms from the shared files. */
async function refreshPane($: EngineInterface, rt: Runtime): Promise<void> {
  const files = await readSessionFiles($, rt, LIVE_MS * 2)
  const now = await $.clock.now()
  await update($, sessionsAtom, () => files.map(file => file.info).filter(info => isLive(info, now)).sort((a, b) => b.lastActiveAt - a.lastActiveAt))
  if (rt.isPaneOpen || (await read($, conversationAtom)).length === 0) {
    const logs: BrLogEntry[] = []
    for (const file of files) logs.push(...((await readLines($, paths.log(rt, file.info.id))).filter(isRecord) as unknown as BrLogEntry[]))
    logs.sort((a, b) => a.at - b.at)
    await update($, conversationAtom, () => logs.filter(entry => entry.dir === 'in' || entry.dir === 'out').slice(-30))
    const members = ((await readLines($, paths.members(rt))).filter(isRecord) as unknown as BrMemberQa[]).slice(-20)
    await update($, membersAtom, () => members)
  }
  await update($, prefsAtom, () => rt.prefs)
  const mode = await currentMode($, rt)
  await update($, modeAtom, () => mode)
}

// ── /slack ────────────────────────────────────────────────────────────────────────────────────

const USAGE = [
  '/slack — open the Slack panel',
  '/slack setup — check the bot, the channel and the owner, and say what is missing',
  '/slack channel <id> — the channel to post to and read (the bot must be in it)',
  '/slack owner <member id> — the Slack member that may command Claude, answer or approve',
  '/slack pause | resume · away | here | auto · interact on | off | auto',
  '/slack label <name> · test · status',
].join('\n')

async function openPane($: EngineInterface, rt: Runtime): Promise<void> {
  rt.isPaneOpen = true
  await refreshPane($, rt)
  if (!(await hubShowTab($, CHANNEL))) await $.ui.open({ id: PANE, title: PLATFORM, columns: 52 })
}

async function statusReport($: EngineInterface, rt: Runtime): Promise<string> {
  const connection = await read($, connectionAtom)
  const mode = await currentMode($, rt)
  return [
    `Bot: ${connection.phase === 'ready' ? `connected as ${connection.bot}` : connection.detail || connection.phase}`,
    `Owner: ${rt.owner === '' ? 'not set (/slack owner <id>)' : rt.owner}`,
    `Channel: ${rt.token !== '' && rt.channel !== '' ? rt.channel : rt.webhook !== '' ? 'incoming webhook (post only)' : 'not set (/slack channel <id>)'}`,
    `Mode: ${modeLine(mode, rt.prefs)}`,
    `This session: #${rt.label}${rt.isLeader ? ' · polls Slack for all sessions' : ''}`,
  ].join('\n')
}

/** `/slack setup`: the token, the channel, the owner — and the exact next step for whatever is missing. */
async function setup($: EngineInterface, rt: Runtime): Promise<string> {
  await loadShared($, rt)
  const connection = await checkConnection($, rt)
  const lines: string[] = []
  if (rt.token === '' && rt.webhook === '') {
    lines.push(
      connection.detail,
      '',
      '1. At api.slack.com/apps create an app (from scratch) in your workspace.',
      '2. OAuth & Permissions → Bot Token Scopes: chat:write, channels:history, channels:read, reactions:read, reactions:write',
      '   (a private channel needs groups:history and groups:read instead of the channels ones).',
      '3. Install it to the workspace and copy the Bot User OAuth Token (xoxb-…): set it as the botToken option, or export SLACK_BOT_TOKEN.',
      '4. In the channel: /invite @yourbot. Set the channelId option to its id (channel details, at the bottom), or /slack channel <id>.',
      '5. Your member id (profile → ⋮ → Copy member ID): /slack owner <id>.',
      'Only want posts? An Incoming Webhook URL as the webhookUrl option is enough (no commands, no questions).',
    )
    return lines.join('\n')
  }
  if (connection.phase === 'push-only') return `${connection.detail}\nSend a test with /slack test. For commands and questions add a bot token and channel (see /slack setup without a webhook).`
  if (connection.phase === 'error' || rt.channel === '') return `${connection.detail}\nThen run /slack setup again.`
  lines.push(`Bot ${connection.bot} is in the channel ${rt.channel}.`)
  if (rt.owner === '') {
    const leader = await readJsonFile($, paths.leader(rt))
    const candidates = isRecord(leader) && Array.isArray(leader.candidates) ? (leader.candidates as LeaderState['candidates']) : []
    lines.push('', 'Say something in the channel, wait a few seconds, then run /slack setup again.')
    if (candidates.length > 0) lines.push('People who wrote there:', ...candidates.map(one => `  ${one.id}`), 'Yours? /slack owner <id>')
    else lines.push('Nobody has written there yet (the session that polls reads it within a few seconds).')
    return lines.join('\n')
  }
  lines.push(`Owner: ${rt.owner}. Only this member can command Claude, answer or approve; everyone else may ask with "?" or an @mention.`, 'Finish with /slack test.')
  return lines.join('\n')
}

async function runSlack($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (verb.toLowerCase()) {
    case '':
    case 'open':
      await openPane($, rt)
      return 'Opened the Slack panel.'
    case 'help':
      return USAGE
    case 'setup':
      return setup($, rt)
    case 'status':
      return statusReport($, rt)
    case 'owner': {
      const id = userIdOf(arg.toUpperCase())
      if (id === '') return 'Usage: /slack owner <your Slack member id, like U012ABCDEF> (profile → ⋮ → Copy member ID).'
      await writeJsonFile($, paths.config(rt), { ...(await readJsonFile($, paths.config(rt)) as SharedConfig | undefined), ownerId: id })
      rt.owner = rt.settings.ownerId !== '' ? rt.settings.ownerId : id
      await checkConnection($, rt)
      return `Owner set to ${id}. Run /slack test.`
    }
    case 'channel': {
      const id = channelIdOf(arg.toUpperCase())
      if (id === '') return 'Usage: /slack channel <channel id, like C012ABCDEF> (channel details, at the bottom).'
      await writeJsonFile($, paths.config(rt), { ...(await readJsonFile($, paths.config(rt)) as SharedConfig | undefined), channelId: id })
      rt.channel = rt.settings.channelId !== '' ? rt.settings.channelId : id
      const connection = await checkConnection($, rt)
      return connection.phase === 'error' ? connection.detail : `Channel set to ${id}.`
    }
    case 'test': {
      if (!canSend(rt)) return 'Not set up yet: run /slack setup.'
      const sent = await slSend($, rt, { chatId: projectChat(rt), kind: 'test', text: `✅ Test from Claude Code (${tagOf({ label: rt.label, project: rt.project })}).` })
      return sent === '' ? 'The test message could not be sent: run /slack status.' : 'Sent a test message.'
    }
    case 'pause':
    case 'resume':
      await savePrefs($, rt, prefs => ({ ...prefs, paused: verb.toLowerCase() === 'pause' }))
      return verb.toLowerCase() === 'pause' ? 'Muted (critical messages still go).' : 'Updates resumed.'
    case 'away':
    case 'here':
    case 'auto': {
      const via = await changeMode($, rt, { presence: verb.toLowerCase() as 'away' | 'here' | 'auto' })
      return `Presence: ${verb.toLowerCase()}${via === 'own' ? ' (own setting: no hub)' : ''}.`
    }
    case 'interact': {
      if (arg !== 'on' && arg !== 'off' && arg !== 'auto') return 'Usage: /slack interact on | off | auto'
      const via = await changeMode($, rt, { interaction: arg })
      return `Interaction ${arg}${via === 'own' ? ' (own setting: no hub)' : ''}.`
    }
    case 'label': {
      const label = arg.toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 24)
      if (label === '') return 'Usage: /slack label <name>'
      rt.label = label
      await saveSelf($, rt)
      return `This session is now #${label}.`
    }
    default:
      return USAGE
  }
}

async function paneAction($: EngineInterface, rt: Runtime, action: () => Promise<string>): Promise<void> {
  try {
    const outcome = await action()
    if (outcome !== '') $.ui.toast(oneLine(outcome, 160))
  } catch (error) {
    $.ui.toast(`Failed: ${oneLine(messageOf(error), 120)}`)
  }
  await refreshPane($, rt)
}

const PHASE_LOOK: Record<BrPhase, { glyph: string; color: string; label: string }> = {
  ready: { glyph: '●', color: 'green', label: 'Connected' },
  connecting: { glyph: '◌', color: 'yellow', label: 'Connecting' },
  'push-only': { glyph: '◑', color: 'yellow', label: 'Post only' },
  'no-owner': { glyph: '◐', color: 'yellow', label: 'Needs an owner' },
  unconfigured: { glyph: '○', color: 'gray', label: 'Not set up' },
  error: { glyph: '✗', color: 'red', label: 'Error' },
}

const NEXT_INTERACTION: Record<BrInteraction, BrInteraction> = { auto: 'on', on: 'off', off: 'auto' }

/** The status tab: the same body in the shared panel's tab and in this mod's own pane when there is no hub. */
async function drawTab($: EngineInterface, rt: Runtime, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(24, e.props.bodyColumns)
  const connection = await read($, connectionAtom)
  const sessions = await read($, sessionsAtom)
  const conversation = await read($, conversationAtom)
  const prefs = await read($, prefsAtom)
  const mode = await read($, modeAtom)
  const look = PHASE_LOOK[connection.phase]
  const row = (text: string): string => oneLine(text, width)
  return (
    <Box key="slack-tab" flexDirection="column" gap={1}>
      <Box key="connection" flexDirection="column">
        <Text bold>
          <Text color={look.color}>{look.glyph}</Text> {PLATFORM} · {look.label}
          {connection.bot !== '' ? ` · ${connection.bot}` : ''}
        </Text>
        {connection.detail !== '' && <Text dimColor wrap="wrap">{connection.detail}</Text>}
        <Text dimColor>{row(`Owner ${rt.owner === '' ? 'not set' : rt.owner} · ${rt.channel === '' ? 'no channel' : rt.channel}${connection.isLeader ? ' · this session polls' : ''}`)}</Text>
        <Text dimColor wrap="wrap">{modeLine(mode, prefs)}</Text>
      </Box>
      <Box key="sessions" flexDirection="column">
        <Text bold>Sessions</Text>
        {sessions.length === 0 && <Text dimColor>None live.</Text>}
        {sessions.slice(0, 5).map(session => (
          <Text key={`session:${session.id}`} wrap="truncate-end">{row(`${session.state === 'working' ? '⚙' : '·'} #${session.label} ${session.project} — ${session.state === 'working' ? session.task : 'idle'}`)}</Text>
        ))}
      </Box>
      <Box key="conversation" flexDirection="column">
        <Text bold>Recent</Text>
        {conversation.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {conversation.slice(-5).map((entry, index) => (
          <Text key={`line:${index}`} dimColor={entry.dir === 'out'} wrap="truncate-end">{row(`${entry.dir === 'in' ? '←' : '→'} ${entry.text}`)}</Text>
        ))}
      </Box>
      <Box key="actions" flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="test" label="Test" hotkey="t" onPress={() => void paneAction($, rt, () => runSlack($, rt, 'test'))} />
        <Button key="pause" label={prefs.paused ? 'Resume' : 'Pause'} onPress={() => void paneAction($, rt, () => runSlack($, rt, prefs.paused ? 'resume' : 'pause'))} />
        <Button key="interaction" label={`Interaction: ${prefs.interaction}`} onPress={() => void paneAction($, rt, () => runSlack($, rt, `interact ${NEXT_INTERACTION[prefs.interaction]}`))} />
        <Button key="refresh" label="Refresh" onPress={() => void paneAction($, rt, async () => (await checkConnection($, rt), ''))} />
        {connection.phase !== 'ready' && <Button key="setup" label="Setup" variant="primary" onPress={() => void paneAction($, rt, () => setup($, rt))} />}
      </Box>
    </Box>
  )
}

async function startSession($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  try {
    await $.command.register({ name: 'slack', description: 'Slack bridge: panel, setup, channel, owner, presence, interaction', argumentHint: '[setup | channel <id> | owner <id> | test | away | here | interact on|off | help]', immediate: true })
  } catch (error) {
    $.ui.log(`${NAME}: could not register /slack: ${messageOf(error)}`, { to: 'debug' })
  }
  await registerTools($)
  try {
    await startUp($, rt, isInteractive)
  } catch (error) {
    $.ui.log(`${NAME}: start-up failed: ${messageOf(error)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readSettings(options))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSession($, rt, e.isInteractive)
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the session: the bridge keeps running.
    if (e.reason === 'clear') return next(e)
    try {
      await onSessionEnd($, rt)
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'slack' }, async ($, e) => {
    try {
      return { text: await runSlack($, rt, e.args) }
    } catch (error) {
      return { text: `The /slack command failed: ${messageOf(error)}` }
    }
  })

  // The hub hands a notice to this channel: queue it and answer at once; the sending happens in the background.
  on('mods.deliver', { channel: CHANNEL }, async ($, e) => {
    rt.outbox.push({ level: e.notice.level, source: e.notice.source, title: e.notice.title, ...(e.notice.body !== undefined ? { body: e.notice.body } : {}), ...(e.notice.url !== undefined ? { url: e.notice.url } : {}) })
    $.clock.after(0, () => void flushOutbox($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })))
    return { value: { isDelivered: true } }
  }).catch(() => ({ value: { isDelivered: false, reason: 'slack-bridge could not queue it' } }))

  // The system prompt says what Slack can do now: one fixed text per interaction state (cache-friendly).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!canSend(rt) || e.traits.includes('bare')) return composed
    const mode = await currentMode($, rt)
    return { sections: [...composed.sections, { id: 'slack-bridge', text: composeSection(PLATFORM, TOOL_PREFIX, mode.canAsk && canListen(rt)), scope: 'session' }] }
  })

  // Typing counts as being at the keyboard (read on the next heartbeat; no work per key).
  on('prompt.edit', ($, e, next) => {
    rt.typed = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      rt.lastActiveAt = await $.clock.now()
      return next(e)
    }
    const index = e.origin.kind === 'plugin' ? rt.tagged.indexOf(e.text) : -1
    if (index < 0) return next(e)
    rt.tagged.splice(index, 1)
    return next({ ...e, context: [...(e.context ?? []), PHONE_CONTEXT] })
  })

  on('turn.start', async ($, e, next) => {
    try {
      await onTurnStart($, rt, e.turnId, e.text)
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      await onTurnComplete($, rt, e)
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return result
  })

  on('tool.call', { tool: `${TOOL_PREFIX}notify` }, async ($, e) => ({ result: await toolNotify($, rt, e as unknown as Record<string, unknown>) })).catch(
    () => ({ result: 'slack-bridge: the message could not be sent (see /slack status).' }),
  )
  on('tool.call', { tool: `${TOOL_PREFIX}ask` }, async ($, e, next) => ({
    result: await toolAsk($, rt, e as unknown as Record<string, unknown>, () => next.budget.remainingMs, next.signal),
  })).catch(() => ({ result: 'The question could not be asked. Proceed with your best judgement and state your assumption.' }))
  on('tool.call', { tool: `${TOOL_PREFIX}open_panel` }, async $ => {
    await openPane($, rt)
    return { result: 'The Slack panel is open beside the conversation.' }
  })

  // Messages go only to the owner's allowlisted chats, after redaction: no prompt for notify, ask and the panel.
  on('tool.check', { tool: [`${TOOL_PREFIX}notify`, `${TOOL_PREFIX}ask`, `${TOOL_PREFIX}open_panel`] }, async ($, e, next) => {
    const verdict = await next(e)
    const isDefaultAsk = verdict.decision === 'ask' && verdict.rule === undefined && e.ceiling === undefined
    return isDefaultAsk ? { ...verdict, decision: 'allow', reason: `${NAME}: messages only the owner's allowlisted chats` } : verdict
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision !== undefined) return answer
    try {
      const verdict = await remotePermission($, rt, e, () => next.budget.remainingMs, next.signal)
      if (verdict === 'allow') return { ...answer, decision: { behavior: 'allow' } }
      if (verdict === 'deny') return { ...answer, decision: { behavior: 'deny', message: 'Denied by the owner from Slack.' } }
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return answer
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    rt.isPaneOpen = false
    return next(e)
  })

  // The status tab: drawn inside the hub's shared panel when it is this mod's tab, and in its own pane otherwise.
  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, CHANNEL))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawTab($, rt, e)}
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawTab($, rt, e))
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

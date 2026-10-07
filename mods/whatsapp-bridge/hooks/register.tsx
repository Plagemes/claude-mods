import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type {
  WaConnection,
  WaEventKey,
  WaGroupCard,
  WaGroupLink,
  WaLogEntry,
  WaMemberQa,
  WaPrefs,
  WaPriority,
  WaPrivacy,
  WaSessionInfo,
  WaTab,
} from '../types'
import type { ModsEvent, ModsNotice } from '../types/mods-hub'
import { MAX_OPTIONS, matchAnswer, optionsFor, pendingFor, questionText } from './answers'
import type { Answer, Pending } from './answers'
import { HELP_TEXT, parseCommand, reactionMeaning } from './commands'
import type { PhoneCommand } from './commands'
import {
  PUSH_COMMAND,
  TEST_COMMAND,
  briefingText,
  clockTime,
  composeSection,
  costText,
  digestText,
  dockerSteps,
  keySteps,
  minutes,
  sessionsText,
  statusText,
  tagOf,
} from './format'
import type { DigestItem } from './format'
import { bugPrompt, emptyBook, isOwnerPhone, memberPrompt, memberTrigger, parseIssueDraft, phoneOf, takeQuota } from './members'
import type { RateBook } from './members'
import {
  api,
  dataUrlBase64,
  directChat,
  errorText,
  extensionOf,
  isGroupChat,
  mimeOf,
  parseGroups,
  parseJson,
  parseMessageId,
  parseRows,
  parseSession,
  parseSessions,
  phaseOf,
} from './openwa'
import type { Request, WaRow } from './openwa'
import { LEASE_RENEW_MS, MAX_PAGES, PAGE_LIMIT, backoff, leaseAction, parseLease, pollInterval, remember, walkPage } from './poller'
import type { Cursor, Lease } from './poller'
import { crossed, crossedBudgets, dayKey, decide, isAway } from './policy'
import { clean, oneLine } from './privacy'
import { chartSvg, chartText, costChart, routerChart, testsChart } from './reports'
import type { Chart } from './reports'
import { LIVE_MS, defaultLabel, isLive, projectOfChat, route } from './routing'
import {
  EVENT_KEYS,
  EVENT_LABELS,
  channelStatusOf,
  defaultPrefs,
  digitsOnly,
  hubModeLabel,
  interactionAllowed,
  interactionLabel,
  mergePrefs,
  parseClock,
  prefsFromHub,
  readSettings,
  windowEnd,
} from './settings'
import type { Settings } from './settings'

const NAME = 'whatsapp-bridge'
const PANE = 'whatsapp-bridge'
/** mods-hub: its shared panel, the bridge's tab in it (order 80: Channels), and its channel id. */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'channels', title: 'Channels', order: 80, command: 'wa' } as const
const CHANNEL = 'whatsapp'
/** How a hub notification's level travels: critical at once, info in the digest, the rest as normal. */
const HUB_PRIORITY: Record<string, WaPriority> = { critical: 'critical', error: 'normal', warning: 'normal', success: 'normal', info: 'info' }
const HUB_GLYPH: Record<string, string> = { critical: '🚨', error: '❌', warning: '⚠️', success: '✅', info: 'ℹ️' }
const PANE_COLUMNS = 52
const TOOL_PREFIX = 'mcp__whatsapp-bridge__'
const HEARTBEAT_MS = LEASE_RENEW_MS
const INBOX_MS = 3_000
const SCREENSHOT_MS = 15_000
const SESSION_FILE_FRESH_MS = 2 * 24 * 60 * 60_000
const STATS_DAYS_MS = 8 * 24 * 60 * 60_000
const LOG_KEEP = 200
const SENT_KEEP = 300
const DONE_KEEP = 400
const ALERT_TTL_MS = 2 * 60 * 60_000
const CONFIRM_TTL_MS = 30 * 60_000
const BUG_TTL_MS = 24 * 60 * 60_000
const DEFAULT_ASK_MINUTES = 10
const MAX_ASK_MINUTES = 30
const APPROVAL_WAIT_MS = 10 * 60_000
const PACE_MS = 2_000
const EDIT_WINDOW_MS = 14 * 60_000
const TOOL_ERROR_STREAK = 3
const CI_POLL_MS = 60_000
const CI_GIVE_UP_MS = 30 * 60_000
const REACTION_EVERY_POLLS = 3
/**
 * An invisible separator at the end of every message the bot sends: with the owner's own number linked, their
 * phone-typed messages and the bot's both come back as outgoing rows, and this tells them apart.
 */
const BOT_MARK = '\u2063'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const PHONE_CONTEXT =
  'This prompt was sent by the user from WhatsApp (whatsapp-bridge). Your final reply is relayed to their phone: ' +
  'end with a short plain-text summary of what you did or found.'
/**
 * A phone prompt carries PHONE_CONTEXT in its own text: a plugin's `prompt.submit` hook never sees the prompts that
 * plugin submits itself (checked live with `claude -p --plugin-dir`, docs/ARCHITECTURE.md section 2), so it cannot
 * attach the note as context on the way down.
 */
const PHONE_NOTE = `\n\n(${PHONE_CONTEXT})`
const phonePrompt = (text: string): string => `${text}${PHONE_NOTE}`
const withoutPhoneNote = (text: string): string => (text.endsWith(PHONE_NOTE) ? text.slice(0, -PHONE_NOTE.length) : text)

const EMPTY_CONNECTION: WaConnection = { phase: 'unconfigured', detail: '', phone: '', qr: '', pairingCode: '', mode: 'unknown', checkedAt: 0, isLeader: false }

const tabAtom = atom({ plugin: 'whatsapp-bridge', key: 'tab' } as const, 'status' as WaTab)
const connectionAtom = atom({ plugin: 'whatsapp-bridge', key: 'connection' } as const, EMPTY_CONNECTION)
const groupAtom = atom({ plugin: 'whatsapp-bridge', key: 'group' } as const, { link: null, note: '', choices: [] } as WaGroupCard)
const sessionsAtom = atom({ plugin: 'whatsapp-bridge', key: 'sessions' } as const, [] as WaSessionInfo[])
const conversationAtom = atom({ plugin: 'whatsapp-bridge', key: 'conversation' } as const, [] as WaLogEntry[])
const prefsAtom = atom({ plugin: 'whatsapp-bridge', key: 'prefs' } as const, defaultPrefs(readSettings({})))
const privacyAtom = atom({ plugin: 'whatsapp-bridge', key: 'privacy' } as const, { allowlist: [], sample: '', redacted: '' } as WaPrivacy)
const auditAtom = atom({ plugin: 'whatsapp-bridge', key: 'audit' } as const, [] as WaLogEntry[])
const membersAtom = atom({ plugin: 'whatsapp-bridge', key: 'members' } as const, [] as WaMemberQa[])

/** config.json in the shared folder: what /wa setup learned. Never the admin key. */
type SharedConfig = { apiKey?: string; sessionId?: string; ownerNumbers?: string[] }

/** One entry the leader dropped in a session's inbox. */
type InboxEntry = {
  seq: number
  key: string
  at: number
  kind: 'owner' | 'reaction' | 'member' | 'bug'
  chatId: string
  messageId: string
  author: string
  text: string
  quotedId?: string
  emoji?: string
  targetId?: string
  media?: { type: string; mimetype: string; filename?: string }
}

type Seq<T> = T & { seq: number }

/** sessions/<id>.json: everything other sessions and the leader need to know of one session. Written by it alone. */
type SessionFile = {
  info: WaSessionInfo
  sentIds: string[]
  sentTimes: number[]
  pending: Pending[]
  digest: Seq<DigestItem>[]
  parked: Seq<DigestItem>[]
  stats: { costByDay: Record<string, number>; tests: Record<string, { pass: number; fail: number }> }
}

/** leader.json: the poller's own state, written by the leader alone. */
type LeaderState = {
  cursors: Record<string, Cursor>
  seen: string[]
  book: RateBook
  digestSeq: Record<string, number>
  parkedSeq: Record<string, number>
  lastCheck: number
  lastDigestAt: number
  wasInteractive: boolean
  lidPhones: Record<string, string>
}

type Converter = readonly string[] | null

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
  isStarted: boolean
  config: SharedConfig
  apiKey: string
  sessionId: string
  owners: string[]
  scoped: boolean
  botPhone: string
  mode: 'bot' | 'self' | 'unknown'
  prefs: WaPrefs
  groups: Record<string, WaGroupLink>
  startedAt: number
  lastActiveAt: number
  typed: boolean
  state: 'idle' | 'working'
  turnId: string | undefined
  turnStartedAt: number
  task: string
  lastPrompt: string
  turns: number
  costUsd: number
  file: SessionFile
  answers: Map<string, Answer>
  waiting: Set<string>
  lateAnswers: string[]
  phoneQueue: { text: string; chatId: string; messageId: string }[]
  phoneTurn: { chatId: string; messageId: string } | undefined
  isSubmitting: boolean
  toolErrors: number
  testsOk: boolean | undefined
  pushedThisTurn: boolean
  liveStatus: { chatId: string; messageId: string; at: number } | undefined
  doneSeq: number
  doneIds: string[]
  isLeader: boolean
  leaseVerified: boolean
  leader: LeaderState | undefined
  pollTimer: Timer | undefined
  polls: number
  backoffMs: number
  backoffUntil: number
  lastInboundAt: number
  timers: Timer[]
  triedGroup: boolean
  canSleep: boolean
  converter: Converter | undefined
  hasWhisper: boolean | undefined
  shotsSeen: Set<string>
  ci: Timer | undefined
  isPaneOpen: boolean
  sendCount: number
  isConsuming: boolean
  /** mods-hub's global mode when it is installed (refreshed every heartbeat); undefined without the hub. */
  hub: HubMode | undefined
  /** The newest hub event already read. */
  hubSeenAt: number
  /** The link phase last reported to the hub's channel list ('' before the channel is registered). */
  channelPhase: string
}

type HubMode = NonNullable<Awaited<ReturnType<typeof hubMode>>>

type CallResult = { status: number; ok: boolean; json: unknown; text: string; retryAfter?: string }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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
  isStarted: false,
  config: {},
  apiKey: '',
  sessionId: '',
  owners: settings.ownerNumbers,
  scoped: false,
  botPhone: '',
  mode: 'unknown',
  prefs: defaultPrefs(settings),
  groups: {},
  startedAt: 0,
  lastActiveAt: 0,
  typed: false,
  state: 'idle',
  turnId: undefined,
  turnStartedAt: 0,
  task: '',
  lastPrompt: '',
  turns: 0,
  costUsd: 0,
  file: emptyFile(),
  answers: new Map(),
  waiting: new Set(),
  lateAnswers: [],
  phoneQueue: [],
  phoneTurn: undefined,
  isSubmitting: false,
  toolErrors: 0,
  testsOk: undefined,
  pushedThisTurn: false,
  liveStatus: undefined,
  doneSeq: 0,
  doneIds: [],
  isLeader: false,
  leaseVerified: false,
  leader: undefined,
  pollTimer: undefined,
  polls: 0,
  backoffMs: 0,
  backoffUntil: 0,
  lastInboundAt: 0,
  timers: [],
  triedGroup: false,
  canSleep: true,
  converter: undefined,
  hasWhisper: undefined,
  shotsSeen: new Set(),
  ci: undefined,
  isPaneOpen: false,
  sendCount: 0,
  isConsuming: false,
  hub: undefined,
  hubSeenAt: 0,
  channelPhase: '',
})

function emptyFile(): SessionFile {
  return {
    info: { id: '', project: '', root: '', branch: '', label: '', lastSeen: 0, lastActiveAt: 0, state: 'idle', task: '', costUsd: 0, startedAt: 0, turns: 0, ended: false },
    sentIds: [],
    sentTimes: [],
    pending: [],
    digest: [],
    parked: [],
    stats: { costByDay: {}, tests: {} },
  }
}

const emptyLeader = (): LeaderState => ({
  cursors: {},
  seen: [],
  book: emptyBook(),
  digestSeq: {},
  parkedSeq: {},
  lastCheck: 0,
  lastDigestAt: 0,
  wasInteractive: true,
  lidPhones: {},
})

const paths = {
  config: (rt: Runtime): string => `${rt.dir}/config.json`,
  prefs: (rt: Runtime): string => `${rt.dir}/prefs.json`,
  groups: (rt: Runtime): string => `${rt.dir}/groups.json`,
  lease: (rt: Runtime): string => `${rt.dir}/lease.json`,
  leader: (rt: Runtime): string => `${rt.dir}/leader.json`,
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  inbox: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.jsonl`,
  done: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.done.json`,
  log: (rt: Runtime, id: string): string => `${rt.dir}/log/${id}.jsonl`,
  members: (rt: Runtime): string => `${rt.dir}/members.jsonl`,
  scratch: (rt: Runtime): string => `${rt.dir}/tmp`,
  media: (rt: Runtime): string => `${rt.root}/.claude/whatsapp/inbox`,
  queue: (rt: Runtime): string => `${rt.root}/.claude/whatsapp/queue.md`,
  shots: (rt: Runtime): string => `${rt.root}/.claude/screenshots`,
}

/** Whether the mod knows enough to talk to OpenWA: a key, a WhatsApp session and an owner. */
const isConfigured = (rt: Runtime): boolean => rt.apiKey !== '' && rt.sessionId !== '' && rt.owners.length > 0
/** The prefs presence, interaction and quiet hours are judged by: mods-hub's global mode, when it is installed. */
const attention = (rt: Runtime): WaPrefs => (rt.hub === undefined ? rt.prefs : prefsFromHub(rt.prefs, rt.hub))
const canInteract = (rt: Runtime, now: number): boolean => interactionAllowed(attention(rt), rt.settings.interactionOffHours, now)
const interactionText = (rt: Runtime, now: number): string =>
  rt.hub === undefined ? interactionLabel(rt.prefs, rt.settings.interactionOffHours, now) : hubModeLabel(rt.hub)
const ownerChat = (rt: Runtime): string => directChat(rt.owners[0] ?? '')
const projectGroup = (rt: Runtime): WaGroupLink | undefined => rt.groups[rt.root]

/** The chats the mod may ever read or write: the owners' direct chats, linked project groups and extra chats. */
const allowlist = (rt: Runtime): string[] => [
  ...new Set([...rt.owners.map(directChat), ...Object.values(rt.groups).map(link => link.groupId), ...rt.settings.extraChats]),
]
const isAllowed = (rt: Runtime, chatId: string): boolean => chatId !== '' && allowlist(rt).includes(chatId)

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

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

/** Every session file touched in `freshMs`, each with its id. */
async function readSessionFiles($: EngineInterface, rt: Runtime, freshMs: number): Promise<SessionFile[]> {
  const now = await $.clock.now()
  const entries = await $.fs.list(paths.sessions(rt)).catch(() => [])
  const files: SessionFile[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs > 0 && now - entry.mtimeMs > freshMs) continue
    const id = entry.name.slice(0, -'.json'.length)
    const value = id === rt.me ? rt.file : await readJsonFile($, paths.session(rt, id))
    const file = asSessionFile(value)
    if (file !== null) files.push(file)
  }
  if (rt.me !== '' && !files.some(file => file.info.id === rt.me)) files.push(rt.file)
  return files
}

function asSessionFile(value: unknown): SessionFile | null {
  if (!isRecord(value) || !isRecord(value.info) || typeof value.info.id !== 'string') return null
  const base = emptyFile()
  const list = <T,>(field: unknown): T[] => (Array.isArray(field) ? (field as T[]) : [])
  const stats = isRecord(value.stats) ? value.stats : {}
  return {
    info: { ...base.info, ...(value.info as Partial<WaSessionInfo>) },
    sentIds: list<string>(value.sentIds),
    sentTimes: list<number>(value.sentTimes),
    pending: list<Pending>(value.pending),
    digest: list<Seq<DigestItem>>(value.digest),
    parked: list<Seq<DigestItem>>(value.parked),
    stats: {
      costByDay: isRecord(stats.costByDay) ? (stats.costByDay as Record<string, number>) : {},
      tests: isRecord(stats.tests) ? (stats.tests as Record<string, { pass: number; fail: number }>) : {},
    },
  }
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
  rt.file.sentTimes = rt.file.sentTimes.filter(at => now - at < 60 * 60_000)
  rt.file.pending = rt.file.pending.filter(item => item.expiresAt > now)
  await writeJsonFile($, paths.session(rt, rt.me), rt.file)
}

async function appendLog($: EngineInterface, rt: Runtime, entry: Omit<WaLogEntry, 'at' | 'session'>): Promise<void> {
  const now = await $.clock.now()
  const row: WaLogEntry = { at: now, session: rt.label === '' ? 'leader' : `#${rt.label}`, ...entry, text: oneLine(entry.text, 240) }
  const path = paths.log(rt, rt.me === '' ? 'unknown' : rt.me)
  const lines = (await readLines($, path)).slice(-(LOG_KEEP - 1))
  await writeLines($, path, [...lines, row])
  await update($, auditAtom, list => [...list, row].slice(-60))
  if (entry.dir === 'in' || entry.dir === 'out') await update($, conversationAtom, list => [...list, row].slice(-30))
}

// ── OpenWA over HTTP ─────────────────────────────────────────────────────────────────────────────

/** One OpenWA call. Never throws: a transport failure is status 0. A 429 starts the shared backoff. */
async function waCall($: EngineInterface, rt: Runtime, request: Request, idempotencyKey?: string): Promise<CallResult> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (request.isPublic !== true) headers['X-API-Key'] = rt.apiKey
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey
  try {
    const response = await $.http.fetch(`${rt.settings.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    })
    const retryAfter = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
    if (response.status === 429) {
      rt.backoffMs = backoff(rt.backoffMs, retryAfter)
      rt.backoffUntil = (await $.clock.now()) + rt.backoffMs
    }
    return { status: response.status, ok: response.ok, json: parseJson(response.text), text: response.text, ...(retryAfter !== undefined ? { retryAfter } : {}) }
  } catch (error) {
    return { status: 0, ok: false, json: undefined, text: messageOf(error) }
  }
}

const failure = (result: CallResult): string => (result.status === 0 ? `OpenWA unreachable (${oneLine(result.text, 80)})` : errorText(result.status, result.text))

type SendInput = {
  chatId: string
  text: string
  kind: string
  audience?: 'owner' | 'member'
  quotedId?: string
}

/**
 * Sends a text to an allowlisted chat, after redaction and the length cap; records the message id (for
 * reply routing) and the send (for the hourly cap). Resolves the WhatsApp message id, or '' when not sent.
 */
async function waSendText($: EngineInterface, rt: Runtime, input: SendInput): Promise<string> {
  if (!isConfigured(rt) || !isAllowed(rt, input.chatId)) {
    await appendLog($, rt, { dir: 'drop', chatId: input.chatId, kind: input.kind, text: `not sent (chat not allowlisted or not set up): ${input.text}` })
    return ''
  }
  const body = clean(input.text, { audience: input.audience ?? 'owner', maxChars: rt.settings.maxMessageChars, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text + BOT_MARK
  rt.sendCount += 1
  const key = `wa-${rt.me.slice(0, 12)}-${await $.clock.now()}-${rt.sendCount}`
  const request = input.quotedId !== undefined ? api.reply(rt.sessionId, input.chatId, input.quotedId, body) : api.sendText(rt.sessionId, input.chatId, body)
  let result = await waCall($, rt, request, key)
  if (result.status === 409 || (result.status === 404 && input.quotedId !== undefined)) {
    // 409: the engine was reloading; 404: the quoted message left OpenWA's lookup window, so send it plain.
    const plain = result.status === 404 ? api.sendText(rt.sessionId, input.chatId, body) : request
    result = await waCall($, rt, plain, result.status === 404 ? `${key}-plain` : key)
  }
  const messageId = result.ok ? parseMessageId(result.json) : ''
  if (messageId === '') {
    await appendLog($, rt, { dir: 'drop', chatId: input.chatId, kind: input.kind, text: `send failed (${failure(result)}): ${body}` })
    return ''
  }
  await recordSent($, rt, messageId)
  await appendLog($, rt, { dir: 'out', chatId: input.chatId, kind: input.kind, text: body, messageId, who: 'bot' })
  return messageId
}

async function recordSent($: EngineInterface, rt: Runtime, messageId: string): Promise<void> {
  const now = await $.clock.now()
  rt.file.sentIds = [...rt.file.sentIds, messageId].slice(-SENT_KEEP)
  rt.file.sentTimes = [...rt.file.sentTimes.filter(at => now - at < 60 * 60_000), now]
  await saveSelf($, rt)
}

/** Sends a file (image or document) by base64 to an allowlisted chat. */
async function waSendFile($: EngineInterface, rt: Runtime, input: { chatId: string; path: string; base64: string; caption: string; kind: string }): Promise<string> {
  if (!isConfigured(rt) || !isAllowed(rt, input.chatId)) return ''
  const { mimetype, kind } = mimeOf(input.path)
  const filename = input.path.split('/').at(-1) ?? 'file'
  const caption = clean(input.caption, { audience: 'owner', maxChars: 1000, root: rt.root }).text + BOT_MARK
  rt.sendCount += 1
  const result = await waCall(
    $,
    rt,
    api.sendMedia(rt.sessionId, kind, { chatId: input.chatId, base64: input.base64, mimetype, filename, caption }),
    `wa-${rt.me.slice(0, 12)}-${await $.clock.now()}-${rt.sendCount}`,
  )
  const messageId = result.ok ? parseMessageId(result.json) : ''
  await appendLog($, rt, {
    dir: messageId === '' ? 'drop' : 'out',
    chatId: input.chatId,
    kind: input.kind,
    text: messageId === '' ? `file not sent (${failure(result)}): ${filename}` : `📎 ${filename}${caption !== '' ? ` — ${caption}` : ''}`,
    ...(messageId !== '' ? { messageId, who: 'bot' as const } : {}),
  })
  if (messageId !== '') await recordSent($, rt, messageId)
  return messageId
}

// ── Configuration and the connection ─────────────────────────────────────────────────────────────

/** Reads config.json, prefs.json and groups.json into the runtime (they change from any session). */
async function loadShared($: EngineInterface, rt: Runtime): Promise<void> {
  const config = await readJsonFile($, paths.config(rt))
  rt.config = isRecord(config) ? (config as SharedConfig) : {}
  const envKey = (await $.env.get('OPENWA_API_KEY').catch(() => undefined)) ?? ''
  rt.apiKey = rt.settings.apiKey || envKey.trim() || (typeof rt.config.apiKey === 'string' ? rt.config.apiKey : '')
  rt.sessionId = typeof rt.config.sessionId === 'string' ? rt.config.sessionId : ''
  const stored = Array.isArray(rt.config.ownerNumbers) ? rt.config.ownerNumbers.map(String).map(digitsOnly) : []
  rt.owners = [...new Set([...rt.settings.ownerNumbers, ...stored])].filter(n => n.length >= 6)
  rt.prefs = mergePrefs(await readJsonFile($, paths.prefs(rt)), rt.settings)
  const groups = await readJsonFile($, paths.groups(rt))
  rt.groups = isRecord(groups)
    ? Object.fromEntries(Object.entries(groups).filter(([, link]) => isRecord(link) && typeof link.groupId === 'string')) as Record<string, WaGroupLink>
    : {}
  await update($, prefsAtom, () => rt.prefs)
}

async function saveConfig($: EngineInterface, rt: Runtime, change: Partial<SharedConfig>): Promise<void> {
  rt.config = { ...rt.config, ...change }
  await writeJsonFile($, paths.config(rt), rt.config)
  await loadShared($, rt)
}

async function savePrefs($: EngineInterface, rt: Runtime, change: (prefs: WaPrefs) => WaPrefs): Promise<WaPrefs> {
  rt.prefs = change(mergePrefs(await readJsonFile($, paths.prefs(rt)), rt.settings))
  await writeJsonFile($, paths.prefs(rt), rt.prefs)
  await update($, prefsAtom, () => rt.prefs)
  return rt.prefs
}

async function saveGroups($: EngineInterface, rt: Runtime, change: (groups: Record<string, WaGroupLink>) => Record<string, WaGroupLink>): Promise<void> {
  const stored = await readJsonFile($, paths.groups(rt))
  rt.groups = change(isRecord(stored) ? (stored as Record<string, WaGroupLink>) : {})
  await writeJsonFile($, paths.groups(rt), rt.groups)
  await refreshGroupCard($, rt, '')
}

/** Asks OpenWA where things stand (health, key, session, link) and shows it on the pane. */
async function checkConnection($: EngineInterface, rt: Runtime): Promise<WaConnection> {
  const now = await $.clock.now()
  const base: WaConnection = { ...EMPTY_CONNECTION, checkedAt: now, isLeader: rt.isLeader, mode: rt.mode }
  const set = async (connection: WaConnection): Promise<WaConnection> => {
    await update($, connectionAtom, () => connection)
    return connection
  }
  const health = await waCall($, rt, api.health())
  if (!health.ok) return set({ ...base, phase: 'unreachable', detail: failure(health) })
  if (rt.apiKey === '') return set({ ...base, phase: 'no-key', detail: 'No API key yet: /wa setup' })
  const valid = await waCall($, rt, api.validate())
  if (!valid.ok) return set({ ...base, phase: 'no-key', detail: `The key was refused (${failure(valid)})` })
  const role = isRecord(valid.json) ? String(valid.json.role ?? '') : ''
  rt.scoped = isRecord(valid.json) && valid.json.scoped === true
  if (role === 'admin') {
    return set({ ...base, phase: 'admin-key', detail: 'That is an ADMIN key: the mod refuses it. Mint a scoped operator key (/wa setup).' })
  }
  if (rt.sessionId === '') {
    const listed = await waCall($, rt, api.sessions())
    const sessions = parseSessions(listed.json)
    if (sessions.length === 1 && sessions[0] !== undefined) {
      await saveConfig($, rt, { sessionId: sessions[0].id })
    } else {
      const names = sessions.map(one => `${one.name} (${one.status})`).join(', ')
      return set({ ...base, phase: 'no-session', detail: sessions.length === 0 ? 'No WhatsApp session in OpenWA yet: /wa setup' : `Pick one: /wa session <name> — ${names}` })
    }
  }
  const got = await waCall($, rt, api.session(rt.sessionId))
  const session = parseSession(got.json)
  if (session === null) return set({ ...base, phase: 'error', detail: failure(got) })
  rt.botPhone = session.phone
  rt.mode = session.phone === '' ? 'unknown' : rt.owners.includes(session.phone) ? 'self' : 'bot'
  const phase = phaseOf(session.status)
  let qr = ''
  if (phase === 'qr') {
    const code = await waCall($, rt, api.qr(rt.sessionId))
    qr = isRecord(code.json) && typeof code.json.qrCode === 'string' ? dataUrlBase64(code.json.qrCode) : ''
  }
  const previous = await read($, connectionAtom)
  const detail =
    phase === 'ready'
      ? `Linked as +${session.phone}${session.pushName !== '' ? ` (${session.pushName})` : ''}`
      : phase === 'qr'
        ? 'Scan the QR with WhatsApp › Linked devices, or pair with a code'
        : phase === 'disconnected'
          ? 'Disconnected: press Reconnect'
          : session.lastError !== ''
            ? session.lastError
            : session.status
  return set({ ...base, phase, detail, phone: session.phone, qr, pairingCode: phase === 'qr' ? previous.pairingCode : '', mode: rt.mode })
}

// ── Project groups ───────────────────────────────────────────────────────────────────────────────

async function refreshGroupCard($: EngineInterface, rt: Runtime, note: string): Promise<void> {
  const link = projectGroup(rt) ?? null
  await update($, groupAtom, card => ({ link, note: note || (link === null ? card.note : ''), choices: link === null ? card.choices : [] }))
}

/** Creates "Claude · <project>" with only the owner in it (Baileys engines), and links it to this project. */
async function createProjectGroup($: EngineInterface, rt: Runtime): Promise<string> {
  if (!isConfigured(rt)) return 'Set up the connection first: /wa setup'
  if (rt.mode === 'self') return 'Your own number is linked: create the group on your phone, then /wa link-project.'
  const name = `Claude · ${rt.project}`.slice(0, 100)
  const created = await waCall($, rt, api.createGroup(rt.sessionId, name, rt.owners.map(directChat)))
  const groupId = isRecord(created.json) && typeof created.json.id === 'string' ? created.json.id : ''
  if (!created.ok || groupId === '') {
    const why = created.status === 501
      ? 'this OpenWA engine cannot create groups (whatsapp-web.js)'
      : created.status === 403
        ? 'the key is chat-scoped or WhatsApp refused it'
        : failure(created)
    return `Could not create the group: ${why}. Create "${name}" on your phone with the bot number in it, then /wa link-project to pick it.`
  }
  await linkGroup($, rt, groupId, name)
  void waCall($, rt, api.groupDescription(rt.sessionId, groupId, `Claude Code updates for ${rt.project}. Owner: send "help". Members: start with "?" to ask about progress, "bug:" to report a bug.`))
  await waSendText($, rt, {
    chatId: groupId,
    kind: 'welcome',
    text: `🤖 This group gets Claude Code updates for *${rt.project}*.\nOwner: send *help* for commands. Members you add can ask about progress (start with *?*) or report a bug (*bug:* …).`,
  })
  return `Created the WhatsApp group "${name}" and linked it to ${rt.project}.`
}

async function linkGroup($: EngineInterface, rt: Runtime, groupId: string, name: string): Promise<void> {
  const now = await $.clock.now()
  const info = await waCall($, rt, api.groupInfo(rt.sessionId, groupId))
  const members = isRecord(info.json) && Array.isArray(info.json.participants) ? info.json.participants.length : 0
  const invite = await waCall($, rt, api.inviteCode(rt.sessionId, groupId))
  const inviteLink = isRecord(invite.json) && typeof invite.json.inviteLink === 'string' ? invite.json.inviteLink : ''
  await saveGroups($, rt, groups => ({ ...groups, [rt.root]: { groupId, name, inviteLink, members, createdAt: now } }))
}

/** `/wa link-project [n|group id]`: create the group, or list the bot's groups, or link the one picked. */
async function linkProject($: EngineInterface, rt: Runtime, arg: string): Promise<string> {
  if (!isConfigured(rt)) return 'Set up the connection first: /wa setup'
  const listed = await waCall($, rt, api.groups(rt.sessionId))
  const groups = parseGroups(listed.json)
  if (arg === '' && rt.settings.autoCreateGroup && rt.mode !== 'self') {
    const created = await createProjectGroup($, rt)
    if (projectGroup(rt) !== undefined) return created
    await update($, groupAtom, card => ({ ...card, note: created, choices: groups.map(({ id, name }) => ({ id, name })) }))
    return `${created}\n${groupListText(groups)}`
  }
  if (arg === '') {
    await update($, groupAtom, card => ({ ...card, choices: groups.map(({ id, name }) => ({ id, name })) }))
    return groupListText(groups)
  }
  const index = Number(arg)
  const picked = Number.isInteger(index) && index >= 1 ? groups[index - 1] : groups.find(group => group.id === arg || group.name.toLowerCase() === arg.toLowerCase())
  if (picked === undefined) return `No such group. ${groupListText(groups)}`
  await linkGroup($, rt, picked.id, picked.name)
  return `Linked "${picked.name}" to ${rt.project}. Updates for this project now go there.`
}

const groupListText = (groups: readonly { id: string; name: string; participantsCount: number }[]): string =>
  groups.length === 0
    ? 'The bot number is in no group yet: create one on your phone with the bot in it, then /wa link-project again.'
    : `Groups the bot is in — /wa link-project <n>:\n${groups.map((group, index) => `${index + 1}. ${group.name} (${plural(group.participantsCount, 'member')})`).join('\n')}`

/** Where this project's messages go: its group (created on first use when allowed), else the owner's chat. */
async function projectChat($: EngineInterface, rt: Runtime): Promise<string> {
  const linked = projectGroup(rt)
  if (linked !== undefined) return linked.groupId
  if (rt.settings.autoCreateGroup && !rt.triedGroup && rt.mode === 'bot' && isConfigured(rt)) {
    rt.triedGroup = true
    const outcome = await createProjectGroup($, rt)
    const created = projectGroup(rt)
    if (created !== undefined) return created.groupId
    await refreshGroupCard($, rt, outcome)
    $.ui.toast(`📱 ${oneLine(outcome, 140)}`)
  }
  return ownerChat(rt)
}

/** Owner-only alerts (cost, approvals) go to the owner's chat unless allowed in the group. */
async function alertChat($: EngineInterface, rt: Runtime, isOwnerOnly: boolean): Promise<string> {
  return isOwnerOnly && !rt.settings.ownerOnlyAlertsInGroup ? ownerChat(rt) : projectChat($, rt)
}

// ── Notifications ────────────────────────────────────────────────────────────────────────────────

type Notice = { text: string; priority: WaPriority; event?: WaEventKey; isOwnerOnly?: boolean; quotedId?: string; kind?: string; isRouted?: boolean }

/** The newest keystroke or prompt in any live session: away is judged across the machine. */
async function lastActivity($: EngineInterface, rt: Runtime): Promise<{ lastActiveAt: number; sentTimes: number[] }> {
  const files = await readSessionFiles($, rt, LIVE_MS * 4)
  return {
    lastActiveAt: Math.max(rt.lastActiveAt, ...files.map(file => file.info.lastActiveAt)),
    sentTimes: files.flatMap(file => (file.info.id === rt.me ? rt.file.sentTimes : file.sentTimes)),
  }
}

/**
 * The one door for automatic updates and Claude's notify: the event's toggle, then the priority, away,
 * quiet hours, pause and the hourly cap decide whether it goes now, waits for the digest, or is dropped.
 */
async function emit($: EngineInterface, rt: Runtime, notice: Notice): Promise<{ action: 'send' | 'digest' | 'drop'; reason: string; messageId: string }> {
  if (!isConfigured(rt)) return { action: 'drop', reason: 'WhatsApp is not set up (/wa setup)', messageId: '' }
  if (notice.event !== undefined && !rt.prefs.events[notice.event]) return { action: 'drop', reason: `${EVENT_LABELS[notice.event]} is switched off`, messageId: '' }
  await refreshHub($, rt)
  const now = await $.clock.now()
  const activity = await lastActivity($, rt)
  const delivery = decide({
    priority: notice.priority,
    now,
    prefs: attention(rt),
    // The hub already judged presence for what it routes here; off still means off.
    notifyMode: notice.isRouted === true && rt.settings.notifyMode !== 'off' ? 'always' : rt.settings.notifyMode,
    lastActiveAt: activity.lastActiveAt,
    sentTimes: activity.sentTimes,
    maxPerHour: rt.settings.maxPerHour,
  })
  if (delivery.action === 'digest') {
    await toDigest($, rt, notice.text)
    await appendLog($, rt, { dir: 'held', chatId: '', kind: notice.kind ?? notice.event ?? 'notify', text: `${delivery.reason}: ${notice.text}` })
    return { ...delivery, messageId: '' }
  }
  if (delivery.action === 'drop') return { ...delivery, messageId: '' }
  const chatId = await alertChat($, rt, notice.isOwnerOnly === true)
  const messageId = await waSendText($, rt, { chatId, text: notice.text, kind: notice.kind ?? notice.event ?? 'notify', ...(notice.quotedId !== undefined ? { quotedId: notice.quotedId } : {}) })
  return messageId === '' ? { action: 'drop', reason: 'the send failed (see /wa log)', messageId } : { ...delivery, messageId }
}

async function toDigest($: EngineInterface, rt: Runtime, text: string): Promise<void> {
  const at = await $.clock.now()
  const seq = Math.max(0, ...rt.file.digest.map(item => item.seq)) + 1
  rt.file.digest = [...rt.file.digest, { seq, at, text: oneLine(text, 300), session: tagOf(rt) }].slice(-80)
  await saveSelf($, rt)
}

async function park($: EngineInterface, rt: Runtime, question: string): Promise<void> {
  const at = await $.clock.now()
  const seq = Math.max(0, ...rt.file.parked.map(item => item.seq)) + 1
  rt.file.parked = [...rt.file.parked, { seq, at, text: oneLine(question, 400), session: tagOf(rt) }].slice(-30)
  await saveSelf($, rt)
}

/** Remembers a message the owner can answer or react to; the leader watches its reactions. */
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

// ── The leader: one session polls OpenWA for all ─────────────────────────────────────────────────

/** Renews, takes or follows the lease. A taken lease is trusted only once read back on the next beat. */
async function tickLease($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.isInteractive || !isConfigured(rt)) return
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
  rt.pollTimer?.cancel()
  rt.pollTimer = undefined
  await update($, connectionAtom, connection => ({ ...connection, isLeader: false }))
}

async function startPolling($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.pollTimer !== undefined) return
  const stored = await readJsonFile($, paths.leader(rt))
  rt.leader = { ...emptyLeader(), ...(isRecord(stored) ? (stored as Partial<LeaderState>) : {}) }
  schedulePoll($, rt, 0)
}

function schedulePoll($: EngineInterface, rt: Runtime, ms: number): void {
  rt.pollTimer?.cancel()
  rt.pollTimer = $.clock.after(ms, () => {
    rt.pollTimer = undefined
    void pollRound($, rt).catch(error => $.ui.log(`${NAME}: poll failed: ${messageOf(error)}`, { to: 'debug' }))
  })
}

/** One round of the leader: new messages, reactions on open questions, schedules; then the next round. */
async function pollRound($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.isLeader || !rt.leaseVerified) return
  const now = await $.clock.now()
  let busy = false
  if (now >= rt.backoffUntil) {
    const files = await readSessionFiles($, rt, SESSION_FILE_FRESH_MS)
    busy = await pollMessages($, rt, files)
    rt.polls += 1
    if (rt.polls % REACTION_EVERY_POLLS === 0) await pollReactions($, rt, files)
    const anyAway = isAway(attention(rt), Math.max(...files.map(file => file.info.lastActiveAt), rt.lastActiveAt), now)
    const anyOpen = files.some(file => file.pending.some(item => item.kind !== 'alert'))
    busy = busy || anyAway || anyOpen || now - rt.lastInboundAt < 5 * 60_000
    await leaderSchedules($, rt, files)
    if (rt.leader !== undefined) await writeJsonFile($, paths.leader(rt), rt.leader)
  }
  if (!rt.isLeader) return
  const targets = rt.scoped ? allowlist(rt).length : 1
  const wait = Math.max(pollInterval({ baseSeconds: rt.settings.pollSeconds, targets, isBusy: busy }), rt.backoffUntil - (await $.clock.now()))
  schedulePoll($, rt, wait)
}

/**
 * Reads what is new since the cursor of each target (one global listing, or one per allowlisted chat with
 * a chat-scoped key), oldest first, and handles each row once. Rows of other chats are dropped unread.
 */
async function pollMessages($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<boolean> {
  const leader = rt.leader ?? emptyLeader()
  rt.leader = leader
  const targets: (string | undefined)[] = rt.scoped ? allowlist(rt) : [undefined]
  let handled = 0
  for (const chatId of targets) {
    const key = chatId ?? '*'
    const cursor = leader.cursors[key]
    const direction = rt.mode === 'self' ? undefined : ('incoming' as const)
    const fresh: WaRow[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await waCall($, rt, api.messages(rt.sessionId, { limit: PAGE_LIMIT, ...(chatId !== undefined ? { chatId } : {}), ...(after !== undefined ? { after } : {}), ...(direction !== undefined ? { direction } : {}) }))
      if (!result.ok) {
        if (result.status !== 429) {
          rt.backoffMs = backoff(rt.backoffMs, undefined)
          rt.backoffUntil = (await $.clock.now()) + rt.backoffMs
        }
        return handled > 0
      }
      rt.backoffMs = 0
      const rows = parseRows(result.json)
      if (cursor === undefined) {
        // First run: start from now, never replay history.
        const newest = rows[0]
        leader.cursors[key] = { id: newest?.id ?? '', createdAt: newest?.createdAt ?? new Date(await $.clock.now()).toISOString() }
        break
      }
      const step = walkPage(rows, cursor, PAGE_LIMIT)
      fresh.push(...step.fresh)
      if (step.isDone || step.after === undefined) break
      after = step.after
    }
    const newest = fresh[0]
    if (newest !== undefined) leader.cursors[key] = { id: newest.id, createdAt: newest.createdAt }
    for (const row of fresh.reverse()) {
      const seenKey = `row:${row.id}`
      if (leader.seen.includes(seenKey)) continue
      leader.seen = remember(leader.seen, [seenKey])
      if (await handleRow($, rt, files, row)) handled += 1
    }
  }
  if (handled > 0) rt.lastInboundAt = await $.clock.now()
  return handled > 0
}

/** Who wrote a row: the owner, a member, or the bot itself (its own sends are skipped). */
async function senderOf($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow): Promise<'owner' | 'member' | 'bot'> {
  if (row.direction === 'outgoing') {
    const isOurs = row.body.endsWith(BOT_MARK) || files.some(file => file.sentIds.includes(row.waMessageId)) || rt.file.sentIds.includes(row.waMessageId)
    return isOurs || rt.mode !== 'self' ? 'bot' : 'owner'
  }
  const id = row.author ?? row.from
  let phone = phoneOf(id)
  if (phone === '' && id.endsWith('@lid')) phone = await resolveLid($, rt, id)
  return isOwnerPhone(phone, rt.owners) ? 'owner' : 'member'
}

async function resolveLid($: EngineInterface, rt: Runtime, lid: string): Promise<string> {
  const leader = rt.leader ?? emptyLeader()
  const cached = leader.lidPhones[lid]
  if (cached !== undefined) return cached
  const result = await waCall($, rt, api.contactPhone(rt.sessionId, lid))
  const phone = isRecord(result.json) && typeof result.json.phone === 'string' ? result.json.phone.replace(/\D/g, '') : ''
  if (result.ok) leader.lidPhones[lid] = phone
  return phone
}

const sentIndex = (files: readonly SessionFile[]): Map<string, string> => {
  const index = new Map<string, string>()
  for (const file of files) for (const id of file.sentIds) index.set(id, file.info.id)
  return index
}

/** Handles one new row: allowlist first (anything else is dropped unread), then owner or member. */
async function handleRow($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow): Promise<boolean> {
  if (!isAllowed(rt, row.chatId)) return false
  const who = await senderOf($, rt, files, row)
  if (who === 'bot') return false
  const now = await $.clock.now()
  const sessions = files.map(file => file.info)
  const sentBy = sentIndex(files)
  const text = row.body
  if (who === 'member') {
    if (!isGroupChat(row.chatId)) return false
    return handleMemberRow($, rt, files, row, now)
  }
  const parsed = parseCommand(text, rt.settings.pin)
  const isTagged = /^\s*[#@][\p{L}\p{N}_.-]/u.test(text)
  // A tag picks a session for status and prompts; every other command is about all sessions anyway.
  const isGlobal = !(isTagged && parsed.command.kind === 'status')
  if (isGlobal && (await handleGlobalCommand($, rt, files, row, parsed.command, parsed.needsPin && !parsed.hasPin))) return true
  const kind = parsed.command.kind
  const mayAnswer = !isTagged && row.quotedId === undefined && (kind === 'prompt' || kind === 'approve' || kind === 'reject')
  // An unquoted "2" or "sì" answers the newest open question in this chat, whichever session asked it.
  const waiting = mayAnswer
    ? files
        .flatMap(file => file.pending.filter(item => item.chatId === row.chatId && item.expiresAt > now && item.kind !== 'alert' && item.kind !== 'preview').map(item => ({ item, id: file.info.id })))
        .filter(({ id }) => sessions.some(session => session.id === id && isLive(session, now)))
        .sort((a, b) => b.item.createdAt - a.item.createdAt)[0]
    : undefined
  const routed = waiting !== undefined
    ? { sessionId: waiting.id, text, reason: 'reply' as const }
    : route({ chatId: row.chatId, text, now, ...(row.quotedId !== undefined ? { quotedId: row.quotedId } : {}) }, { sessions, sentBy, groups: rt.groups })
  const target = routed.sessionId === null ? undefined : sessions.find(session => session.id === routed.sessionId)
  // In the owner's direct chat, a project that has its own group is steered from that group.
  if (target !== undefined && !isGroupChat(row.chatId) && routed.reason !== 'reply' && rt.groups[target.root] !== undefined) {
    const group = rt.groups[target.root]?.name ?? 'its group'
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'reply', text: `🤖 ${target.project} is steered from its group "${group}": send it there.` })
    return true
  }
  if (routed.sessionId === null) {
    const why =
      routed.reason === 'unknown-tag'
        ? `No live session is tagged ${routed.detail}. Send *sessions* to list them.`
        : routed.reason === 'no-project-session'
          ? `No Claude Code session is running for ${routed.detail.split('/').at(-1) ?? 'this project'} right now.`
          : 'No Claude Code session is running right now.'
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'reply', text: `🤖 ${why}` })
    return true
  }
  await deliver($, rt, routed.sessionId, {
    key: `row:${row.id}`,
    at: now,
    kind: 'owner',
    chatId: row.chatId,
    messageId: row.waMessageId,
    author: row.author ?? row.from,
    text: routed.text,
    ...(row.quotedId !== undefined ? { quotedId: row.quotedId } : {}),
    ...(row.media !== undefined && row.type !== 'text' ? { media: { type: row.type, mimetype: row.media.mimetype, ...(row.media.filename !== undefined ? { filename: row.media.filename } : {}) } } : {}),
  })
  return true
}

/** A group member's message: only when meant for Claude (mention, reply, trigger word, bug report), within the limits. */
async function handleMemberRow($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow, now: number): Promise<boolean> {
  const sentBy = sentIndex(files)
  const trigger = memberTrigger(row.body, {
    triggers: rt.settings.memberTriggers,
    botPhone: rt.botPhone,
    isReplyToBot: row.quotedId !== undefined && sentBy.has(row.quotedId),
  })
  if (!trigger.isTriggered) return false
  const event: WaEventKey = trigger.isBug ? 'bugReports' : 'memberQuestions'
  if (!rt.prefs.events[event]) return false
  // A bug draft asks the owner for a 👍: an interaction, so only while interaction is on.
  if (trigger.isBug && !canInteract(rt, now)) return false
  const leader = rt.leader ?? emptyLeader()
  const member = row.author ?? row.from
  const quota = takeQuota(leader.book, member, now, dayKey(now), { perTenMinutes: rt.settings.memberRate, dailyCap: rt.settings.memberDailyCap })
  leader.book = quota.book
  if (!quota.isAllowed) {
    await appendMemberLog($, rt, { at: now, member: memberName(row), question: trigger.text, answer: '', outcome: 'limited' })
    return false
  }
  const root = projectOfChat(rt.groups, row.chatId)
  const target = files
    .map(file => file.info)
    .filter(session => session.root === root && isLive(session, now))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  if (target === undefined) {
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'member', audience: 'member', text: '🤖 Claude is not running for this project right now; the owner will see your message.' })
    return true
  }
  await deliver($, rt, target.id, {
    key: `row:${row.id}`,
    at: now,
    kind: trigger.isBug ? 'bug' : 'member',
    chatId: row.chatId,
    messageId: row.waMessageId,
    author: memberName(row),
    text: trigger.text,
  })
  return true
}

const memberName = (row: WaRow): string => {
  const id = row.author ?? row.from
  const phone = phoneOf(id)
  return phone !== '' ? `+${phone.slice(0, -4).replace(/\d/g, '•')}${phone.slice(-4)}` : 'a member'
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

/** Reactions on the questions and alerts sessions wait on: the owner's 👍 ❌ ⏸ 🔁 go to that session. */
async function pollReactions($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  for (const file of files) {
    for (const item of file.pending.filter(one => one.expiresAt > now && one.messageId !== '').slice(-6)) {
      if (!isAllowed(rt, item.chatId)) continue
      const result = await waCall($, rt, api.messages(rt.sessionId, { chatId: item.chatId, messageId: item.messageId, limit: 1 }))
      const row = parseRows(result.json)[0]
      if (row === undefined) continue
      for (const [reactor, emoji] of Object.entries(row.reactions)) {
        const key = `reaction:${item.messageId}:${reactor}:${emoji}`
        if (leader.seen.includes(key)) continue
        leader.seen = remember(leader.seen, [key])
        let phone = phoneOf(reactor)
        if (phone === '' && reactor.endsWith('@lid')) phone = await resolveLid($, rt, reactor)
        const isOwner = isOwnerPhone(phone, rt.owners) || (rt.mode === 'self' && phone === rt.botPhone)
        if (!isOwner || reactionMeaning(emoji) === undefined) continue
        await deliver($, rt, file.info.id, { key, at: now, kind: 'reaction', chatId: item.chatId, messageId: item.messageId, author: reactor, text: '', emoji, targetId: item.messageId })
      }
    }
  }
}

/**
 * Commands about every session the leader answers itself (status, sessions, digest, cost, report, pause,
 * presence, interaction, STOP ALL, help). In a project group they only cover that project.
 */
async function handleGlobalCommand(
  $: EngineInterface,
  rt: Runtime,
  files: SessionFile[],
  row: WaRow,
  command: PhoneCommand,
  isMissingPin: boolean,
): Promise<boolean> {
  const now = await $.clock.now()
  const groupRoot = projectOfChat(rt.groups, row.chatId)
  const live = files.map(file => file.info).filter(session => isLive(session, now) && (groupRoot === undefined || session.root === groupRoot))
  const reply = (text: string): Promise<string> => waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'command', text })
  switch (command.kind) {
    case 'help':
      await reply(HELP_TEXT)
      return true
    case 'status':
      await reply(statusText(live, now, `\n\n_Interaction: ${interactionText(rt, now)}${rt.prefs.paused ? ' · notifications paused' : ''}_`))
      return true
    case 'sessions':
      await reply(sessionsText(live, now))
      return true
    case 'digest':
      await sendDigest($, rt, files, 'now', row.chatId)
      return true
    case 'cost': {
      const chat = groupRoot !== undefined && !rt.settings.ownerOnlyAlertsInGroup ? ownerChat(rt) : row.chatId
      const today = dayKey(now)
      const spent = files.reduce((sum, file) => sum + (file.stats.costByDay[today] ?? 0), 0)
      await waSendText($, rt, { chatId: chat, kind: 'cost', text: costText(live, spent) })
      if (chat !== row.chatId) await reply('🤖 Sent the cost to your direct chat.')
      return true
    }
    case 'report':
      await sendReport($, rt, files, groupRoot !== undefined && !rt.settings.ownerOnlyAlertsInGroup ? ownerChat(rt) : row.chatId)
      return true
    case 'pause':
    case 'resume':
      await savePrefs($, rt, prefs => ({ ...prefs, paused: command.kind === 'pause' }))
      await reply(command.kind === 'pause' ? '⏸ Notifications paused (critical ones still come). Send *resume* to go on.' : '▶️ Notifications resumed.')
      return true
    case 'away':
    case 'here':
      if ((await changeOnHub($, rt, { presence: command.kind }, 'channel')) === undefined) await savePrefs($, rt, prefs => ({ ...prefs, presence: command.kind }))
      await reply(command.kind === 'away' ? '🚶 Marked away: updates come here.' : '💻 Marked at the keyboard: only critical updates come here.')
      return true
    case 'interact':
      if ((await changeOnHub($, rt, { interaction: command.isOn ? 'on' : 'off' }, 'channel')) === undefined) await savePrefs($, rt, prefs => ({ ...prefs, interaction: command.isOn ? 'on' : 'off' }))
      await reply(command.isOn ? '💬 Interaction on: Claude may ask you things and request approvals here.' : '🔕 Interaction off (silent mode): Claude will not ask; questions are parked until you turn it back on.')
      if (command.isOn) await deliverParked($, rt, files, row.chatId)
      return true
    case 'night': {
      const onHub = await changeOnHub($, rt, { night: true }, 'channel')
      if (onHub !== undefined) {
        await reply(`🌙 Night mode on (mods-hub, ${onHub.quietHours}): no questions then, only critical messages; the rest comes in the morning digest.`)
        return true
      }
      const until = windowEnd(rt.settings.interactionOffHours, now)
      await savePrefs($, rt, prefs => ({ ...prefs, interaction: 'night', nightUntil: until }))
      await reply(`🌙 Night mode until ${clockTime(until)}: no questions, only the updates you enabled.`)
      return true
    }
    case 'stopAll': {
      if (isMissingPin) {
        await reply('🔒 STOP ALL needs your PIN: send "STOP ALL <pin>".')
        return true
      }
      for (const session of live) {
        await deliver($, rt, session.id, { key: `row:${row.id}:${session.id}`, at: now, kind: 'owner', chatId: row.chatId, messageId: row.waMessageId, author: row.author ?? row.from, text: 'stop' })
      }
      // With mods-hub: control.stop for every session, so what runs on its own (autopilot, queues) stops too.
      await hubStop($, { action: 'stop', scope: 'all', reason: 'STOP ALL from WhatsApp', by: 'owner via whatsapp' })
      await reply(`⏹ Stopping ${plural(live.length, 'session')}.`)
      return true
    }
    default:
      return false
  }
}

/** Morning briefing, evening digest and the periodic digest: the leader's own schedule. */
async function leaderSchedules($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  const previous = leader.lastCheck
  leader.lastCheck = now
  const interactive = canInteract(rt, now)
  if (interactive && !leader.wasInteractive) await deliverParked($, rt, files, ownerChat(rt))
  leader.wasInteractive = interactive
  const activeSince = (since: number): SessionFile[] => files.filter(file => file.info.lastActiveAt > since || file.info.lastSeen > since)
  if (rt.prefs.events.briefing && crossed(parseClock(rt.settings.briefingTime), previous, now) && activeSince(now - 24 * 60 * 60_000).length > 0) {
    const text = briefingText('morning', activeSince(now - 24 * 60 * 60_000).map(file => file.info), now)
    await waSendText($, rt, { chatId: ownerChat(rt), kind: 'briefing', text })
    await deliverParked($, rt, files, ownerChat(rt))
  }
  if (rt.prefs.events.evening && crossed(parseClock(rt.settings.eveningTime), previous, now) && activeSince(now - 12 * 60 * 60_000).length > 0) {
    await sendDigest($, rt, files, 'evening', ownerChat(rt))
    if (rt.prefs.events.visualReports) await sendReport($, rt, files, ownerChat(rt))
  }
  if (now - leader.lastDigestAt >= rt.settings.digestMinutes * 60_000) {
    if (leader.lastDigestAt === 0) leader.lastDigestAt = now
    else await sendDigest($, rt, files, 'periodic', ownerChat(rt))
  }
}

/** Sends what the sessions held for the digest since the last one (nothing when nothing is new, unless asked). */
async function sendDigest($: EngineInterface, rt: Runtime, files: SessionFile[], why: 'now' | 'periodic' | 'evening', chatId: string): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  const items = files.flatMap(file => file.digest.filter(item => item.seq > (leader.digestSeq[file.info.id] ?? 0)))
  const parked = canInteract(rt, now) ? files.flatMap(file => file.parked.filter(item => item.seq > (leader.parkedSeq[file.info.id] ?? 0))) : []
  if (why === 'periodic' && items.length === 0) {
    leader.lastDigestAt = now
    return
  }
  if (why === 'periodic' && (rt.prefs.paused || !isAway(attention(rt), Math.max(...files.map(file => file.info.lastActiveAt), rt.lastActiveAt), now))) return
  const title = why === 'evening' ? '🌙 *Evening digest*' : '🗞 *Digest*'
  const header = why === 'evening' ? `${briefingText('evening', files.map(file => file.info).filter(info => now - info.lastSeen < 12 * 60 * 60_000), now)}\n\n` : ''
  const sent = await waSendText($, rt, { chatId, kind: 'digest', text: header + digestText(items.sort((a, b) => a.at - b.at), parked, title) })
  if (sent === '') return
  leader.lastDigestAt = now
  for (const file of files) {
    const top = Math.max(0, ...file.digest.map(item => item.seq))
    if (top > 0) leader.digestSeq[file.info.id] = top
    if (parked.length > 0) leader.parkedSeq[file.info.id] = Math.max(0, ...file.parked.map(item => item.seq))
  }
}

/** Parked questions, once interaction is back on (or the morning comes). */
async function deliverParked($: EngineInterface, rt: Runtime, files: SessionFile[], chatId: string): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const parked = files.flatMap(file => file.parked.filter(item => item.seq > (leader.parkedSeq[file.info.id] ?? 0)))
  if (parked.length === 0) return
  const sent = await waSendText($, rt, { chatId, kind: 'parked', text: digestText([], parked, '🅿️ *While interaction was off*') })
  if (sent === '') return
  for (const file of files) leader.parkedSeq[file.info.id] = Math.max(leader.parkedSeq[file.info.id] ?? 0, ...file.parked.map(item => item.seq))
}

// ── Every session: its inbox ─────────────────────────────────────────────────────────────────────

/** Reads this session's inbox and handles each new entry once (by seq and key), in order. */
async function consumeInbox($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isConsuming || rt.me === '' || rt.dir === '') return
  rt.isConsuming = true
  try {
    const entries = ((await readLines($, paths.inbox(rt, rt.me))).filter(isRecord) as unknown as InboxEntry[]).sort((a, b) => a.seq - b.seq)
    for (const entry of entries) {
      if (entry.seq <= rt.doneSeq && rt.doneIds.includes(entry.key)) continue
      if (rt.doneIds.includes(entry.key)) continue
      rt.doneIds = [...rt.doneIds, entry.key].slice(-DONE_KEEP)
      rt.doneSeq = Math.max(rt.doneSeq, entry.seq)
      await writeJsonFile($, paths.done(rt, rt.me), { seq: rt.doneSeq, ids: rt.doneIds })
      try {
        await handleEntry($, rt, entry)
      } catch (error) {
        $.ui.log(`${NAME}: could not handle a WhatsApp message: ${messageOf(error)}`, { to: 'debug' })
      }
    }
  } finally {
    rt.isConsuming = false
  }
}

async function handleEntry($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const who = entry.kind === 'member' || entry.kind === 'bug' ? 'member' : 'owner'
  await appendLog($, rt, { dir: 'in', chatId: entry.chatId, kind: entry.kind, text: entry.emoji ?? entry.text, messageId: entry.messageId, who })
  await publishInbound($, rt, entry, who)
  switch (entry.kind) {
    case 'reaction':
      return handleReaction($, rt, entry)
    case 'member':
      return answerMember($, rt, entry)
    case 'bug':
      return draftBug($, rt, entry)
    case 'owner':
      return handleOwner($, rt, entry)
  }
}

const replyTo = (entry: InboxEntry, text: string): SendInput => ({ chatId: entry.chatId, quotedId: entry.messageId, kind: 'reply', text })

/** An owner's message: an answer to a pending question, a command, media, or a prompt for Claude. */
async function handleOwner($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const now = await $.clock.now()
  const parsed = parseCommand(entry.text, rt.settings.pin)
  const { command } = parsed
  const pending = pendingFor(rt.file.pending, entry.chatId, entry.quotedId, now)
  if (pending !== undefined && (command.kind === 'prompt' || command.kind === 'approve' || command.kind === 'reject') && entry.media === undefined) {
    const answer = matchAnswer(pending, { text: entry.text })
    // A confirmation, an approval or a bug draft takes yes / no only: other words are a new request.
    const takesFreeText = pending.kind === 'ask' || pending.kind === 'preview'
    if (answer !== null && (takesFreeText || answer.verdict !== undefined)) return resolvePending($, rt, pending, answer, entry)
    if (pending.kind === 'confirm') await dropPending($, rt, pending.id)
  }
  if (parsed.needsPin && !parsed.hasPin) {
    await waSendText($, rt, replyTo(entry, '🔒 That needs your PIN: add it to the message (e.g. "/compact 1234").'))
    return
  }
  switch (command.kind) {
    case 'stop':
      // With mods-hub: control.stop for this session, so what runs on its own here (autopilot, queues) stops too.
      await hubStop($, { action: 'stop', scope: 'session', reason: 'STOP from WhatsApp', by: 'owner via whatsapp' })
      if (rt.state === 'working' && rt.turnId !== undefined) {
        const turnId = rt.turnId
        await $.turn.abort({ turnId }).catch(() => undefined)
        await waSendText($, rt, replyTo(entry, `⏹ Stopped #${rt.label}.`))
      } else {
        await waSendText($, rt, replyTo(entry, `#${rt.label} is idle: nothing to stop.`))
      }
      return
    case 'queue':
      return queueTask($, rt, entry, command.task)
    case 'slash':
      rt.phoneQueue.push({ text: `/${command.command}${command.args !== '' ? ` ${command.args}` : ''}`, chatId: entry.chatId, messageId: entry.messageId })
      await drainPhoneQueue($, rt)
      return
    case 'retry': {
      const last = rt.lastPrompt
      if (last === '') await waSendText($, rt, replyTo(entry, 'Nothing to retry yet.'))
      else await submitPhonePrompt($, rt, { text: `Retry this task: ${last}`, chatId: entry.chatId, messageId: entry.messageId })
      return
    }
    case 'approve':
    case 'reject':
      await waSendText($, rt, replyTo(entry, 'Nothing is waiting for your approval.'))
      return
    case 'prompt':
      break
    default:
      // A command the leader answers for every session; routed here when tagged: answer for this one.
      await waSendText($, rt, replyTo(entry, statusText([rt.file.info], now, '')))
      return
  }
  let text = command.text
  if (entry.media !== undefined) text = await receiveMedia($, rt, entry)
  if (text.trim() === '') return
  if (!canInteract(rt, now)) {
    await waSendText($, rt, replyTo(entry, '🌙 Interaction is off right now. Send *interact on* first, then your request again.'))
    return
  }
  if (rt.prefs.events.confirmPrompts && entry.media === undefined) {
    const question = `▶️ Run this on *#${rt.label}* (${rt.project})?\n«${oneLine(text, 300)}»\n\n_Reply sì/no or react 👍 / ❌._`
    const messageId = await waSendText($, rt, replyTo(entry, question))
    if (messageId !== '') {
      await addPending($, rt, { id: `confirm-${entry.messageId}`, kind: 'confirm', question: text, options: ['Sì', 'No'], chatId: entry.chatId, messageId, expiresAt: now + CONFIRM_TTL_MS, payload: text })
    }
    return
  }
  await submitPhonePrompt($, rt, { text, chatId: entry.chatId, messageId: entry.messageId })
}

/** The owner answered a pending item (by text or reaction): settle it the way its kind asks. */
async function resolvePending($: EngineInterface, rt: Runtime, pending: Pending, answer: Answer, entry: InboxEntry): Promise<void> {
  await dropPending($, rt, pending.id)
  switch (pending.kind) {
    case 'ask':
      if (rt.waiting.has(pending.id)) rt.answers.set(pending.id, answer)
      else rt.lateAnswers.push(`The user answered your earlier WhatsApp question «${oneLine(pending.question, 160)}»: ${answer.text}`)
      await waSendText($, rt, replyTo(entry, `✅ Got it: «${oneLine(answer.text, 80)}» → #${rt.label}`))
      await drainPhoneQueue($, rt)
      return
    case 'permission':
      rt.answers.set(pending.id, answer)
      return
    case 'confirm':
      if (answer.verdict === 'approve') await submitPhonePrompt($, rt, { text: pending.payload ?? pending.question, chatId: pending.chatId, messageId: pending.messageId })
      else await waSendText($, rt, replyTo(entry, answer.verdict === 'reject' ? '👌 Cancelled.' : '👌 Not run. Send the request again to start over.'))
      return
    case 'preview':
      if (answer.verdict === 'approve') {
        await waSendText($, rt, replyTo(entry, '👍 Noted.'))
        return
      }
      await submitPhonePrompt($, rt, {
        text: `The owner rejected the UI screenshot ${pending.payload ?? ''} on WhatsApp${answer.verdict === undefined ? ` and asked: ${answer.text}` : ''}. Fix the UI accordingly.`,
        chatId: pending.chatId,
        messageId: pending.messageId,
      })
      return
    case 'bug':
      if (answer.verdict === 'approve') await fileIssue($, rt, pending, entry)
      else await waSendText($, rt, replyTo(entry, '🗑 Bug draft discarded.'))
      return
    case 'alert':
      if (answer.verdict === 'approve') await waSendText($, rt, replyTo(entry, '👍'))
      return
  }
}

async function handleReaction($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const pending = rt.file.pending.find(item => item.messageId === entry.targetId)
  const meaning = reactionMeaning(entry.emoji ?? '')
  if (meaning === 'pause') {
    await savePrefs($, rt, prefs => ({ ...prefs, paused: true }))
    await waSendText($, rt, { chatId: entry.chatId, kind: 'reply', text: '⏸ Notifications paused. Send *resume* to go on.' })
    return
  }
  if (pending === undefined) return
  if (meaning === 'retry') {
    if (pending.kind === 'alert' && pending.payload !== undefined) {
      await dropPending($, rt, pending.id)
      await submitPhonePrompt($, rt, { text: `Retry: ${pending.payload}`, chatId: pending.chatId, messageId: pending.messageId })
    }
    return
  }
  const answer = matchAnswer(pending, { emoji: entry.emoji ?? '' })
  if (answer !== null) await resolvePending($, rt, pending, answer, { ...entry, messageId: pending.messageId })
}

/** Runs a phone prompt as the owner's words when Claude is idle; otherwise it waits its turn. */
async function submitPhonePrompt($: EngineInterface, rt: Runtime, item: { text: string; chatId: string; messageId: string }): Promise<void> {
  rt.phoneQueue.push(item)
  if (rt.state === 'working' || rt.isSubmitting) {
    await waSendText($, rt, { chatId: item.chatId, quotedId: item.messageId, kind: 'reply', text: `⏳ Queued for #${rt.label}: Claude is busy and will start it next.` })
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
    if (item.text.startsWith('/')) {
      const [name = '', ...rest] = item.text.slice(1).split(' ')
      const ran = await $.command.run({ command: name, args: rest.join(' ') })
      await waSendText($, rt, { chatId: item.chatId, quotedId: item.messageId, kind: 'reply', text: `✅ /${name} ran${ran.text !== undefined && ran.text !== '' ? `:\n${oneLine(ran.text, 600)}` : '.'}` })
      return
    }
    rt.phoneTurn = { chatId: item.chatId, messageId: item.messageId }
    const submitted = await $.prompt.submit({ text: phonePrompt(item.text), asUser: true })
    if (submitted.drop !== undefined) {
      rt.phoneTurn = undefined
      await waSendText($, rt, { chatId: item.chatId, quotedId: item.messageId, kind: 'reply', text: `❌ Not run: ${oneLine(submitted.drop, 200)}` })
    } else {
      void waCall($, rt, api.react(rt.sessionId, item.chatId, item.messageId, '👀'))
    }
  } catch (error) {
    rt.phoneTurn = undefined
    await waSendText($, rt, { chatId: item.chatId, quotedId: item.messageId, kind: 'reply', text: `❌ Could not run it: ${oneLine(messageOf(error), 200)}` })
  } finally {
    rt.isSubmitting = false
  }
}

/** `queue <task>`: into task-queue's /queue when that mod is installed, else a Markdown list in the project. */
async function queueTask($: EngineInterface, rt: Runtime, entry: InboxEntry, task: string): Promise<void> {
  const commands = await $.command.list().catch(() => [])
  if (commands.some(command => command.name === 'queue')) {
    rt.phoneQueue.push({ text: `/queue ${task}`, chatId: entry.chatId, messageId: entry.messageId })
    await drainPhoneQueue($, rt)
    return
  }
  const path = paths.queue(rt)
  const before = await $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '# Tasks queued from WhatsApp\n\n')
  await $.fs.write(path, `${before.trimEnd()}\n- [ ] ${oneLine(task, 500)} _(${dayKey(await $.clock.now())})_\n`)
  await waSendText($, rt, replyTo(entry, `📝 Saved to .claude/whatsapp/queue.md for #${rt.label}. (Install task-queue to run queued tasks automatically.)`))
}

/** Saves a photo, document or voice note from the phone under .claude/whatsapp/inbox/ and says where. */
async function receiveMedia($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<string> {
  const media = entry.media
  if (media === undefined) return entry.text
  const result = await waCall($, rt, api.messages(rt.sessionId, { chatId: entry.chatId, messageId: entry.messageId, limit: 1, inlineMedia: true }))
  const data = parseRows(result.json)[0]?.media?.data ?? ''
  const caption = entry.text.trim()
  if (data === '') return `${caption}\n\n(The user sent a ${media.type} from WhatsApp, but it could not be downloaded: it may be too large.)`.trim()
  const stamp = `${dayKey(await $.clock.now())}-${entry.messageId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}`
  const target = `${paths.media(rt)}/${stamp}.${extensionOf(media.mimetype, media.filename)}`
  const saved = await saveBase64($, rt, data, target)
  if (saved === '') return `${caption}\n\n(The user sent a ${media.type} from WhatsApp; it could not be saved.)`.trim()
  if (media.type === 'audio' || media.type === 'voice' || media.type === 'ptt') {
    const heard = await transcribe($, rt, saved)
    return heard !== ''
      ? `${heard}\n\n(Voice note from WhatsApp, transcribed locally with whisper; audio at ${saved})`
      : `${caption}\n\nThe user sent a voice note from WhatsApp, saved at ${saved}. No local whisper CLI is installed, so it is not transcribed; ask them to type it if needed.`.trim()
  }
  const what = media.type === 'image' ? 'an image (screenshot or photo)' : `a ${media.type}`
  return `${caption !== '' ? `${caption}\n\n` : ''}The user sent ${what} from WhatsApp, saved at ${saved}. Read it with the Read tool.`
}

/** Writes base64 bytes as a file: through a .b64 text file and the system's decoder (fs writes text only). */
async function saveBase64($: EngineInterface, rt: Runtime, base64: string, target: string): Promise<string> {
  const temp = `${target}.b64`
  try {
    await $.fs.write(temp, base64)
  } catch {
    return ''
  }
  const decoders: readonly (readonly string[])[] = [
    ['openssl', 'base64', '-d', '-A', '-in', temp, '-out', target],
    ['base64', '--decode', '-i', temp, '-o', target],
    ['python3', '-c', 'import base64,sys;open(sys.argv[2],"wb").write(base64.b64decode(open(sys.argv[1]).read()))', temp, target],
  ]
  for (const argv of decoders) {
    const ran = await $.process.run(argv, { timeoutMs: 20_000 }).catch(() => undefined)
    if (ran !== undefined && ran.exitCode === 0 && (await $.fs.exists(target).catch(() => false))) {
      await $.fs.write(temp, '').catch(() => undefined)
      return target
    }
  }
  return temp
}

async function transcribe($: EngineInterface, rt: Runtime, file: string): Promise<string> {
  if (rt.hasWhisper === false) return ''
  const dir = file.slice(0, file.lastIndexOf('/'))
  const ran = await $.process
    .run(['whisper', file, '--model', 'base', '--output_format', 'txt', '--output_dir', dir], { timeoutMs: 180_000 })
    .catch(() => undefined)
  rt.hasWhisper = ran !== undefined
  if (ran === undefined || ran.exitCode !== 0) return ''
  const txt = `${file.replace(/\.[^./]+$/, '')}.txt`
  const text = await $.fs.read(txt).catch(() => '')
  return typeof text === 'string' ? text.trim() : ''
}

/** A member's question: a tool-less fork over this session's transcript, cleaned for members. */
async function answerMember($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const now = await $.clock.now()
  const forked = await $.model.fork({ prompt: memberPrompt(entry.text, entry.author, rt.settings.shareCodeWithMembers) })
  let answer = forked.isAnswered ? forked.text : ''
  if (answer === '' && !forked.isAnswered && forked.reason === 'nothing-to-fork') {
    const done = await $.model.complete({
      model: 'haiku',
      prompt: `${memberPrompt(entry.text, entry.author, rt.settings.shareCodeWithMembers)}\nContext: project ${rt.project}, branch ${rt.branch}, current state ${rt.state}${rt.task !== '' ? `, working on: ${rt.task}` : ''}.`,
      maxTokens: 400,
      timeoutMs: 30_000,
    })
    answer = done.isAnswered ? done.text : ''
  }
  const text = answer === '' ? '🤖 I could not answer right now.' : `🤖 ${clean(answer, { audience: 'member', maxChars: 700, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text}`
  await waSendText($, rt, { chatId: entry.chatId, quotedId: entry.messageId, kind: 'member', audience: 'member', text })
  await appendMemberLog($, rt, { at: now, member: entry.author, question: entry.text, answer: text, outcome: answer === '' ? 'failed' : 'answered' })
}

/** A member's bug report: a drafted issue posted to the group; only the owner's 👍 files it with gh. */
async function draftBug($: EngineInterface, rt: Runtime, entry: InboxEntry): Promise<void> {
  const now = await $.clock.now()
  const done = await $.model.complete({ model: 'haiku', prompt: bugPrompt(entry.text, rt.project), maxTokens: 600, timeoutMs: 45_000 })
  const draft = parseIssueDraft(done.isAnswered ? done.text : '', oneLine(entry.text, 80))
  const body = clean(`${draft.body}\n\n_Reported on WhatsApp by ${entry.author}._`, { audience: 'member', maxChars: 2_500, root: rt.root }).text
  const title = clean(draft.title, { audience: 'member', maxChars: 120, root: rt.root }).text
  const messageId = await waSendText($, rt, {
    chatId: entry.chatId,
    quotedId: entry.messageId,
    kind: 'bug',
    audience: 'member',
    text: `🐞 *Draft issue:* ${title}\n\n${body}\n\n_Owner: react 👍 to file it on GitHub, ❌ to discard._`,
  })
  if (messageId !== '') {
    await addPending($, rt, { id: `bug-${entry.messageId}`, kind: 'bug', question: title, options: [], chatId: entry.chatId, messageId, expiresAt: now + BUG_TTL_MS, payload: JSON.stringify({ title, body }) })
  }
  await appendMemberLog($, rt, { at: now, member: entry.author, question: entry.text, answer: title, outcome: 'bug-draft' })
}

async function fileIssue($: EngineInterface, rt: Runtime, pending: Pending, entry: InboxEntry): Promise<void> {
  const draft = parseJson(pending.payload ?? '')
  const title = isRecord(draft) && typeof draft.title === 'string' ? draft.title : pending.question
  const body = isRecord(draft) && typeof draft.body === 'string' ? draft.body : ''
  const ran = await $.process.run(['gh', 'issue', 'create', '--title', title, '--body', body], { cwd: rt.root, timeoutMs: 60_000 }).catch(error => ({
    exitCode: 1,
    stdout: '',
    stderr: messageOf(error),
  }))
  const url = ran.stdout.trim().split('\n').at(-1) ?? ''
  await waSendText($, rt, {
    chatId: pending.chatId,
    quotedId: pending.messageId,
    kind: 'bug',
    audience: 'member',
    text: ran.exitCode === 0 ? `✅ Issue filed: ${url}` : `❌ Could not file the issue (${oneLine(ran.stderr, 160) || 'gh failed'}).`,
  })
  await appendMemberLog($, rt, { at: await $.clock.now(), member: entry.author, question: title, answer: url, outcome: 'bug-filed' })
}

async function appendMemberLog($: EngineInterface, rt: Runtime, qa: WaMemberQa): Promise<void> {
  const lines = (await readLines($, paths.members(rt))).slice(-99)
  await writeLines($, paths.members(rt), [...lines, qa])
  await update($, membersAtom, list => [...list, qa].slice(-20))
}

// ── Visual reports ───────────────────────────────────────────────────────────────────────────────

/** Finds an SVG→PNG converter once: rsvg-convert, ImageMagick, or a headless Chromium. */
async function findConverter($: EngineInterface, rt: Runtime): Promise<Converter> {
  if (rt.converter !== undefined) return rt.converter
  const probes: readonly (readonly string[])[] = [['rsvg-convert', '--version'], ['magick', '-version'], ['convert', '-version'], ['chromium', '--version'], ['google-chrome', '--version']]
  for (const argv of probes) {
    const ran = await $.process.run(argv, { timeoutMs: 8_000 }).catch(() => undefined)
    if (ran !== undefined && ran.exitCode === 0) {
      rt.converter = argv.slice(0, 1)
      return rt.converter
    }
  }
  rt.converter = null
  return null
}

async function renderChart($: EngineInterface, rt: Runtime, chart: Chart, name: string): Promise<string> {
  const converter = await findConverter($, rt)
  if (converter === null) return ''
  const svg = `${paths.scratch(rt)}/${name}.svg`
  const png = `${paths.scratch(rt)}/${name}.png`
  await $.fs.write(svg, chartSvg(chart))
  const tool = converter[0] ?? ''
  const argv =
    tool === 'rsvg-convert'
      ? [tool, '-o', png, svg]
      : tool === 'magick' || tool === 'convert'
        ? [tool, svg, png]
        : [tool, '--headless', '--disable-gpu', `--screenshot=${png}`, '--window-size=640,360', `file://${svg}`]
  const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) return ''
  const bytes = await $.fs.read(png, { as: 'bytes' }).catch(() => undefined)
  return typeof bytes === 'object' && bytes !== null && 'base64' in bytes ? bytes.base64 : ''
}

/** Cost per day, test runs and (when smart-router writes its stats) router savings, as PNGs or text tables. */
async function sendReport($: EngineInterface, rt: Runtime, files: SessionFile[], chatId: string): Promise<void> {
  const now = await $.clock.now()
  const today = dayKey(now)
  const recent = files.filter(file => now - file.info.lastSeen < STATS_DAYS_MS)
  const costByDay: Record<string, number> = {}
  const tests: Record<string, { pass: number; fail: number }> = {}
  for (const file of recent) {
    for (const [day, usd] of Object.entries(file.stats.costByDay)) costByDay[day] = (costByDay[day] ?? 0) + usd
    for (const [day, runs] of Object.entries(file.stats.tests)) tests[day] = { pass: (tests[day]?.pass ?? 0) + runs.pass, fail: (tests[day]?.fail ?? 0) + runs.fail }
  }
  const home = rt.dir.replace(/\/\.claude\/claude-mods\/whatsapp$/, '')
  const router = routerChart(await readJsonFile($, `${home}/.claude/claude-mods/smart-router/daily.json`))
  const charts: [string, Chart][] = [['cost', costChart(costByDay, today)], ['tests', testsChart(tests, today)], ...(router !== null ? ([['router', router]] as [string, Chart][]) : [])]
  const fallback: string[] = []
  for (const [name, chart] of charts) {
    const base64 = await renderChart($, rt, chart, name)
    if (base64 === '') fallback.push(chartText(chart))
    else await waSendFile($, rt, { chatId, path: `${name}.png`, base64, caption: chart.title, kind: 'report' })
  }
  if (fallback.length > 0) {
    const note = rt.converter === null ? '\n_(Install rsvg-convert or ImageMagick for PNG charts.)_' : ''
    await waSendText($, rt, { chatId, kind: 'report', text: `📊 ${fallback.join('\n\n')}${note}` })
  }
}

// ── Claude's tools ───────────────────────────────────────────────────────────────────────────────

const TOOL_SPECS = [
  {
    name: 'notify',
    description:
      "Send a short message to the user's phone on WhatsApp. Use it when a long job finished or failed, or something needs " +
      'their attention while they may be away; never for routine progress. priority: critical (now, even at night), normal ' +
      '(default: now when they are away), info (batched into a digest). Optional attachPath: an image or document inside the ' +
      'project to send with it. Secrets are masked and the text is capped; it may be held for the digest, and the result says so.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message, a few lines at most.' },
        priority: { type: 'string', enum: ['critical', 'normal', 'info'] },
        attachPath: { type: 'string', description: 'Optional file inside the project to attach.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask',
    description:
      "Ask the user a question on WhatsApp and wait for their answer (up to timeoutMinutes, default 10). Use it only when you " +
      'are blocked on a decision only they can make. options (2-12) are shown numbered; they answer with a number, the text, ' +
      'or 👍/❌ for yes/no. When interaction is off (night or silent mode) it returns at once: then proceed with your best ' +
      'judgement and state the assumption; the question is parked for them. On timeout, a later answer arrives as a message.',
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
    name: 'send_file',
    description:
      'Send a file inside this project (a screenshot, chart, PDF, log) to the user on WhatsApp, with a caption. Only when ' +
      `the user asked for it or it is the result they wait for; never source files or diffs unasked. Up to the size cap.`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, caption: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'open_panel',
    description: 'Open the WhatsApp side panel (connection, sessions, conversation, settings) for the user.',
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

/** A path inside the project, resolved through links; undefined when it is outside or missing. */
async function insideProject($: EngineInterface, rt: Runtime, path: string): Promise<string | undefined> {
  const absolute = path.startsWith('/') ? path : `${rt.root}/${path}`
  const stat = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (real === undefined || stat?.kind !== 'file') return undefined
  const root = rt.realRoot !== '' ? rt.realRoot : rt.root
  return real === root || real.startsWith(`${root}/`) ? real : undefined
}

async function toolNotify($: EngineInterface, rt: Runtime, input: Record<string, unknown>): Promise<string> {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text === '') return 'Nothing sent: text is empty.'
  const priority: WaPriority = input.priority === 'critical' || input.priority === 'info' ? input.priority : 'normal'
  const sent = await emit($, rt, { text: `🤖 *${tagOf(rt)}*\n${text}`, priority, kind: 'notify' })
  if (sent.action !== 'send') return sent.action === 'digest' ? `Held for the digest (${sent.reason}).` : `Not sent: ${sent.reason}.`
  if (typeof input.attachPath === 'string' && input.attachPath !== '') {
    const attached = await toolSendFile($, rt, { path: input.attachPath, caption: '' })
    return `Sent to the user's WhatsApp. ${attached}`
  }
  return "Sent to the user's WhatsApp."
}

async function toolSendFile($: EngineInterface, rt: Runtime, input: Record<string, unknown>): Promise<string> {
  if (!isConfigured(rt)) return 'Not sent: WhatsApp is not set up (/wa setup).'
  if (rt.settings.notifyMode === 'off') return 'Not sent: notifications are off.'
  const path = typeof input.path === 'string' ? input.path : ''
  const real = await insideProject($, rt, path)
  if (real === undefined) return `Not sent: ${path} is not a file inside the project.`
  const stat = await $.fs.stat(real).catch(() => undefined)
  const capBytes = rt.settings.maxFileMb * 1024 * 1024
  if (stat === undefined || stat.size > capBytes) return `Not sent: the file is over ${rt.settings.maxFileMb} MB.`
  const bytes = await $.fs.read(real, { as: 'bytes' }).catch(() => undefined)
  if (typeof bytes !== 'object' || bytes === null || !('base64' in bytes)) return 'Not sent: the file could not be read.'
  const caption = typeof input.caption === 'string' ? input.caption : ''
  const messageId = await waSendFile($, rt, { chatId: await projectChat($, rt), path: real, base64: bytes.base64, caption, kind: 'file' })
  return messageId === '' ? 'Not sent: OpenWA refused it (see /wa, Log).' : `Sent ${real.split('/').at(-1) ?? 'the file'} to the user's WhatsApp.`
}

/**
 * The ask tool. With interaction off it parks the question and returns at once. Otherwise it sends the
 * question and waits for the answer, pacing with a host `sleep` (a `$` call in flight costs the hook no
 * budget); where no `sleep` exists it waits only as long as the budget allows and returns a ticket.
 */
async function toolAsk($: EngineInterface, rt: Runtime, input: Record<string, unknown>, budgetLeft: () => number, signal: AbortSignal): Promise<string> {
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  if (question === '') return 'Not asked: the question is empty.'
  if (!isConfigured(rt)) return 'The user cannot be reached: WhatsApp is not set up. Proceed with your best judgement and state your assumption.'
  const now = await $.clock.now()
  const options = optionsFor(Array.isArray(input.options) ? input.options.map(String) : undefined)
  if (!canInteract(rt, now)) {
    await park($, rt, options.length > 0 ? `${question} (${options.join(' / ')})` : question)
    return (
      'unavailable: the user turned interaction off (night or silent mode) and will not answer now. Proceed with your best ' +
      'judgement and state the assumption you made, or continue with other work. The question was parked and will be ' +
      'delivered to them when interaction is back on.'
    )
  }
  const minutesWanted = Math.min(MAX_ASK_MINUTES, Math.max(1, Number(input.timeoutMinutes) || DEFAULT_ASK_MINUTES))
  const chatId = await projectChat($, rt)
  const messageId = await waSendText($, rt, { chatId, kind: 'ask', text: questionText(question, options, tagOf(rt)) })
  if (messageId === '') return 'The question could not be sent (OpenWA refused it). Proceed with your best judgement and state your assumption.'
  const id = `ask-${messageId}`
  await addPending($, rt, { id, kind: 'ask', question, options, chatId, messageId, expiresAt: now + 24 * 60 * 60_000 })
  rt.waiting.add(id)
  try {
    const answer = await waitForAnswer($, rt, id, now + minutesWanted * 60_000, budgetLeft, signal)
    if (answer !== undefined) {
      return `The user answered on WhatsApp: ${answer.text}${answer.choice !== undefined ? ` (option ${answer.choice + 1})` : ''}`
    }
    return (
      `No answer yet (ticket ${id}). The question stays open on their phone; if they answer later, the answer arrives as a ` +
      'message from the whatsapp-bridge plugin. Meanwhile proceed with your best judgement and state your assumption.'
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
 * A permission dialog opened while the owner is away: alert them, and with interaction on and remote
 * approvals allowed wait for their 👍 / ❌ and answer the dialog through the PermissionRequest decision.
 */
async function remotePermission(
  $: EngineInterface,
  rt: Runtime,
  e: { tool_name: string; tool_input: unknown },
  budgetLeft: () => number,
  signal: AbortSignal,
): Promise<'allow' | 'deny' | undefined> {
  if (!isConfigured(rt) || !rt.prefs.events.permissions) return undefined
  const now = await $.clock.now()
  const activity = await lastActivity($, rt)
  if (!isAway(attention(rt), activity.lastActiveAt, now)) return undefined
  const detail = describeInput(e.tool_input)
  const what = `${e.tool_name}${detail !== '' ? ` — ${detail}` : ''}`
  if (!canInteract(rt, now) || !rt.settings.remoteApprovals) {
    await emit($, rt, { text: `🔐 ${tagOf(rt)} is waiting for your approval: ${what}`, priority: 'info', event: 'permissions', isOwnerOnly: true, kind: 'permission' })
    return undefined
  }
  const chatId = await alertChat($, rt, true)
  const messageId = await waSendText($, rt, {
    chatId,
    kind: 'permission',
    text: `🔐 *${tagOf(rt)}* needs approval:\n${what}\n\n_React 👍 to allow once, ❌ to deny (or reply yes / no)._`,
  })
  if (messageId === '') return undefined
  const id = `perm-${messageId}`
  await addPending($, rt, { id, kind: 'permission', question: what, options: [], chatId, messageId, expiresAt: now + APPROVAL_WAIT_MS })
  rt.typed = false
  try {
    // Back at the keyboard (a keystroke): stop waiting, the dialog is theirs again.
    const answer = await waitForAnswer($, rt, id, now + APPROVAL_WAIT_MS, budgetLeft, signal, () => rt.typed)
    if (answer?.verdict === undefined) return undefined
    await waSendText($, rt, { chatId, quotedId: messageId, kind: 'permission', text: answer.verdict === 'approve' ? '✅ Allowed.' : '⛔ Denied.' })
    if (rt.hub !== undefined) await hubPublish($, { topic: 'approval.answered', data: { id, answer: answer.verdict === 'approve' ? 'allow' : 'deny', by: CHANNEL } })
    return answer.verdict === 'approve' ? 'allow' : 'deny'
  } finally {
    await dropPending($, rt, id)
  }
}

// ── Turns, tools and automatic updates ───────────────────────────────────────────────────────────

async function onTurnStart($: EngineInterface, rt: Runtime, turnId: string, prompt: string): Promise<void> {
  const text = withoutPhoneNote(prompt)
  rt.state = 'working'
  rt.turnId = turnId
  rt.turnStartedAt = await $.clock.now()
  rt.task = clean(oneLine(text, 200), { audience: 'owner', maxChars: 200, root: rt.root }).text
  if (!text.startsWith('Retry')) rt.lastPrompt = oneLine(text, 1_000)
  rt.turns += 1
  rt.toolErrors = 0
  rt.pushedThisTurn = false
  await saveSelf($, rt)
  await updateLiveStatus($, rt, `⚙️ *${tagOf(rt)}* working: ${oneLine(rt.task, 120)}`)
}

/** After a main-loop turn: the phone gets its answer, long or failed turns are reported, budgets checked. */
async function onTurnComplete($: EngineInterface, rt: Runtime, e: { reason: string; durationMs: number; answer: string }): Promise<void> {
  const now = await $.clock.now()
  rt.state = 'idle'
  rt.turnId = undefined
  const phone = rt.phoneTurn
  rt.phoneTurn = undefined
  if (phone !== undefined) {
    const head = e.reason === 'answer' ? '✅' : e.reason === 'aborted' ? '⏹ Stopped.' : '❌ The turn failed.'
    const body = e.answer.trim() !== '' ? `${head} *#${rt.label}*\n${e.answer}` : `${head} *#${rt.label}* finished.`
    await waSendText($, rt, { chatId: phone.chatId, quotedId: phone.messageId, kind: 'answer', text: body })
  } else if (e.reason === 'error' || e.reason === 'refusal') {
    const sent = await emit($, rt, {
      text: `❌ *${tagOf(rt)}* turn failed after ${minutes(e.durationMs)}: ${oneLine(rt.task, 120)}\n_React 🔁 to retry._`,
      priority: 'normal',
      event: 'turnFailed',
    })
    if (sent.messageId !== '') {
      await addPending($, rt, { id: `alert-${sent.messageId}`, kind: 'alert', question: rt.task, options: [], chatId: await projectChat($, rt), messageId: sent.messageId, expiresAt: now + ALERT_TTL_MS, payload: rt.lastPrompt })
    }
  } else if (e.reason === 'answer' && e.durationMs >= rt.settings.longTurnMinutes * 60_000) {
    await emit($, rt, {
      text: `✅ *${tagOf(rt)}* done in ${minutes(e.durationMs)}: ${oneLine(rt.task, 100)}\n${oneLine(e.answer, 400)}`,
      priority: 'normal',
      event: 'longTurn',
    })
  }
  await trackCost($, rt, now)
  await updateLiveStatus($, rt, `💤 *${tagOf(rt)}* idle — last: ${oneLine(rt.task, 120)}`)
  if (rt.pushedThisTurn && rt.prefs.events.ci) await watchCi($, rt)
  await saveSelf($, rt)
  $.clock.after(1_500, () => void drainPhoneQueue($, rt).catch(() => undefined))
}

async function trackCost($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const usage = await $.session.usage().catch(() => undefined)
  const usd = usage?.cost?.usd
  if (usd === undefined) return
  const before = rt.costUsd
  rt.costUsd = usd
  const day = dayKey(now)
  rt.file.stats.costByDay[day] = (rt.file.stats.costByDay[day] ?? 0) + Math.max(0, usd - before)
  for (const step of crossedBudgets(rt.settings.budgetSteps, before, usd)) {
    await emit($, rt, { text: `💰 *${tagOf(rt)}* passed $${step} this session (now $${usd.toFixed(2)}).`, priority: 'normal', event: 'budget', isOwnerOnly: true })
  }
}

/** Every finished tool call: test runs (red ↔ green), repeated errors, and `git push` for CI. */
async function onToolResult($: EngineInterface, rt: Runtime, tool: string, input: Record<string, unknown>, isFailed: boolean): Promise<void> {
  rt.toolErrors = isFailed ? rt.toolErrors + 1 : 0
  if (rt.toolErrors === TOOL_ERROR_STREAK) {
    await emit($, rt, { text: `⚠️ *${tagOf(rt)}*: ${TOOL_ERROR_STREAK} tool calls failed in a row (last: ${tool}). It may be stuck.`, priority: 'normal', event: 'toolErrors' })
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return
  if (PUSH_COMMAND.test(input.command) && !isFailed) rt.pushedThisTurn = true
  if (!TEST_COMMAND.test(input.command)) return
  await noteTests($, rt, !isFailed, oneLine(input.command, 60))
}

/** A test run's verdict (a Bash run, or one another mod published): counted for the report, red ↔ green reported. */
async function noteTests($: EngineInterface, rt: Runtime, ok: boolean, what: string): Promise<void> {
  const day = dayKey(await $.clock.now())
  const runs = rt.file.stats.tests[day] ?? { pass: 0, fail: 0 }
  rt.file.stats.tests[day] = ok ? { ...runs, pass: runs.pass + 1 } : { ...runs, fail: runs.fail + 1 }
  const was = rt.testsOk
  rt.testsOk = ok
  if (was !== undefined && was !== ok) {
    await emit($, rt, {
      text: ok ? `🟢 *${tagOf(rt)}*: tests are green again.` : `🔴 *${tagOf(rt)}*: tests went red (${what}).`,
      priority: ok ? 'info' : 'normal',
      event: 'tests',
    })
  }
}

/** One message per session edited in place while away (WhatsApp lets a message be edited for ~15 minutes). */
async function updateLiveStatus($: EngineInterface, rt: Runtime, text: string): Promise<void> {
  if (!isConfigured(rt) || !rt.prefs.events.liveStatus) return
  const now = await $.clock.now()
  const activity = await lastActivity($, rt)
  if (!isAway(attention(rt), activity.lastActiveAt, now) || rt.prefs.paused) return
  const live = rt.liveStatus
  const body = clean(`${text}\n_${clockTime(now)}_`, { audience: 'owner', maxChars: 400, root: rt.root }).text
  if (live !== undefined && now - live.at < EDIT_WINDOW_MS) {
    const edited = await waCall($, rt, api.edit(rt.sessionId, live.chatId, live.messageId, body))
    if (edited.ok) return
  }
  if (rt.state !== 'working') return
  const chatId = await projectChat($, rt)
  const messageId = await waSendText($, rt, { chatId, kind: 'live', text: body })
  if (messageId !== '') rt.liveStatus = { chatId, messageId, at: now }
}

/** After a push: watch the branch's latest GitHub Actions run with `gh` and report how it ended. */
async function watchCi($: EngineInterface, rt: Runtime): Promise<void> {
  rt.ci?.cancel()
  const startedAt = await $.clock.now()
  rt.ci = $.clock.every(CI_POLL_MS, () => void checkCi($, rt, startedAt).catch(() => undefined))
}

async function checkCi($: EngineInterface, rt: Runtime, startedAt: number): Promise<void> {
  const now = await $.clock.now()
  if (now - startedAt > CI_GIVE_UP_MS) {
    rt.ci?.cancel()
    rt.ci = undefined
    return
  }
  if (await isCiReported($, rt, startedAt)) {
    rt.ci?.cancel()
    rt.ci = undefined
    return
  }
  const ran = await $.process
    .run(['gh', 'run', 'list', '--branch', rt.branch, '--limit', '1', '--json', 'status,conclusion,name,url'], { cwd: rt.root, timeoutMs: 20_000 })
    .catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) {
    rt.ci?.cancel()
    rt.ci = undefined
    return
  }
  const run = (parseJson(ran.stdout) as unknown[] | undefined)?.[0]
  if (!isRecord(run) || run.status !== 'completed') return
  rt.ci?.cancel()
  rt.ci = undefined
  const ok = run.conclusion === 'success'
  await emit($, rt, { text: `${ok ? '✅' : '❌'} CI ${String(run.name ?? '')} on ${rt.branch}: ${String(run.conclusion ?? '')}\n${String(run.url ?? '')}`, priority: ok ? 'info' : 'normal', event: 'ci' })
}

/** A new screenshot in .claude/screenshots/ (screenshot-check): sent for a 👍 / ❌ review. */
async function scanScreenshots($: EngineInterface, rt: Runtime): Promise<void> {
  if (!isConfigured(rt) || !rt.prefs.events.uiPreviews || rt.root === '') return
  const now = await $.clock.now()
  const entries = await $.fs.list(paths.shots(rt)).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'file' || !/\.(png|jpe?g|webp)$/i.test(entry.name) || rt.shotsSeen.has(entry.name)) continue
    rt.shotsSeen.add(entry.name)
    if (entry.mtimeMs < rt.startedAt) continue
    if (!canInteract(rt, now)) continue
    const activity = await lastActivity($, rt)
    if (!isAway(attention(rt), activity.lastActiveAt, now) && rt.settings.notifyMode !== 'always') continue
    const path = `${paths.shots(rt)}/${entry.name}`
    if (entry.size > rt.settings.maxFileMb * 1024 * 1024) continue
    const bytes = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
    if (typeof bytes !== 'object' || bytes === null || !('base64' in bytes)) continue
    const chatId = await projectChat($, rt)
    const messageId = await waSendFile($, rt, { chatId, path, base64: bytes.base64, caption: `🖼 UI preview ${entry.name} (#${rt.label}) — 👍 looks good · ❌ or reply with what to fix`, kind: 'preview' })
    if (messageId !== '') await addPending($, rt, { id: `preview-${messageId}`, kind: 'preview', question: entry.name, options: [], chatId, messageId, expiresAt: now + BUG_TTL_MS, payload: entry.name })
  }
}

/** The session-end summary: from the transcript, no model call (the end gives hooks ~1.5 s). */
async function onSessionEnd($: EngineInterface, rt: Runtime): Promise<void> {
  rt.file.info.ended = true
  if (rt.isLeader) await writeJsonFile($, paths.lease(rt), { sessionId: '', heartbeatAt: 0, since: 0 })
  if (rt.turns > 0 && isConfigured(rt) && rt.prefs.events.sessionEnd) {
    const messages = await $.session.messages().catch(() => [])
    const list = Array.isArray(messages) ? messages : []
    const edits = new Set(list.flatMap(message => message.toolUses).filter(use => use.tool === 'Edit' || use.tool === 'Write').map(use => String(use.input.file_path ?? '')))
    const last = [...list].reverse().find(message => message.role === 'assistant' && message.text.trim() !== '')
    await toDigest($, rt, `🏁 session ended: ${rt.turns} prompts, ${plural(edits.size, 'file')} edited, $${rt.costUsd.toFixed(2)}${last !== undefined ? ` — ${oneLine(last.text, 160)}` : ''}`)
  }
  await saveSelf($, rt)
  for (const timer of rt.timers) timer.cancel()
}

// ── mods-hub: one presence, one quiet, one notification router for every channel ──────────────────

/** The hub's global mode, re-read (another session or the phone may have changed it); unchanged without the hub. */
async function refreshHub($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.hub !== undefined) rt.hub = (await hubMode($)) ?? rt.hub
}

type AttentionChange = { presence: 'away' | 'here' | 'auto' } | { interaction: 'on' | 'off' | 'auto' } | { night: true }

/**
 * With mods-hub installed, presence, interaction and night are the hub's (every session, every channel): a change
 * from /wa, the panel or the phone goes there. Undefined without the hub, and the bridge changes its own prefs.
 */
async function changeOnHub($: EngineInterface, rt: Runtime, change: AttentionChange, reason: 'manual' | 'channel'): Promise<HubMode | undefined> {
  if (rt.hub === undefined) return undefined
  try {
    if ('presence' in change) rt.hub = await $.mods.setPresence({ presence: change.presence, reason })
    else if ('interaction' in change) rt.hub = await $.mods.setMode({ interaction: change.interaction })
    else rt.hub = await $.mods.setMode({ isNightOn: true })
    return rt.hub
  } catch {
    return undefined
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, the Channels tab, the `whatsapp` channel, and a pull of its notifications every few seconds. */
async function greetHub($: EngineInterface, rt: Runtime): Promise<void> {
  rt.hub = await hubMode($)
  if (rt.hub === undefined) return
  rt.hubSeenAt = await $.clock.now()
  await hubHello(
    $,
    {
      version: await ownVersion($),
      publishes: ['channel.inbound', 'approval.answered'],
      consumes: ['session.idle', 'session.away', 'session.back', 'test.result', 'ci.result', 'budget.threshold'],
    },
    TAB,
  )
  await syncChannel($, rt)
  rt.timers.push($.clock.every(INBOX_MS, () => void drainHub($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
}

/** Registers the `whatsapp` channel, then reports the link's phase to the hub's channel list when it changes. */
async function syncChannel($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.hub === undefined) return
  const connection = await read($, connectionAtom)
  const phase = isConfigured(rt) ? connection.phase : 'unconfigured'
  if (phase === rt.channelPhase) return
  const detail = oneLine(connection.detail, 80)
  try {
    if (rt.channelPhase === '') {
      // Pull: a mod that keeps working without the hub cannot answer the hub's push (`mods.deliver`), so it drains.
      await $.mods.registerChannel({ id: CHANNEL, title: 'WhatsApp', audience: 'me', delivery: 'pull', status: channelStatusOf(phase), ...(detail === '' ? {} : { detail }) })
    } else {
      await $.mods.channelStatus({ id: CHANNEL, status: channelStatusOf(phase), ...(detail === '' ? {} : { detail }) })
    }
    rt.channelPhase = phase
  } catch {
    // Retried on the next heartbeat.
  }
}

/** A notification another mod sent through the hub, as one WhatsApp line (the hub already masked its secrets). */
const hubNoticeText = (notice: ModsNotice): string =>
  [`${HUB_GLYPH[notice.level] ?? '•'} *${notice.source}*: ${notice.title}`, notice.body ?? '', notice.url ?? ''].filter(line => line !== '').join('\n')

/** The hub's notifications waiting for this channel: each goes out by its level (the hub judged presence and night). */
async function drainHub($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.hub === undefined || !isConfigured(rt)) return
  const notices = await $.mods.drain({ channel: CHANNEL })
  for (const notice of notices) {
    await emit($, rt, { text: hubNoticeText(notice), priority: HUB_PRIORITY[notice.level] ?? 'normal', kind: 'hub', isRouted: true })
  }
}

/** What other mods published since the last look: their test runs (test-watch's own) count as red/green like Bash ones. */
async function readBus($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.hub === undefined) return
  let events: ModsEvent[]
  try {
    events = await $.mods.recent({ topic: 'test.result', since: rt.hubSeenAt })
  } catch {
    return
  }
  for (const event of events) {
    rt.hubSeenAt = Math.max(rt.hubSeenAt, event.at)
    // The hub's own sensor mirrors the Bash runs this bridge already watches.
    if (event.source === 'mods-hub' || event.source === NAME) continue
    const data = (event.data ?? {}) as { outcome?: unknown; runner?: unknown }
    if (data.outcome === 'passed' || data.outcome === 'failed') await noteTests($, rt, data.outcome === 'passed', `${String(data.runner ?? 'tests')}, ${event.source}`)
  }
}

/** Whether a mod on the hub's bus (ci-watch) already reported CI for this branch since `since`: its notice reaches WhatsApp through the hub. */
async function isCiReported($: EngineInterface, rt: Runtime, since: number): Promise<boolean> {
  if (rt.hub === undefined) return false
  try {
    return (await $.mods.recent({ topic: 'ci.result', since })).some(event => (event.data as { branch?: unknown } | null)?.branch === rt.branch)
  } catch {
    return false
  }
}

/** What arrives from the phone, on the hub's bus (`channel.inbound`), for mods that act on it (autopilot). */
async function publishInbound($: EngineInterface, rt: Runtime, entry: InboxEntry, who: 'owner' | 'member'): Promise<void> {
  if (rt.hub === undefined || entry.kind === 'reaction') return
  await hubPublish($, { topic: 'channel.inbound', data: { channel: CHANNEL, from: who, text: oneLine(entry.text, 1_000), isOwner: who === 'owner' } })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────────────────────

async function startUp($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  rt.dir = `${home.replace(/\/+$/, '')}/.claude/claude-mods/whatsapp`
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
  rt.isStarted = true
  await refreshPane($, rt)
  if (isConfigured(rt)) void checkConnection($, rt).catch(() => undefined)
  if (!isInteractive) return
  await greetHub($, rt)
  rt.timers.push($.clock.every(HEARTBEAT_MS, () => void heartbeat($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
  rt.timers.push($.clock.every(INBOX_MS, () => void consumeInbox($, rt).catch(() => undefined)))
  rt.timers.push($.clock.every(SCREENSHOT_MS, () => void scanScreenshots($, rt).catch(() => undefined)))
  const shots = await $.fs.list(paths.shots(rt)).catch(() => [])
  for (const shot of shots) rt.shotsSeen.add(shot.name)
  void tickLease($, rt).catch(() => undefined)
}

/** Every ten seconds: shared settings, this session's file, the lease, the pane. */
async function heartbeat($: EngineInterface, rt: Runtime): Promise<void> {
  await loadShared($, rt)
  if (rt.typed) {
    rt.typed = false
    rt.lastActiveAt = await $.clock.now()
  }
  const leader = await readJsonFile($, paths.leader(rt))
  if (isRecord(leader)) {
    const digestSeq = isRecord(leader.digestSeq) ? Number(leader.digestSeq[rt.me] ?? 0) : 0
    const parkedSeq = isRecord(leader.parkedSeq) ? Number(leader.parkedSeq[rt.me] ?? 0) : 0
    rt.file.digest = rt.file.digest.filter(item => item.seq > digestSeq)
    rt.file.parked = rt.file.parked.filter(item => item.seq > parkedSeq)
  }
  await saveSelf($, rt)
  await tickLease($, rt)
  await refreshHub($, rt)
  await syncChannel($, rt)
  await readBus($, rt)
  if (rt.isPaneOpen || (rt.hub !== undefined && (await hubTabIs($, TAB.id)))) await refreshPane($, rt)
  if (rt.state === 'idle') await drainPhoneQueue($, rt)
}

/** Fills the pane's atoms from the shared files. */
async function refreshPane($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  const files = await readSessionFiles($, rt, LIVE_MS * 2)
  await update($, sessionsAtom, () => files.map(file => file.info).filter(info => isLive(info, now)).sort((a, b) => b.lastActiveAt - a.lastActiveAt))
  const logs: WaLogEntry[] = []
  for (const file of files) logs.push(...((await readLines($, paths.log(rt, file.info.id))).filter(isRecord) as unknown as WaLogEntry[]))
  logs.sort((a, b) => a.at - b.at)
  await update($, conversationAtom, () => logs.filter(entry => entry.dir === 'in' || entry.dir === 'out').slice(-30))
  const own = (await readLines($, paths.log(rt, rt.me))).filter(isRecord).slice(-40) as unknown as WaLogEntry[]
  await update($, auditAtom, () => own)
  const members = (await readLines($, paths.members(rt))).filter(isRecord) as unknown as WaMemberQa[]
  await update($, membersAtom, () => members.slice(-20))
  await update($, privacyAtom, privacy => ({ ...privacy, allowlist: allowlist(rt) }))
  await refreshGroupCard($, rt, '')
}

// ── /wa ──────────────────────────────────────────────────────────────────────────────────────────

const WA_USAGE = [
  '/wa — open the WhatsApp panel',
  '/wa setup — check OpenWA and walk through what is missing',
  '/wa owner <+number> · /wa session <name|id> · /wa key <key> · /wa pair <+number>',
  '/wa link-project [n] · /wa unlink-project — this project’s WhatsApp group',
  '/wa away | here | auto · /wa pause | resume',
  '/wa interact on | off | auto · /wa night · /wa silent',
  '/wa label <name> · /wa test · /wa digest · /wa report · /wa status',
].join('\n')

/** The Channels tab of the hub's panel when the hub is installed, the bridge's own pane otherwise. */
async function openPane($: EngineInterface, rt: Runtime): Promise<void> {
  await refreshPane($, rt)
  if (rt.hub !== undefined && (await hubShowTab($, TAB.id))) return
  rt.isPaneOpen = true
  await $.ui.open({ id: PANE, title: 'WhatsApp', columns: PANE_COLUMNS })
}

/** `/wa setup`: health, key, session, link, owner — and the exact next step for whatever is missing. */
async function setup($: EngineInterface, rt: Runtime): Promise<string> {
  await loadShared($, rt)
  const connection = await checkConnection($, rt)
  const lines: string[] = []
  switch (connection.phase) {
    case 'unreachable':
      return dockerSteps(rt.settings.baseUrl)
    case 'no-key':
    case 'admin-key':
      return `${connection.detail}\n\n${keySteps(rt.sessionId)}`
    case 'no-session':
      return `${connection.detail}\n\n${keySteps('')}`
    case 'qr':
      lines.push('WhatsApp is waiting to be linked: open /wa (the QR shows on terminals with image support, or open the OpenWA dashboard at http://127.0.0.1:2785/), or link with a code: /wa pair <your bot number>.')
      break
    case 'starting':
      lines.push('The WhatsApp session is starting; run /wa setup again in a few seconds.')
      break
    case 'disconnected':
    case 'error': {
      const started = await waCall($, rt, api.start(rt.sessionId))
      lines.push(started.ok ? 'Started the WhatsApp session; run /wa setup again to see its QR or status.' : `The session could not start: ${failure(started)}`)
      break
    }
    case 'ready':
      lines.push(`✓ ${connection.detail} (${connection.mode === 'self' ? 'your own number: only allowlisted chats are touched' : 'a dedicated bot number'}).`)
      break
    default:
      lines.push(connection.detail)
  }
  if (rt.owners.length === 0) lines.push('Next: tell the mod your own number, the only one allowed to command it: /wa owner +<country><number>.')
  else if (connection.phase === 'ready') {
    lines.push(`Owner: ${rt.owners.map(n => `+${n}`).join(', ')}.`)
    const group = projectGroup(rt)
    lines.push(group !== undefined ? `This project's group: ${group.name}.` : 'No group for this project yet: /wa link-project (or it is created on the first update).')
    lines.push('Try it: /wa test')
  }
  return lines.join('\n')
}

async function runWa($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  const now = await $.clock.now()
  switch (verb.toLowerCase()) {
    case '':
    case 'open':
    case 'panel': {
      await openPane($, rt)
      const connection = await read($, connectionAtom)
      return `WhatsApp: ${connection.phase}${connection.detail !== '' ? ` — ${connection.detail}` : ''}${isConfigured(rt) ? '' : '\nNot set up yet: /wa setup'}`
    }
    case 'setup':
      return setup($, rt)
    case 'help':
      return WA_USAGE
    case 'status':
      return `${(await read($, connectionAtom)).detail}\nInteraction: ${interactionText(rt, now)} · presence ${rt.hub?.presence ?? rt.prefs.presence} · ${rt.prefs.paused ? 'paused' : 'notifying'} · ${rt.isLeader ? 'this session polls' : 'another session polls'}`
    case 'owner': {
      const number = digitsOnly(arg)
      if (number.length < 6) return 'Usage: /wa owner +39333…  (your own WhatsApp number, with country code)'
      await saveConfig($, rt, { ownerNumbers: [...new Set([...(rt.config.ownerNumbers ?? []), number])] })
      return `Owner set: +${number}. Only this number can command Claude from WhatsApp.`
    }
    case 'session': {
      const listed = await waCall($, rt, api.sessions())
      const found = parseSessions(listed.json).find(one => one.id === arg || one.name === arg)
      if (found === undefined) return `No OpenWA session named "${arg}". ${failure(listed)}`
      await saveConfig($, rt, { sessionId: found.id })
      return `Using the WhatsApp session ${found.name} (${found.status}).`
    }
    case 'key':
      return saveKey($, rt, arg)
    case 'pair': {
      const phone = digitsOnly(arg)
      if (phone.length < 6) return 'Usage: /wa pair +<the number to link>'
      const paired = await waCall($, rt, api.pairingCode(rt.sessionId, phone))
      const code = isRecord(paired.json) && typeof paired.json.pairingCode === 'string' ? paired.json.pairingCode : ''
      if (code === '') return `No pairing code: ${failure(paired)}`
      await update($, connectionAtom, connection => ({ ...connection, pairingCode: code }))
      return `Pairing code: ${code}\nOn that phone: WhatsApp › Linked devices › Link with phone number, then type the code.`
    }
    case 'link-project':
      return linkProject($, rt, arg)
    case 'unlink-project':
      if (projectGroup(rt) === undefined) return 'This project has no linked group.'
      await saveGroups($, rt, groups => Object.fromEntries(Object.entries(groups).filter(([root]) => root !== rt.root)))
      return 'Unlinked. Updates for this project go to your direct chat (the group itself is left as it is).'
    case 'away':
    case 'here':
    case 'auto': {
      const presence = verb === 'away' ? 'away' : verb === 'here' ? 'here' : 'auto'
      if ((await changeOnHub($, rt, { presence }, 'manual')) !== undefined) {
        return presence === 'away'
          ? 'Marked away in every session (mods-hub): updates go to WhatsApp.'
          : presence === 'here'
            ? 'Marked here (mods-hub): only critical updates go out.'
            : 'Presence follows your activity again (mods-hub).'
      }
      await savePrefs($, rt, prefs => ({ ...prefs, presence }))
      return verb === 'away' ? 'Marked away: updates go to WhatsApp.' : verb === 'here' ? 'Marked here: only critical updates go out.' : `Presence follows your typing (away after ${rt.prefs.awayMinutes} min).`
    }
    case 'pause':
    case 'resume':
      await savePrefs($, rt, prefs => ({ ...prefs, paused: verb === 'pause' }))
      return verb === 'pause' ? 'Notifications paused (critical still goes out).' : 'Notifications resumed.'
    case 'interact': {
      const mode = arg === 'on' ? 'on' : arg === 'off' ? 'off' : arg === 'auto' ? 'auto' : undefined
      if (mode === undefined) return 'Usage: /wa interact on | off | auto'
      const onHub = await changeOnHub($, rt, { interaction: mode }, 'manual')
      if (onHub !== undefined) return `Interaction: ${hubModeLabel(onHub)}.`
      await savePrefs($, rt, prefs => ({ ...prefs, interaction: mode }))
      return `Interaction: ${interactionLabel(rt.prefs, rt.settings.interactionOffHours, now)}.`
    }
    case 'silent':
      if ((await changeOnHub($, rt, { interaction: 'off' }, 'manual')) !== undefined) {
        return 'Interaction off in mods-hub: Claude will not ask you anything on any channel until /wa interact on (or /hub interaction).'
      }
      await savePrefs($, rt, prefs => ({ ...prefs, interaction: 'off' }))
      return 'Silent mode: Claude will not ask you anything on WhatsApp; questions are parked until /wa interact on.'
    case 'night': {
      const onHub = await changeOnHub($, rt, { night: true }, 'manual')
      if (onHub !== undefined) return `Night mode on in mods-hub (quiet hours ${onHub.quietHours}): no questions then, only critical messages; the rest waits for the morning digest.`
      const until = windowEnd(rt.settings.interactionOffHours, now)
      await savePrefs($, rt, prefs => ({ ...prefs, interaction: 'night', nightUntil: until }))
      return `Night mode until ${clockTime(until)}: no questions, only the updates you enabled.`
    }
    case 'label': {
      const label = arg.toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 24)
      if (label === '') return `This session is #${rt.label}. Usage: /wa label <name>`
      rt.label = label
      await saveSelf($, rt)
      return `This session is now #${label} on WhatsApp.`
    }
    case 'test': {
      if (!isConfigured(rt)) return 'Not set up yet: /wa setup'
      const messageId = await waSendText($, rt, { chatId: await projectChat($, rt), kind: 'test', text: `👋 Test from Claude Code (*${tagOf(rt)}*). Send *help* to see what you can do from here.` })
      return messageId !== '' ? 'Sent a test message.' : 'The test message was not sent: see /wa (Log).'
    }
    case 'digest':
    case 'report': {
      if (!isConfigured(rt)) return 'Not set up yet: /wa setup'
      const files = await readSessionFiles($, rt, SESSION_FILE_FRESH_MS)
      if (verb === 'report') await sendReport($, rt, files, ownerChat(rt))
      else await sendDigest($, rt, files, 'now', ownerChat(rt))
      return verb === 'report' ? 'Sent the report.' : 'Sent the digest.'
    }
    default:
      return WA_USAGE
  }
}

/** Stores a scoped operator key after checking it with OpenWA; an admin key is refused, never stored. */
async function saveKey($: EngineInterface, rt: Runtime, key: string): Promise<string> {
  if (!/^\S{16,}$/.test(key)) return 'Usage: /wa key <owa_k1_…> (a scoped operator key; the pane’s field keeps it out of the transcript)'
  const previous = rt.apiKey
  rt.apiKey = key
  const valid = await waCall($, rt, api.validate())
  const role = isRecord(valid.json) ? String(valid.json.role ?? '') : ''
  if (!valid.ok || role === 'admin' || role === '') {
    rt.apiKey = previous
    return role === 'admin'
      ? 'Refused: that is an ADMIN key. Mint a scoped operator key instead (/wa setup shows how); the admin key was not stored.'
      : `OpenWA refused the key (${failure(valid)}).`
  }
  await saveConfig($, rt, { apiKey: key })
  await checkConnection($, rt)
  return `Key saved (${role}${isRecord(valid.json) && valid.json.scoped === true ? ', chat-scoped' : ''}). ${rt.sessionId === '' ? 'Next: /wa setup' : 'Next: /wa test'}`
}

// ── The side pane ────────────────────────────────────────────────────────────────────────────────

const TABS: readonly [WaTab, string, string][] = [
  ['status', 'Status', 's'],
  ['chat', 'Chat', 'c'],
  ['settings', 'Settings', 'g'],
  ['privacy', 'Privacy', 'p'],
  ['log', 'Log', 'l'],
]
const PHASE_LOOK: Record<WaConnection['phase'], { glyph: string; color: string; label: string }> = {
  ready: { glyph: '●', color: 'success', label: 'Connected' },
  qr: { glyph: '◐', color: 'warning', label: 'Waiting for QR scan' },
  starting: { glyph: '◌', color: 'warning', label: 'Starting' },
  disconnected: { glyph: '○', color: 'error', label: 'Disconnected' },
  unreachable: { glyph: '○', color: 'error', label: 'OpenWA unreachable' },
  'no-key': { glyph: '○', color: 'warning', label: 'No API key' },
  'admin-key': { glyph: '⚠', color: 'error', label: 'Admin key refused' },
  'no-session': { glyph: '○', color: 'warning', label: 'No WhatsApp session' },
  unconfigured: { glyph: '○', color: 'inactive', label: 'Not set up' },
  error: { glyph: '⚠', color: 'error', label: 'Error' },
}
/** A whole PNG (signature, then the IHDR chunk): anything else would make the surface refuse the pane. */
const isPng = (base64: string): boolean => base64.startsWith('iVBORw0KGgoAAAANSUhEUg') && base64.length > 60

const DIR_GLYPH: Record<WaLogEntry['dir'], string> = { in: '↘', out: '↗', held: '⏸', drop: '✕', note: '·' }

async function setTab($: EngineInterface, tab: WaTab): Promise<void> {
  await update($, tabAtom, () => tab)
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

async function reconnect($: EngineInterface, rt: Runtime): Promise<string> {
  if (rt.sessionId === '') return setup($, rt)
  const started = await waCall($, rt, api.start(rt.sessionId))
  await checkConnection($, rt)
  return started.ok ? 'Starting the WhatsApp session…' : `Could not start: ${failure(started)}`
}

async function previewRedaction($: EngineInterface, rt: Runtime, sample: string): Promise<void> {
  const owner = clean(sample, { audience: 'owner', maxChars: rt.settings.maxMessageChars, root: rt.root }).text
  const member = clean(sample, { audience: 'member', maxChars: rt.settings.maxMessageChars, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text
  await update($, privacyAtom, privacy => ({ ...privacy, sample, redacted: `To you: ${owner}\nTo members: ${member}` }))
}

async function drawPane($: EngineInterface, rt: Runtime, e: RenderInput<'Pane'>, isTab = false): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Link } = elements
  // Fields exist on every surface but mobile; pictures on the terminal alone (Elements in the types).
  const hasFields = e.surface !== 'mobile'
  const Input = hasFields && 'Input' in elements ? elements.Input : undefined
  const Select = hasFields && 'Select' in elements ? elements.Select : undefined
  const Image = e.surface === 'terminal' && 'Image' in elements ? elements.Image : undefined
  const width = Math.max(24, e.props.bodyColumns)
  const tab = await read($, tabAtom)
  const now = await $.clock.now()
  const row = (text: string, max = width): string => oneLine(text, max)
  // With mods-hub installed, presence, interaction and night are its global mode (read reactively).
  const hub = (await $.state.get({ plugin: 'mods-hub', key: 'mode' })).value

  const tabBar = (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" gap={1}>
      {TABS.map(([id, label, hotkey]) => (
        <Button key={`tab:${id}`} label={label} hotkey={hotkey} plain variant={id === tab ? 'primary' : 'secondary'} dimColor={id !== tab} onPress={() => void setTab($, id)} />
      ))}
    </Box>
  )

  let body: RenderElement
  if (tab === 'status') {
    const connection = await read($, connectionAtom)
    const look = PHASE_LOOK[connection.phase]
    const group = await read($, groupAtom)
    const sessions = await read($, sessionsAtom)
    const prefs = await read($, prefsAtom)
    const isInteractive = hub === undefined ? interactionAllowed(prefs, rt.settings.interactionOffHours, now) : hub.canAsk
    const isMarkedAway = hub === undefined ? prefs.presence === 'away' : hub.presence === 'away'
    body = (
      <Box flexDirection="column" gap={1}>
        <Box key="connection" flexDirection="column">
          <Text bold>
            <Text color={look.color}>{look.glyph}</Text> {look.label}
            {connection.phone !== '' ? ` · +${connection.phone}` : ''}
          </Text>
          {connection.detail !== '' && <Text dimColor wrap="wrap">{connection.detail}</Text>}
          <Text dimColor>
            {connection.mode === 'self' ? 'Own number: allowlisted chats only' : connection.mode === 'bot' ? 'Dedicated bot number' : 'Mode unknown'}
            {connection.isLeader ? ' · this session polls' : ''}
          </Text>
          {connection.phase === 'qr' && isPng(connection.qr) && Image !== undefined && (
            <Image key="qr" source={{ png: connection.qr }} columns={Math.min(32, width)} rows={16} alt="QR code: open the OpenWA dashboard or use a pairing code" />
          )}
          {connection.phase === 'qr' && (Image === undefined || !isPng(connection.qr)) && (
            <Box key="qr-fallback" flexDirection="column">
              <Text wrap="wrap">Scan the QR in the OpenWA dashboard:</Text>
              <Link href="http://127.0.0.1:2785/" label="Open OpenWA dashboard" />
            </Box>
          )}
          {connection.pairingCode !== '' && <Text bold>Pairing code: {connection.pairingCode}</Text>}
          {connection.phase === 'qr' && Input !== undefined && (
            <Input key="pair" label="Pair " placeholder="+number to link" submitLabel="code" onSubmit={value => void paneAction($, rt, () => runWa($, rt, `pair ${value}`))} />
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="reconnect" label="Reconnect" hotkey="r" onPress={() => void paneAction($, rt, () => reconnect($, rt))} />
            <Button key="refresh" label="Refresh" onPress={() => void paneAction($, rt, async () => (await checkConnection($, rt), ''))} />
            {!isConfigured(rt) && <Button key="setup" label="Setup" variant="primary" onPress={() => void paneAction($, rt, () => setup($, rt))} />}
          </Box>
        </Box>
        <Box key="group" flexDirection="column">
          <Text bold>Project group</Text>
          {group.link !== null ? (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                {group.link.name} · {plural(group.link.members, 'member')}
              </Text>
              {group.link.inviteLink !== '' && <Link href={group.link.inviteLink} label="Open in WhatsApp" />}
              <Button key="unlink" label="Unlink" plain onPress={() => void paneAction($, rt, () => runWa($, rt, 'unlink-project'))} />
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text dimColor wrap="wrap">{group.note !== '' ? group.note : 'No group yet: updates go to your direct chat.'}</Text>
              <Button key="link" label={rt.settings.autoCreateGroup ? 'Create group' : 'Link group'} onPress={() => void paneAction($, rt, () => linkProject($, rt, ''))} />
              {group.choices.map((choice, index) => (
                <Button key={`choice:${choice.id}`} label={`${index + 1}. ${row(choice.name, width - 6)}`} plain onPress={() => void paneAction($, rt, () => linkProject($, rt, choice.id))} />
              ))}
            </Box>
          )}
        </Box>
        <Box key="sessions" flexDirection="column">
          <Text bold>Sessions ({sessions.length})</Text>
          {sessions.map(session => (
            <Box key={`session:${session.id}`} flexDirection="row" gap={1}>
              <Text color={session.state === 'working' ? 'warning' : 'success'}>{session.state === 'working' ? '⚙' : '●'}</Text>
              <Text wrap="truncate-end">{row(`#${session.label} ${session.project}${session.id === rt.me ? ' (this)' : ''}${session.state === 'working' ? ` · ${session.task}` : ''}`, width - 3)}</Text>
            </Box>
          ))}
          {Input !== undefined && <Input key="label" label="Label " placeholder={`#${rt.label}`} submitLabel="rename" onSubmit={value => void paneAction($, rt, () => runWa($, rt, `label ${value}`))} />}
        </Box>
        <Box key="actions" flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="test" label="Send test" hotkey="t" onPress={() => void paneAction($, rt, () => runWa($, rt, 'test'))} />
          <Button key="digest" label="Digest now" onPress={() => void paneAction($, rt, () => runWa($, rt, 'digest'))} />
          <Button key="presence" label={isMarkedAway ? 'I am here' : 'I am away'} hotkey="a" onPress={() => void paneAction($, rt, () => runWa($, rt, isMarkedAway ? 'here' : 'away'))} />
          <Button key="pause" label={prefs.paused ? 'Resume all' : 'Pause all'} onPress={() => void paneAction($, rt, () => runWa($, rt, prefs.paused ? 'resume' : 'pause'))} />
          <Button key="interaction" label={isInteractive ? 'Interaction: ON' : 'Interaction: OFF'} variant={isInteractive ? 'primary' : 'secondary'} hotkey="i" onPress={() => void paneAction($, rt, () => runWa($, rt, `interact ${isInteractive ? 'off' : 'on'}`))} />
          <Button key="night" label="Night mode" hotkey="n" onPress={() => void paneAction($, rt, () => runWa($, rt, 'night'))} />
        </Box>
      </Box>
    )
  } else if (tab === 'chat') {
    const conversation = await read($, conversationAtom)
    const members = await read($, membersAtom)
    body = (
      <Box flexDirection="column" gap={1}>
        <Box key="conversation" flexDirection="column">
          <Text bold>Conversation</Text>
          {conversation.length === 0 && <Text dimColor>Nothing yet.</Text>}
          {conversation.map((entry, index) => (
            <Box key={`msg:${index}:${entry.at}`} flexDirection="row" gap={1}>
              <Text color={entry.dir === 'in' ? 'suggestion' : 'success'}>{DIR_GLYPH[entry.dir]}</Text>
              <Text dimColor>{clockTime(entry.at)}</Text>
              <Text wrap="truncate-end">{row(`${entry.session} ${entry.text}`, width - 10)}</Text>
            </Box>
          ))}
        </Box>
        {Input !== undefined && (
          <Input
            key="reply"
            label="Reply "
            placeholder="message to this project’s chat"
            submitLabel="send"
            onSubmit={value => void paneAction($, rt, async () => ((await waSendText($, rt, { chatId: await projectChat($, rt), kind: 'manual', text: value })) !== '' ? 'Sent.' : 'Not sent.'))}
          />
        )}
        <Box key="members" flexDirection="column">
          <Text bold>Member questions</Text>
          {members.length === 0 && <Text dimColor>None yet.</Text>}
          {members.slice(-8).map((qa, index) => (
            <Text key={`qa:${index}`} wrap="truncate-end">
              {row(`${clockTime(qa.at)} ${qa.member} [${qa.outcome}] ${qa.question}`, width)}
            </Text>
          ))}
        </Box>
      </Box>
    )
  } else if (tab === 'settings') {
    const prefs = await read($, prefsAtom)
    body = (
      <Box flexDirection="column" gap={1}>
        <Box key="interaction" flexDirection="column">
          <Text bold>Interaction: {hub === undefined ? interactionLabel(prefs, rt.settings.interactionOffHours, now) : hubModeLabel(hub)}</Text>
          {hub !== undefined && <Text dimColor wrap="wrap">Presence, interaction and night follow mods-hub, for every session and channel (/hub).</Text>}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {(['on', 'off', 'auto'] as const).map(mode => (
              <Button
                key={`interact:${mode}`}
                label={mode === 'off' ? 'Silent' : mode === 'on' ? 'On' : hub === undefined ? `Auto (off ${rt.settings.interactionOffHours})` : 'Auto (while away)'}
                variant={(hub?.interaction ?? prefs.interaction) === mode ? 'primary' : 'secondary'}
                onPress={() => void paneAction($, rt, () => runWa($, rt, `interact ${mode}`))}
              />
            ))}
            <Button key="interact:night" label="Night" variant={(hub === undefined ? prefs.interaction === 'night' : hub.isNight) ? 'primary' : 'secondary'} onPress={() => void paneAction($, rt, () => runWa($, rt, 'night'))} />
          </Box>
        </Box>
        <Box key="timing" flexDirection="column">
          {hub !== undefined ? (
            <Text dimColor wrap="wrap">Quiet hours {hub.quietHours} and the away time are mods-hub's (/hub night, the hub's settings).</Text>
          ) : Select !== undefined ? (
            <Box flexDirection="column">
              <Select key="quiet" label="Quiet hours " value={prefs.quietHours} options={['22-7', '23-8', '0-7', 'off'].map(value => ({ value, label: value }))} onSelect={value => void savePrefs($, rt, current => ({ ...current, quietHours: value }))} />
              <Select key="awayMinutes" label="Away after " value={String(prefs.awayMinutes)} options={[5, 10, 15, 30, 60].map(n => ({ value: String(n), label: `${n} min` }))} onSelect={value => void savePrefs($, rt, current => ({ ...current, awayMinutes: Number(value) }))} />
            </Box>
          ) : (
            <Text dimColor>Quiet hours {prefs.quietHours} · away after {prefs.awayMinutes} min</Text>
          )}
          <Text dimColor wrap="wrap">Priorities: critical now · normal when away · info in the digest (every {rt.settings.digestMinutes} min) · max {rt.settings.maxPerHour}/hour</Text>
        </Box>
        <Box key="events" flexDirection="column">
          <Text bold>Updates</Text>
          {EVENT_KEYS.map(key => (
            <Button key={`event:${key}`} plain label={`${prefs.events[key] ? '☑' : '☐'} ${EVENT_LABELS[key]}`} onPress={() => void savePrefs($, rt, current => ({ ...current, events: { ...current.events, [key]: !current.events[key] } }))} />
          ))}
        </Box>
      </Box>
    )
  } else if (tab === 'privacy') {
    const privacy = await read($, privacyAtom)
    const nextHeld = rt.file.digest.at(-1)?.text ?? ''
    body = (
      <Box flexDirection="column" gap={1}>
        <Box key="allowlist" flexDirection="column">
          <Text bold>Allowlist — the only chats read or written</Text>
          {privacy.allowlist.length === 0 && <Text dimColor>Empty: set your number with /wa owner.</Text>}
          {privacy.allowlist.map(chat => (
            <Text key={`allow:${chat}`} wrap="truncate-end">
              {row(`${isGroupChat(chat) ? '👥' : '👤'} ${Object.values(rt.groups).find(link => link.groupId === chat)?.name ?? chat}`, width)}
            </Text>
          ))}
          <Text dimColor wrap="wrap">Every other chat is dropped before storage. No typing, read receipts or presence are ever sent.</Text>
        </Box>
        <Box key="redaction" flexDirection="column">
          <Text bold>Redaction preview</Text>
          {nextHeld !== '' && <Text wrap="wrap">Next held: {clean(nextHeld, { audience: 'owner', maxChars: 200, root: rt.root }).text}</Text>}
          {Input !== undefined && <Input key="sample" label="Try " placeholder="paste text to see what would be sent" submitLabel="preview" onSubmit={value => void previewRedaction($, rt, value)} />}
          {privacy.redacted !== '' && <Text wrap="wrap">{privacy.redacted}</Text>}
        </Box>
        <Box key="key" flexDirection="column">
          <Text bold>API key</Text>
          <Text dimColor>{rt.apiKey === '' ? 'none' : `${rt.apiKey.slice(0, 10)}… (${rt.scoped ? 'chat-scoped' : 'operator'})`}</Text>
          {Input !== undefined && <Input key="apikey" label="Key " placeholder="owa_k1_… (scoped operator key)" submitLabel="save" onSubmit={value => void paneAction($, rt, () => saveKey($, rt, value.trim()))} />}
        </Box>
      </Box>
    )
  } else {
    const audit = await read($, auditAtom)
    body = (
      <Box flexDirection="column">
        <Text bold>Audit log (this session)</Text>
        {audit.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {audit.slice(-20).map((entry, index) => (
          <Box key={`audit:${index}:${entry.at}`} flexDirection="row" gap={1}>
            <Text color={entry.dir === 'drop' ? 'error' : entry.dir === 'held' ? 'warning' : undefined}>{DIR_GLYPH[entry.dir]}</Text>
            <Text dimColor>{clockTime(entry.at)}</Text>
            <Text wrap="truncate-end">{row(`${entry.kind}: ${entry.text}`, width - 10)}</Text>
          </Box>
        ))}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      {tabBar}
      {body}
      {isTab ? null : (
        <Box key="footer" flexDirection="row" gap={1}>
          <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($, rt)} />
        </Box>
      )}
    </Box>
  )
}

async function closePane($: EngineInterface, rt: Runtime): Promise<void> {
  rt.isPaneOpen = false
  await $.ui.close({ id: PANE })
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  try {
    await $.command.register({ name: 'wa', description: 'WhatsApp bridge: panel, setup, presence, interaction, project group', argumentHint: '[setup | test | away | here | interact on|off | night | link-project | help]', immediate: true })
  } catch (error) {
    $.ui.log(`${NAME}: could not register /wa: ${messageOf(error)}`, { to: 'debug' })
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

  on('command.run', { command: 'wa' }, async ($, e) => {
    try {
      return { text: await runWa($, rt, e.args) }
    } catch (error) {
      return { text: `The /wa command failed: ${messageOf(error)}` }
    }
  })

  // The system prompt says what WhatsApp can do now: one fixed text per interaction mode (cache-friendly).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isConfigured(rt) || e.traits.includes('bare')) return composed
    const isInteractive = canInteract(rt, await $.clock.now())
    return { sections: [...composed.sections, { id: 'whatsapp-bridge', text: composeSection(isInteractive), scope: 'session' }] }
  })

  // Typing counts as being at the keyboard (read on the next heartbeat; no work per key).
  on('prompt.edit', ($, e, next) => {
    rt.typed = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) rt.lastActiveAt = await $.clock.now()
    return next(e)
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
    () => ({ result: 'whatsapp-bridge: the message could not be sent (see /wa, Log).' }),
  )
  on('tool.call', { tool: `${TOOL_PREFIX}send_file` }, async ($, e) => ({ result: await toolSendFile($, rt, e as unknown as Record<string, unknown>) })).catch(
    () => ({ result: 'whatsapp-bridge: the file could not be sent.' }),
  )
  on('tool.call', { tool: `${TOOL_PREFIX}ask` }, async ($, e, next) => ({
    result: await toolAsk($, rt, e as unknown as Record<string, unknown>, () => next.budget.remainingMs, next.signal),
  })).catch(() => ({ result: 'The question could not be asked. Proceed with your best judgement and state your assumption.' }))
  on('tool.call', { tool: `${TOOL_PREFIX}open_panel` }, async $ => {
    await openPane($, rt)
    return { result: 'The WhatsApp panel is open beside the conversation.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(TOOL_PREFIX)) return next(e)
    const ran = await next(e)
    if (e.agentId === undefined) {
      const isFailed = ran.deny !== undefined || ran.isError === true
      await onToolResult($, rt, tool, e as unknown as Record<string, unknown>, isFailed).catch(() => undefined)
    }
    return ran
  })

  // Messages go only to the owner's own allowlisted chats, after redaction: no prompt for notify, ask and the panel.
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
      if (verdict === 'deny') return { ...answer, decision: { behavior: 'deny', message: 'Denied by the owner from WhatsApp.' } }
    } catch (error) {
      $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })
    }
    return answer
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    rt.isPaneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, rt, e))

  // The Channels tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawPane($, rt, e, true)}
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

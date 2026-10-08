import { atom, read, update } from 'claude-code'
import type { ElementConstructor, ElementTable, EngineInterface, InputProps, Register, RenderElement, RenderInput, RenderSurface, Timer } from 'claude-code'

import type {
  WaAttention,
  WaConnection,
  WaEventKey,
  WaGroupCard,
  WaGroupLink,
  WaGroupRow,
  WaGroupScope,
  WaInbound,
  WaInboundEvent,
  WaLogEntry,
  WaMemberQa,
  WaPrefs,
  WaPriority,
  WaPrivacy,
  WaSessionInfo,
  WaSetup,
  WaTab,
} from '../types'
import type { ModsEvent, ModsNotice } from '../types/mods-hub'
import { MAX_OPTIONS, matchAnswer, optionsFor, pendingFor, questionText } from './answers'
import type { Answer, Pending } from './answers'
import { HELP_TEXT, parseCommand, reactionMeaning, takePin } from './commands'
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
import {
  canonicalOwner,
  classifyOwnerText,
  emptyQaBook,
  estimateUsd,
  groupKeyFor,
  groupNameFor,
  inboundHealth,
  inboxText,
  isMemberCommand,
  maskChat,
  normalizeJid,
  parseGroupKey,
  parseInvitees,
  qaPrompt,
  takeQa,
} from './inbound'
import type { QaBook, QaContext, Usage } from './inbound'
import { bugPrompt, emptyBook, isOwnerPhone, memberTrigger, parseIssueDraft, phoneOf, takeQuota } from './members'
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
  memberCountOf,
  parseMessageId,
  parseParticipantResults,
  parseRows,
  parseSession,
  parseSessions,
  phaseOf,
} from './openwa'
import type { Request, WaRow } from './openwa'
import { LEASE_RENEW_MS, MAX_PAGES, PAGE_LIMIT, backoff, isLeaseTaken, leaseAction, parseLease, pollInterval, remember, walkPage } from './poller'
import type { Cursor, Lease } from './poller'
import { crossed, crossedBudgets, dayKey, decide, isAway } from './policy'
import { clean, oneLine } from './privacy'
import {
  CONTAINER,
  IMAGE,
  SESSION_NAME,
  adminKeyArgv,
  dashboardOf,
  dockerCheckOf,
  endpointOf,
  healthDelay,
  lockState,
  normalizeBaseUrl,
  parseLock,
  pullArgv,
  pullProgressOf,
  removeArgv,
  runArgv,
  runFailureOf,
  stateArgv,
  stopArgv,
  unreachableText,
  versionArgv,
} from './launcher'
import type { ServerLock } from './launcher'
import { decodePng, qrBlocks, qrModules, qrSvg } from './qr'
import { chartSvg, chartText, costChart, routerChart, testsChart } from './reports'
import type { Chart } from './reports'
import { LIVE_MS, defaultLabel, groupOfSession, isLive, isPathLabel, isSessionOfKey, projectNameOf, projectOfChat, route, slugLabel } from './routing'
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
/** A hub notice whose send failed this many drains in a row is given up. */
const HUB_MAX_TRIES = 5
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

const EMPTY_CONNECTION: WaConnection = { phase: 'unconfigured', detail: '', raw: '', phone: '', qr: '', qrModules: [], pairingCode: '', mode: 'unknown', isLeader: false }
const EMPTY_SETUP: WaSetup = { step: 'idle', note: '', raw: '', docker: '', owner: '', autoStart: false, isManual: false, baseUrl: '' }
/** While the server boots or waits for the QR scan: check this often (the QR rotates about every 20 s). */
const SETUP_TICK_MS = 3_000
/** How long a freshly started server may take to answer its health check. */
const BOOT_WAIT_MS = 120_000
/** `docker pull` of a ~1 GB image on a slow line. */
const PULL_TIMEOUT_MS = 20 * 60_000
/** The same toast is not shown again within this long. */
const TOAST_REPEAT_MS = 60_000
/** While the server answers, the background check runs this often (the leader's polls notice trouble sooner). */
const HEALTH_OK_MS = 60_000
/** groups.json is written by any session: a write that lost a race is applied again, this many times at most. */
const GROUP_WRITE_TRIES = 3
/** Inbound events kept per leader for `/wa inbox`. */
const INBOUND_KEEP = 50
/** Questions held while interaction is off, at most. */
const PARKED_QUESTIONS_KEEP = 10

const tabAtom = atom({ plugin: 'whatsapp-bridge', key: 'tab' } as const, 'status' as WaTab)
const connectionAtom = atom({ plugin: 'whatsapp-bridge', key: 'connection' } as const, EMPTY_CONNECTION)
const setupAtom = atom({ plugin: 'whatsapp-bridge', key: 'setup' } as const, EMPTY_SETUP)
const groupAtom = atom({ plugin: 'whatsapp-bridge', key: 'group' } as const, { link: null, note: '', choices: [] } as WaGroupCard)
const sessionsAtom = atom({ plugin: 'whatsapp-bridge', key: 'sessions' } as const, [] as WaSessionInfo[])
const conversationAtom = atom({ plugin: 'whatsapp-bridge', key: 'conversation' } as const, [] as WaLogEntry[])
const prefsAtom = atom({ plugin: 'whatsapp-bridge', key: 'prefs' } as const, defaultPrefs(readSettings({})))
const privacyAtom = atom({ plugin: 'whatsapp-bridge', key: 'privacy' } as const, { allowlist: [], sample: '', redacted: '' } as WaPrivacy)
const auditAtom = atom({ plugin: 'whatsapp-bridge', key: 'audit' } as const, [] as WaLogEntry[])
const membersAtom = atom({ plugin: 'whatsapp-bridge', key: 'members' } as const, [] as WaMemberQa[])
const inboundAtom = atom({ plugin: 'whatsapp-bridge', key: 'inbound' } as const, { lastAt: 0, health: 'none', detail: '' } as WaInbound)
const attentionAtom = atom({ plugin: 'whatsapp-bridge', key: 'attention' } as const, { canAsk: true, isAway: false, isNight: false, isPaused: false, interaction: 'auto', quietHours: '', label: '', isHub: false } as WaAttention)
const groupsAtom = atom({ plugin: 'whatsapp-bridge', key: 'groups' } as const, [] as WaGroupRow[])

/**
 * config.json in the shared folder: what /wa setup learned. Never the admin key. `baseUrl`: the user's own OpenWA
 * ("I run it myself"); `managed`: the server is the mod's Docker container; `autoStart`: start it unasked.
 */
type SharedConfig = { apiKey?: string; sessionId?: string; ownerNumbers?: string[]; baseUrl?: string; managed?: boolean; autoStart?: boolean }

/** One entry the leader dropped in a session's inbox. */
type InboxEntry = {
  seq: number
  key: string
  at: number
  kind: 'owner' | 'reaction' | 'member' | 'bug' | 'question'
  /** A `question`: who asked it, so the answer follows the right privacy rules. */
  audience?: 'owner' | 'member'
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
  stats: { costByDay: Record<string, number>; tests: Record<string, { pass: number; fail: number }>; qaUsdByDay?: Record<string, number> }
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
  /** Answers given per chat (the per-chat rate). */
  qa: QaBook
  /** When this leader last finished a poll, and the error it ended with ('' when it went fine). */
  lastPollAt: number
  lastPollError: string
  /** When the last message (from anyone allowed) came in. */
  lastInboundAt: number
  /** Questions that came in while interaction was off: answered when it is back on. */
  parkedQuestions: ParkedQuestion[]
  /** Chats already told "I'll answer later" in this off period. */
  toldLater: string[]
}

/** A question held while interaction is off. */
type ParkedQuestion = { at: number; chatId: string; messageId: string; text: string; audience: 'owner' | 'member'; author: string; root: string | undefined }

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
  /** A person at a terminal prompt (`session.start`'s `isInteractive`); false under the desktop app, which hosts sessions through the SDK. */
  isInteractive: boolean
  isStarted: boolean
  /** Whether Claude's tools are registered: they wait until the bridge is set up, so an unconfigured bridge costs the prompt nothing. */
  areToolsOffered: boolean
  config: SharedConfig
  /** The OpenWA API in use: config.json's (set from the pane) over the option. */
  baseUrl: string
  /** Health checks in a row that found no server, and when the next one is due (backoff up to 60 s). */
  healthFailures: number
  nextCheckAt: number
  /** The last toast and when, so the same words are not repeated. */
  lastToast: { text: string; at: number }
  /** Fast checks while the server boots or the QR waits for a scan. */
  setupTimer: Timer | undefined
  /** A start this session runs (pull, run, provision): one at a time. */
  isStartingServer: boolean
  /** One setup tick at a time, and when the server this session started began booting. */
  isTicking: boolean
  bootStartedAt: number
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
  /** How far this session consumed each leader's inbox file (one writer per file). */
  doneFrom: Record<string, number>
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
  /** The hub's notices for this channel: the last one handled (the next drain acknowledges up to it), the ids handed
   * to `emit` (a notice comes back until acknowledged), whether a drain runs, how often the oldest one failed. */
  hubCursor: string | null
  hubHandled: string[]
  isDraining: boolean
  hubFailures: number
  /** Connection checks so far (the "linked" toast is for a change seen, not the first look). */
  connectionChecks: number
  /** Whether this session runs the background work (polling, inbox, heartbeat): a terminal, or a desktop / IDE / phone host. */
  isHosted: boolean
  isBackgroundStarted: boolean
  isHubGreeted: boolean
  /** Chats that are the owner's though not `<owner>@c.us` (an `@lid` DM or self-chat), learned by a leader (chats.json). */
  ownerChats: string[]
  /** What the person typed in the Groups name field, kept out of state so typing never redraws the pane. */
  groupNameDraft: string
  groupInviteDraft: string
  /** The live sessions as the last refresh found them (the Groups rows' status). */
  lastSessions: WaSessionInfo[]
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
  areToolsOffered: false,
  config: {},
  baseUrl: settings.baseUrl,
  healthFailures: 0,
  nextCheckAt: 0,
  lastToast: { text: '', at: 0 },
  setupTimer: undefined,
  isStartingServer: false,
  isTicking: false,
  bootStartedAt: 0,
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
  doneFrom: {},
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
  hubCursor: null,
  hubHandled: [],
  isDraining: false,
  hubFailures: 0,
  connectionChecks: 0,
  isHosted: false,
  isBackgroundStarted: false,
  isHubGreeted: false,
  ownerChats: [],
  groupNameDraft: '',
  groupInviteDraft: '',
  lastSessions: [],
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
  qa: emptyQaBook(),
  lastPollAt: 0,
  lastPollError: '',
  lastInboundAt: 0,
  parkedQuestions: [],
  toldLater: [],
})

const paths = {
  config: (rt: Runtime): string => `${rt.dir}/config.json`,
  prefs: (rt: Runtime): string => `${rt.dir}/prefs.json`,
  groups: (rt: Runtime): string => `${rt.dir}/groups.json`,
  chats: (rt: Runtime): string => `${rt.dir}/chats.json`,
  inbound: (rt: Runtime): string => `${rt.dir}/inbound`,
  inboundFrom: (rt: Runtime, writer: string): string => `${rt.dir}/inbound/${writer}.jsonl`,
  lease: (rt: Runtime): string => `${rt.dir}/lease.json`,
  server: (rt: Runtime): string => `${rt.dir}/server.json`,
  leader: (rt: Runtime): string => `${rt.dir}/leader.json`,
  sessions: (rt: Runtime): string => `${rt.dir}/sessions`,
  session: (rt: Runtime, id: string): string => `${rt.dir}/sessions/${id}.json`,
  inbox: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.jsonl`,
  inboxDir: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}`,
  inboxFrom: (rt: Runtime, id: string, writer: string): string => `${rt.dir}/inbox/${id}/${writer}.jsonl`,
  done: (rt: Runtime, id: string): string => `${rt.dir}/inbox/${id}.done.json`,
  log: (rt: Runtime, id: string): string => `${rt.dir}/log/${id}.jsonl`,
  members: (rt: Runtime): string => `${rt.dir}/members.jsonl`,
  memberLogs: (rt: Runtime): string => `${rt.dir}/members`,
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
/**
 * Whether a question from the phone may be answered now. Answering is not Claude starting a conversation, so it is held
 * only by an explicit "not now": Silent, Night, or interaction set off (with the bridge alone, its off-hours count as
 * night). mods-hub's "auto" asks only while you are away, but it still answers what you ask.
 */
const mayReply = (rt: Runtime, now: number): boolean =>
  rt.hub === undefined ? canInteract(rt, now) : !(rt.hub.isSilent || rt.hub.isNight || rt.hub.interaction === 'off')
const interactionText = (rt: Runtime, now: number): string =>
  rt.hub === undefined ? interactionLabel(rt.prefs, rt.settings.interactionOffHours, now) : hubModeLabel(rt.hub)
const ownerChat = (rt: Runtime): string => directChat(rt.owners[0] ?? '')
/** This session's group: its own per-session group, else its project's. */
const projectGroup = (rt: Runtime): WaGroupLink | undefined => groupOfSession(rt.groups, rt)
/** The groups.json key a group created or linked from this session gets, by the group scope setting. */
const ownGroupKey = (rt: Runtime): string => groupKeyFor(rt.root, rt.label, rt.settings.groupScope)

/** The chats the mod may ever read or write: the owners' direct chats, linked project groups and extra chats. */
const allowlist = (rt: Runtime): string[] => [
  ...new Set([...rt.owners.map(directChat), ...rt.ownerChats, ...Object.values(rt.groups).map(link => link.groupId), ...rt.settings.extraChats.map(normalizeJid)]),
]
const isAllowed = (rt: Runtime, chatId: string): boolean => chatId !== '' && allowlist(rt).includes(normalizeJid(chatId))

// ── State the pane draws ─────────────────────────────────────────────────────────────────────────

/**
 * Writes a value the pane draws only when it changed (call as `putIf(await read($, a), change, fn => update($, a, fn))`:
 * the state calls name their atom where `claude plugin validate` can read it). Every write redraws the pane, and a redraw renews the handles
 * of its buttons: a desktop click carries the handle of the drawing it was made on, so a click landing after a redraw
 * nobody needed was dropped ("nothing ran"). Timers (the heartbeat, the setup ticks, the inbox) therefore never write
 * what they found unchanged.
 */
async function putIf<T>(current: T, change: (value: T) => T, write: (change: (value: T) => T) => Promise<T>): Promise<T> {
  const next = change(current)
  if (JSON.stringify(next) === JSON.stringify(current)) return current
  // Written through `update` (read again under its version), so a write racing this one is never lost.
  return write(change)
}

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
    summary: rt.file.info.summary ?? '',
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
  if (request.isPublic !== true) headers['X-API-Key'] = request.key ?? rt.apiKey
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey
  try {
    const response = await $.http.fetch(`${rt.baseUrl}${request.path}`, {
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

const failure = (result: CallResult): string => (result.status === 0 ? `${unreachableText(result.text)} (${oneLine(result.text, 80)})` : errorText(result.status, result.text))

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
  const filename = input.path.split(/[\\/]/).at(-1) ?? 'file'
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
  rt.baseUrl = (typeof rt.config.baseUrl === 'string' && rt.config.baseUrl !== '' ? rt.config.baseUrl : rt.settings.baseUrl).replace(/\/+$/, '')
  rt.sessionId = typeof rt.config.sessionId === 'string' ? rt.config.sessionId : ''
  const stored = Array.isArray(rt.config.ownerNumbers) ? rt.config.ownerNumbers.map(String).map(canonicalOwner) : []
  rt.owners = [...new Set([...rt.settings.ownerNumbers, ...stored])].filter(n => n.length >= 6)
  rt.prefs = mergePrefs(await readJsonFile($, paths.prefs(rt)), rt.settings)
  const groups = await readJsonFile($, paths.groups(rt))
  rt.groups = groupsOf(groups)
  const chats = await readJsonFile($, paths.chats(rt))
  rt.ownerChats = isRecord(chats) && Array.isArray(chats.owner) ? chats.owner.filter((one): one is string => typeof one === 'string') : []
  await putIf(await read($, prefsAtom), () => rt.prefs, fn => update($, prefsAtom, fn))
  await putIf(await read($, setupAtom), setup => ({ ...setup, autoStart: rt.config.autoStart === true, baseUrl: rt.baseUrl }), fn => update($, setupAtom, fn))
}

/** groups.json made whole: entries with a group id (the `_rev` counter and anything malformed left out). */
const groupsOf = (value: unknown): Record<string, WaGroupLink> =>
  isRecord(value) ? (Object.fromEntries(Object.entries(value).filter(([key, link]) => !key.startsWith('_') && isRecord(link) && typeof link.groupId === 'string')) as Record<string, WaGroupLink>) : {}

async function saveConfig($: EngineInterface, rt: Runtime, change: Partial<SharedConfig>): Promise<void> {
  // From the file, not this session's copy: a key or owner another session saved meanwhile is kept.
  const stored = await readJsonFile($, paths.config(rt))
  rt.config = { ...(isRecord(stored) ? (stored as SharedConfig) : rt.config), ...change }
  await writeJsonFile($, paths.config(rt), rt.config)
  await loadShared($, rt)
}

async function savePrefs($: EngineInterface, rt: Runtime, change: (prefs: WaPrefs) => WaPrefs): Promise<WaPrefs> {
  rt.prefs = change(mergePrefs(await readJsonFile($, paths.prefs(rt)), rt.settings))
  await writeJsonFile($, paths.prefs(rt), rt.prefs)
  await putIf(await read($, prefsAtom), () => rt.prefs, fn => update($, prefsAtom, fn))
  await refreshAttention($, rt)
  return rt.prefs
}

/**
 * Changes groups.json safely though any session may write it: read, change, write with the next `_rev`, read back;
 * when another session's write landed in between (its `_rev` or its content won), the change is applied again on top.
 */
async function saveGroups($: EngineInterface, rt: Runtime, change: (groups: Record<string, WaGroupLink>) => Record<string, WaGroupLink>): Promise<void> {
  for (let attempt = 0; attempt < GROUP_WRITE_TRIES; attempt += 1) {
    const stored = await readJsonFile($, paths.groups(rt))
    const rev = isRecord(stored) && typeof stored._rev === 'number' ? stored._rev : 0
    const next = change(groupsOf(stored))
    await writeJsonFile($, paths.groups(rt), { _rev: rev + 1, ...next })
    const back = await readJsonFile($, paths.groups(rt))
    rt.groups = groupsOf(back)
    if (isRecord(back) && back._rev === rev + 1 && JSON.stringify(rt.groups) === JSON.stringify(next)) break
  }
  await refreshGroupCard($, rt, '')
}

/** Asks OpenWA where things stand (health, key, session, link) and shows it on the pane. */
async function checkConnection($: EngineInterface, rt: Runtime): Promise<WaConnection> {
  await offerTools($, rt)
  const now = await $.clock.now()
  const previous = await read($, connectionAtom)
  const base: WaConnection = { ...EMPTY_CONNECTION, isLeader: rt.isLeader, mode: rt.mode }
  const wasChecked = rt.connectionChecks > 0
  rt.connectionChecks += 1
  const set = async (connection: WaConnection): Promise<WaConnection> => {
    await putIf(await read($, connectionAtom), () => connection, fn => update($, connectionAtom, fn))
    return connection
  }
  const health = await waCall($, rt, api.health())
  if (!health.ok) {
    // Backoff: 5 s, 10 s, 20 s ... at most 60 s between checks while nothing answers; one toast when it goes away.
    rt.healthFailures += 1
    rt.nextCheckAt = now + healthDelay(rt.healthFailures)
    if (previous.phase === 'ready') toastOnce($, rt, now, 'WhatsApp: OpenWA stopped answering. Open /wa to start it again.')
    const raw = health.status === 0 ? health.text : errorText(health.status, health.text)
    return set({ ...base, phase: 'unreachable', detail: health.status === 0 ? unreachableText(raw) : 'OpenWA answered with an error', raw })
  }
  rt.healthFailures = 0
  rt.nextCheckAt = now + HEALTH_OK_MS
  if (rt.apiKey === '') return set({ ...base, phase: 'no-key', detail: 'OpenWA is running; the mod has no key for it yet.' })
  const valid = await waCall($, rt, api.validate())
  if (!valid.ok) return set({ ...base, phase: 'no-key', detail: 'OpenWA refused the stored key.', raw: failure(valid) })
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
  if (session === null) return set({ ...base, phase: 'error', detail: 'OpenWA did not return the WhatsApp session.', raw: failure(got) })
  rt.botPhone = session.phone
  rt.mode = session.phone === '' ? 'unknown' : rt.owners.includes(session.phone) ? 'self' : 'bot'
  const phase = phaseOf(session.status)
  let qr = ''
  if (phase === 'qr') {
    const code = await waCall($, rt, api.qr(rt.sessionId))
    qr = isRecord(code.json) && typeof code.json.qrCode === 'string' ? dataUrlBase64(code.json.qrCode) : ''
  }
  // Decoded once per new QR, not per drawing.
  const modules = qr === '' ? [] : qr === previous.qr ? previous.qrModules : qrModulesOf(qr)
  const detail =
    phase === 'ready'
      ? `Linked as +${session.phone}${session.pushName !== '' ? ` (${session.pushName})` : ''}`
      : phase === 'qr'
        ? 'Scan the QR with WhatsApp › Linked devices, or pair with a code'
        : phase === 'disconnected'
          ? 'Disconnected: press Reconnect'
          : phase === 'starting'
            ? 'The WhatsApp session is starting…'
            : 'The WhatsApp session reported an error.'
  if (phase === 'ready' && previous.phase !== 'ready' && wasChecked) toastOnce($, rt, now, `WhatsApp linked as +${session.phone}.`)
  const raw = phase === 'error' || phase === 'starting' ? (session.lastError !== '' ? session.lastError : session.status) : ''
  return set({ ...base, phase, detail, raw, phone: session.phone, qr, qrModules: modules, pairingCode: phase === 'qr' ? previous.pairingCode : '', mode: rt.mode })
}

/** The QR's module rows from OpenWA's PNG; [] when it does not decode (the pane falls back to the image or a link). */
const qrModulesOf = (base64: string): string[] => {
  const picture = decodePng(base64)
  return picture === null ? [] : qrModules(picture)
}

/** A toast, unless the same words were shown less than a minute ago. */
function toastOnce($: EngineInterface, rt: Runtime, now: number, text: string): void {
  if (rt.lastToast.text === text && now - rt.lastToast.at < TOAST_REPEAT_MS) return
  rt.lastToast = { text, at: now }
  $.ui.toast(text)
}

// ── Starting OpenWA: the guided setup ───────────────────────────────────────────────────────────

type Ran = { exitCode: number; stdout: string; stderr: string } | { error: string }

async function setSetup($: EngineInterface, change: Partial<WaSetup>): Promise<WaSetup> {
  return putIf(await read($, setupAtom), setup => ({ ...setup, ...change }), fn => update($, setupAtom, fn))
}

/** A host command that never throws: a missing binary or a timeout comes back as `{ error }`. */
async function runHost($: EngineInterface, argv: readonly string[], timeoutMs: number): Promise<Ran> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

const ranOk = (ran: Ran): ran is { exitCode: number; stdout: string; stderr: string } => !('error' in ran) && ran.exitCode === 0
const ranText = (ran: Ran): string => ('error' in ran ? ran.error : `${ran.stderr}\n${ran.stdout}`.trim())

async function readLock($: EngineInterface, rt: Runtime): Promise<ServerLock | null> {
  return parseLock(await readJsonFile($, paths.server(rt)))
}

/** Takes or renews server.json for this session; true once it is read back as this session's (two may race). */
async function holdLock($: EngineInterface, rt: Runtime, phase: ServerLock['phase']): Promise<boolean> {
  const now = await $.clock.now()
  const lock = await readLock($, rt)
  if (lockState(lock, rt.me, now) === 'held') return false
  await writeJsonFile($, paths.server(rt), { owner: rt.me, phase, heartbeatAt: now, startedAt: lock?.owner === rt.me ? lock.startedAt : now } satisfies ServerLock)
  return (await readLock($, rt))?.owner === rt.me
}

/** Lets another session take over (on session end, a stop or a failed start); only while it still names this one. */
async function releaseLock($: EngineInterface, rt: Runtime): Promise<void> {
  if ((await readLock($, rt))?.owner === rt.me) await writeJsonFile($, paths.server(rt), { owner: '', phase: 'running', heartbeatAt: 0, startedAt: 0 })
}

async function failSetup($: EngineInterface, rt: Runtime, note: string, raw: string): Promise<string> {
  await releaseLock($, rt)
  await setSetup($, { step: 'failed', note, raw: oneLine(raw, 300) })
  return note
}

/** Step 1: Docker, the one prerequisite (OpenWA ships as an image only). */
async function checkDocker($: EngineInterface): Promise<WaSetup> {
  await setSetup($, { step: 'checking', note: 'Checking Docker…', raw: '' })
  const check = dockerCheckOf(await runHost($, versionArgv(), 15_000))
  const step = check.state === 'ok' ? 'ready' : check.state === 'missing' ? 'no-docker' : check.state === 'stopped' ? 'docker-off' : 'failed'
  return setSetup($, { step, note: check.state === 'ok' ? `Docker ${check.version} is ready.` : check.note, docker: check.version })
}

/**
 * Step 2, on the user's press (or with "Start automatically" on): runs OpenWA in Docker, unless a server already
 * answers or another session is starting one (server.json). Returns once the container runs; the setup's ticks then
 * wait for its health, provision it and show the QR.
 */
async function startServer($: EngineInterface, rt: Runtime): Promise<string> {
  if (rt.isStartingServer) return 'OpenWA is already starting.'
  const { port, isLocal } = endpointOf(rt.baseUrl)
  if (!isLocal) return `The mod starts OpenWA on this machine only, and ${rt.baseUrl} is another host: start it there.`
  rt.isStartingServer = true
  try {
    if ((await waCall($, rt, api.health())).ok) {
      await setSetup($, { step: 'running', note: 'OpenWA is already running: using it.', raw: '', owner: rt.config.managed === true ? 'other' : 'external' })
      return continueSetup($, rt)
    }
    if (!(await holdLock($, rt, 'starting'))) {
      await setSetup($, { step: 'elsewhere', owner: 'other', note: 'Another Claude Code session is starting OpenWA; this one will use it.', raw: '' })
      ensureSetupTicks($, rt)
      return 'Another session is starting OpenWA.'
    }
    const docker = await checkDocker($)
    if (docker.step !== 'ready') {
      await releaseLock($, rt)
      return docker.note
    }
    if (!ranOk(await runHost($, ['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE], 15_000))) {
      await holdLock($, rt, 'pulling')
      await setSetup($, { step: 'pulling', note: 'Downloading OpenWA (about 1 GB, once)…', raw: '' })
      const pulled = await pullImage($, rt)
      if (!pulled.ok) return failSetup($, rt, runFailureOf(pulled.text, port), pulled.text)
    }
    await holdLock($, rt, 'starting')
    const existing = await runHost($, stateArgv(), 15_000)
    const isRunning = ranOk(existing) && existing.stdout.trim() === 'running'
    // A stopped container of ours (a crash, a reboot) keeps the name: replace it. Its data lives in the volume.
    if (ranOk(existing) && !isRunning) await runHost($, removeArgv(), 30_000)
    await setSetup($, { step: 'booting', note: 'Starting OpenWA…', raw: '', owner: 'this' })
    if (!isRunning) {
      const engine = rt.settings.autoCreateGroup ? 'baileys' : 'whatsapp-web.js'
      const ran = await runHost($, runArgv(port, engine), 120_000)
      if (!ranOk(ran)) return failSetup($, rt, runFailureOf(ranText(ran), port), ranText(ran))
    }
    await saveConfig($, rt, { managed: true })
    rt.bootStartedAt = await $.clock.now()
    rt.healthFailures = 0
    ensureSetupTicks($, rt)
    return 'Starting OpenWA…'
  } finally {
    rt.isStartingServer = false
  }
}

/** `docker pull` in the background (a spawned child, streamed): the last line it printed is the progress row. */
async function pullImage($: EngineInterface, rt: Runtime): Promise<{ ok: boolean; text: string }> {
  let tail = ''
  let shownAt = 0
  const startedAt = await $.clock.now()
  try {
    const pull = $.process.spawn({ argv: pullArgv() })
    for await (const chunk of pull) {
      tail = `${tail}${chunk.text}`.slice(-4_000)
      const now = await $.clock.now()
      if (now - shownAt >= 1_000) {
        shownAt = now
        await setSetup($, { raw: oneLine(pullProgressOf(tail), 120) })
        await holdLock($, rt, 'pulling')
      }
      if (now - startedAt > PULL_TIMEOUT_MS) return { ok: false, text: 'the download took too long' }
    }
    const ended = await pull.result
    return { ok: ended.code === 0, text: tail }
  } catch (error) {
    return { ok: false, text: `${messageOf(error)}\n${tail}` }
  }
}

/** Stops the managed container (the user's press); the WhatsApp link stays in its volume for the next start. */
async function stopServer($: EngineInterface, rt: Runtime): Promise<string> {
  const stopped = await runHost($, stopArgv(), 60_000)
  await releaseLock($, rt)
  await setSetup($, { step: 'idle', note: '', raw: ranOk(stopped) ? '' : oneLine(ranText(stopped), 200) })
  await checkConnection($, rt)
  return ranOk(stopped) ? 'OpenWA stopped. Start it again from /wa.' : `Could not stop OpenWA: ${oneLine(ranText(stopped), 120)}`
}

/**
 * Step 3, once the server answers: what is still missing on a server the mod runs. Mints the scoped key with the
 * admin key it reads from the container (held for these calls only, never stored), then starts the WhatsApp session.
 */
async function continueSetup($: EngineInterface, rt: Runtime): Promise<string> {
  const connection = await checkConnection($, rt)
  if (rt.config.managed === true && (connection.phase === 'no-key' || connection.phase === 'no-session' || connection.phase === 'admin-key')) return provision($, rt)
  if (connection.phase === 'disconnected' || (connection.phase === 'error' && rt.sessionId !== '')) {
    await waCall($, rt, api.start(rt.sessionId))
    await checkConnection($, rt)
  }
  ensureSetupTicks($, rt)
  const now = await read($, connectionAtom)
  if (now.phase === 'no-key' || now.phase === 'no-session') {
    return 'OpenWA is running but the mod has no key for it: use "I run it myself" to paste a scoped key (/wa setup shows how).'
  }
  return now.phase === 'ready' ? now.detail : 'OpenWA is running: link your phone with the QR in /wa.'
}

async function provision($: EngineInterface, rt: Runtime): Promise<string> {
  await setSetup($, { step: 'provisioning', note: 'Creating the WhatsApp session and a scoped key…', raw: '' })
  const admin = await runHost($, adminKeyArgv(), 20_000)
  const adminKey = ranOk(admin) ? admin.stdout.trim() : ''
  if (adminKey === '') return failSetup($, rt, `Could not read OpenWA's admin key from the ${CONTAINER} container.`, ranText(admin))
  const listed = await waCall($, rt, api.sessionsNamed(SESSION_NAME, adminKey))
  let session = parseSessions(listed.json).find(one => one.name === SESSION_NAME) ?? null
  if (session === null) {
    const created = await waCall($, rt, api.createSession(SESSION_NAME, adminKey))
    session = parseSession(created.json)
    if (session === null) return failSetup($, rt, 'OpenWA did not create the WhatsApp session.', failure(created))
  }
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const minted = await waCall($, rt, api.createKey(session.id, `claude-code ${day}`, adminKey))
  const key = isRecord(minted.json) && typeof minted.json.apiKey === 'string' ? minted.json.apiKey : ''
  if (key === '') return failSetup($, rt, 'OpenWA did not mint the scoped key.', failure(minted))
  await saveConfig($, rt, { apiKey: key, sessionId: session.id, managed: true })
  const started = await waCall($, rt, api.start(session.id))
  // 400: already started (the server's auto-start beat us to it).
  if (!started.ok && started.status !== 400) await setSetup($, { raw: oneLine(failure(started), 200) })
  await setSetup($, { step: 'running', note: 'OpenWA is running.', owner: (await readLock($, rt))?.owner === rt.me ? 'this' : 'other' })
  await checkConnection($, rt)
  ensureSetupTicks($, rt)
  return 'OpenWA is set up: scan the QR in /wa to link WhatsApp.'
}

/** Whether the fast ticks have something to watch: a server booting, or a link waiting for its scan. */
const isSettling = (setup: WaSetup, connection: WaConnection): boolean =>
  setup.step === 'booting' || setup.step === 'elsewhere' || connection.phase === 'qr' || connection.phase === 'starting'

function ensureSetupTicks($: EngineInterface, rt: Runtime): void {
  if (rt.setupTimer !== undefined) return
  rt.setupTimer = $.clock.every(SETUP_TICK_MS, () => void setupTick($, rt).catch(error => $.ui.log(`${NAME}: setup: ${messageOf(error)}`, { to: 'debug' })))
}

function stopSetupTicks(rt: Runtime): void {
  rt.setupTimer?.cancel()
  rt.setupTimer = undefined
}

/** Every 3 s while settling: the booting server's health, then provisioning; the QR (it rotates) until linked. */
async function setupTick($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    const setup = await read($, setupAtom)
    const now = await $.clock.now()
    if (setup.step === 'booting' || setup.step === 'elsewhere') {
      const lock = await readLock($, rt)
      if (lock?.owner === rt.me) await holdLock($, rt, 'starting')
      if ((await waCall($, rt, api.health())).ok) {
        if (lock?.owner === rt.me) await holdLock($, rt, 'running')
        await setSetup($, { step: 'running', note: 'OpenWA is running.', raw: '' })
        // The session that started it provisions; another waits for the key it saves (config.json).
        if (setup.step === 'booting') await continueSetup($, rt)
        else {
          await loadShared($, rt)
          await checkConnection($, rt)
        }
        return
      }
      if (setup.step === 'booting' && now - rt.bootStartedAt > BOOT_WAIT_MS) {
        const logs = await runHost($, ['docker', 'logs', '--tail', '5', CONTAINER], 15_000)
        stopSetupTicks(rt)
        await failSetup($, rt, 'OpenWA did not answer within 2 minutes.', ranText(logs))
        return
      }
      if (setup.step === 'elsewhere' && lockState(lock, rt.me, now) === 'free') {
        stopSetupTicks(rt)
        await setSetup($, { step: 'ready', note: 'The other session stopped starting OpenWA: start it here.', owner: '' })
      }
      return
    }
    const connection = await checkConnection($, rt)
    if (setup.step === 'running' && connection.phase === 'no-key' && rt.config.managed === true) await loadShared($, rt)
    if (!isSettling(await read($, setupAtom), connection)) stopSetupTicks(rt)
  } finally {
    rt.isTicking = false
  }
}

/** With "Start automatically" on: at session start, a managed server that does not answer is started (once). */
async function autoStart($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.config.autoStart !== true || !endpointOf(rt.baseUrl).isLocal) return
  if ((await waCall($, rt, api.health())).ok) return
  if (lockState(await readLock($, rt), rt.me, await $.clock.now()) === 'held') return
  await startServer($, rt)
}

/** The "I run it myself" URL: saved for every session, then checked. */
async function saveBaseUrl($: EngineInterface, rt: Runtime, input: string): Promise<string> {
  const url = normalizeBaseUrl(input)
  if (url === '') return 'That is not a URL: try http://127.0.0.1:2785/api'
  await saveConfig($, rt, { baseUrl: url, managed: false })
  rt.healthFailures = 0
  const connection = await checkConnection($, rt)
  await setSetup($, { owner: 'external' })
  return connection.phase === 'unreachable' ? `Saved ${url}, but nothing answers there yet (${connection.detail}).` : `Saved ${url}: ${connection.detail}`
}

/** Runs a setup step after the press or command returned, so a long pull never holds a hook. */
function inBackground($: EngineInterface, rt: Runtime, work: () => Promise<string>): void {
  $.clock.after(0, () => {
    void work()
      .then(async outcome => {
        if (outcome !== '') toastOnce($, rt, await $.clock.now(), oneLine(outcome, 160))
      })
      .catch(error => $.ui.log(`${NAME}: setup: ${messageOf(error)}`, { to: 'debug' }))
  })
}

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────

async function refreshGroupCard($: EngineInterface, rt: Runtime, note: string): Promise<void> {
  const link = projectGroup(rt) ?? null
  await putIf(await read($, groupAtom), card => ({ link, note: note || (link === null ? card.note : ''), choices: link === null ? card.choices : [] }), fn => update($, groupAtom, fn))
  await putIf(await read($, groupsAtom), () => groupRows(rt, rt.lastSessions), fn => update($, groupsAtom, fn))
}

/** The Groups section's rows: every managed group, where it routes, how many members, whether a session runs for it. */
function groupRows(rt: Runtime, sessions: readonly WaSessionInfo[]): WaGroupRow[] {
  const own = projectGroup(rt)
  return Object.entries(rt.groups)
    .map(([key, link]): WaGroupRow => {
      const { root, label } = parseGroupKey(key)
      const isThis = own !== undefined && own.groupId === link.groupId && isSessionOfKey(rt, key)
      const status = isThis ? 'this' : sessions.some(session => !session.ended && isSessionOfKey(session, key)) ? 'live' : 'idle'
      return { key, groupId: link.groupId, name: link.name, routesTo: `${projectNameOf(root)}${label !== undefined ? ` · #${label}` : ''}`, members: link.members, status, inviteLink: link.inviteLink }
    })
    .sort((a, b) => (a.status === 'this' ? -1 : b.status === 'this' ? 1 : a.name.localeCompare(b.name)))
}

/** The name a new group of this session gets: "Claude · <project>", per session "Claude · <project> · <label>". */
const defaultGroupName = (rt: Runtime): string => groupNameFor(rt.project, rt.label, rt.settings.groupScope)

/**
 * Creates a WhatsApp group for this project (or session, by the group scope) with the owner in it, links it, and posts
 * a welcome that mentions "help". Group creation is Baileys-only in OpenWA (501 on whatsapp-web.js): then the answer
 * says so and offers the manual way (create it on the phone with the bot in it, then link it here).
 */
async function createGroup($: EngineInterface, rt: Runtime, requested: string): Promise<string> {
  if (!isConfigured(rt)) return 'Set up the connection first: /wa setup'
  const name = (requested.trim() || defaultGroupName(rt)).slice(0, 100)
  // With the owner's own number linked the owner is the creator: nobody else needs adding.
  const participants = rt.mode === 'self' ? [] : rt.owners.map(directChat)
  const created = await waCall($, rt, api.createGroup(rt.sessionId, name, participants))
  const groupId = isRecord(created.json) && typeof created.json.id === 'string' ? created.json.id : ''
  if (!created.ok || groupId === '') {
    const isUnsupported = created.status === 501
    const why = isUnsupported
      ? 'this OpenWA engine (whatsapp-web.js) cannot create groups'
      : created.status === 403
        ? 'the key is chat-scoped or WhatsApp refused it'
        : failure(created)
    const manual = `Create "${name}" on your phone${rt.mode === 'self' ? '' : ` with the bot number${rt.botPhone !== '' ? ` (+${rt.botPhone})` : ''} in it`}, then pick it under "Link an existing group" (/wa link-project).`
    const listed = await waCall($, rt, api.groups(rt.sessionId))
    await putIf(await read($, groupAtom), card => ({ ...card, note: `${isUnsupported ? 'Group creation is not supported by this engine.' : 'Could not create the group.'} ${manual}`, choices: parseGroups(listed.json).map(({ id, name: title }) => ({ id, name: title })) }), fn => update($, groupAtom, fn))
    return `Could not create the group: ${why}. ${manual}`
  }
  await linkGroup($, rt, groupId, name, ownGroupKey(rt))
  void waCall($, rt, api.groupDescription(rt.sessionId, groupId, `Claude Code updates for ${rt.project}. Owner: send "help". Members: start with "?" to ask about progress, "bug:" to report a bug.`))
  await waSendText($, rt, {
    chatId: groupId,
    kind: 'welcome',
    text: `🤖 This group gets Claude Code updates for *${rt.project}*${rt.settings.groupScope === 'session' ? ` (session #${rt.label})` : ''}.\nSend *help* for what you can do from here. Ask anything ("what are you doing?"); members start with *?*, or report a bug with *bug:* …`,
  })
  return `Created the WhatsApp group "${name}" and linked it to ${rt.settings.groupScope === 'session' ? `#${rt.label} (${rt.project})` : rt.project}.`
}

async function linkGroup($: EngineInterface, rt: Runtime, groupId: string, name: string, key: string): Promise<void> {
  const now = await $.clock.now()
  const info = await waCall($, rt, api.groupInfo(rt.sessionId, groupId))
  const members = memberCountOf(info.json)
  const invite = await waCall($, rt, api.inviteCode(rt.sessionId, groupId))
  const inviteLink = isRecord(invite.json) && typeof invite.json.inviteLink === 'string' ? invite.json.inviteLink : ''
  const scope: WaGroupScope = parseGroupKey(key).label !== undefined ? 'session' : 'project'
  // One group, one key: linking it here moves it from wherever it was linked before.
  await saveGroups($, rt, groups => ({
    ...Object.fromEntries(Object.entries(groups).filter(([other, link]) => other !== key && link.groupId !== groupId)),
    [key]: { groupId, name, inviteLink, members, createdAt: now, scope },
  }))
}

/** The managed group a pane row or `/wa group … <n>` names: by key, group id, or 1-based position in the list. */
const pickGroup = (rt: Runtime, ref: string): { key: string; link: WaGroupLink } | undefined => {
  const rows = groupRows(rt, rt.lastSessions)
  const index = Number(ref)
  const row = ref === '' ? rows.find(one => one.status === 'this') : Number.isInteger(index) && index >= 1 ? rows[index - 1] : rows.find(one => one.key === ref || one.groupId === ref)
  const link = row === undefined ? undefined : rt.groups[row.key]
  return row === undefined || link === undefined ? undefined : { key: row.key, link }
}

async function renameGroup($: EngineInterface, rt: Runtime, ref: string, name: string): Promise<string> {
  const picked = pickGroup(rt, ref)
  if (picked === undefined) return 'No such group: /wa groups lists them.'
  const subject = name.trim().slice(0, 100)
  if (subject === '') return 'Usage: /wa group rename <new name>'
  const renamed = await waCall($, rt, api.groupSubject(rt.sessionId, picked.link.groupId, subject))
  if (!renamed.ok) return `WhatsApp did not rename it: ${failure(renamed)}`
  await saveGroups($, rt, groups => ({ ...groups, [picked.key]: { ...picked.link, name: subject } }))
  return `Renamed to "${subject}".`
}

/** Points a managed group at this session (per session) or this project, by the group scope. */
async function relinkGroup($: EngineInterface, rt: Runtime, ref: string): Promise<string> {
  const picked = pickGroup(rt, ref)
  if (picked === undefined) return 'No such group: /wa groups lists them.'
  const key = ownGroupKey(rt)
  await saveGroups($, rt, groups => ({
    ...Object.fromEntries(Object.entries(groups).filter(([other]) => other !== picked.key && other !== key)),
    [key]: { ...picked.link, scope: rt.settings.groupScope },
  }))
  return `"${picked.link.name}" now routes to ${rt.settings.groupScope === 'session' ? `#${rt.label} (${rt.project})` : rt.project}.`
}

/** Adds numbers to a managed group (the owner's pane or /wa only); those WhatsApp refuses (privacy) get the invite link. */
async function inviteToGroup($: EngineInterface, rt: Runtime, ref: string, numbers: string): Promise<string> {
  const picked = pickGroup(rt, ref)
  if (picked === undefined) return 'No such group: /wa groups lists them.'
  const phones = parseInvitees(numbers)
  if (phones.length === 0) return 'Usage: /wa group invite +39333…, +44…  (numbers with country code)'
  const added = await waCall($, rt, api.addParticipants(rt.sessionId, picked.link.groupId, phones.map(directChat)))
  const results = parseParticipantResults(added.json)
  const refused = added.ok ? results.filter(one => !one.isAdded).map(one => one.id.split('@')[0] ?? one.id) : phones
  const invite = picked.link.inviteLink !== '' ? ` Send them the invite link: ${picked.link.inviteLink}` : ''
  const info = await waCall($, rt, api.groupInfo(rt.sessionId, picked.link.groupId))
  if (info.ok) await saveGroups($, rt, groups => ({ ...groups, [picked.key]: { ...picked.link, members: memberCountOf(info.json) || picked.link.members } }))
  if (!added.ok) return `Could not add them (${failure(added)}).${invite}`
  if (refused.length > 0) return `Added ${phones.length - refused.length} of ${phones.length}; WhatsApp refused ${refused.map(n => `+${n}`).join(', ')} (their privacy settings).${invite}`
  return `Added ${plural(phones.length, 'member')} to "${picked.link.name}".`
}

/** Unlinks a managed group (its updates go to the owner's chat again); with `leave`, the bot also leaves it. */
async function unlinkGroup($: EngineInterface, rt: Runtime, ref: string, leave: boolean): Promise<string> {
  const picked = pickGroup(rt, ref)
  if (picked === undefined) return 'No such group: /wa groups lists them.'
  if (leave) {
    const left = await waCall($, rt, api.leaveGroup(rt.sessionId, picked.link.groupId))
    if (!left.ok) return `Could not leave "${picked.link.name}": ${failure(left)}`
  }
  await saveGroups($, rt, groups => Object.fromEntries(Object.entries(groups).filter(([key]) => key !== picked.key)))
  return leave ? `Left and unlinked "${picked.link.name}".` : `Unlinked "${picked.link.name}": its updates go to your direct chat (the group itself stays).`
}

/** `/wa link-project [n|group id]`: create the group, or list the bot's groups, or link the one picked. */
async function linkProject($: EngineInterface, rt: Runtime, arg: string): Promise<string> {
  if (!isConfigured(rt)) return 'Set up the connection first: /wa setup'
  const listed = await waCall($, rt, api.groups(rt.sessionId))
  const groups = parseGroups(listed.json)
  if (arg === '#list') {
    await putIf(await read($, groupAtom), card => ({ ...card, note: groups.length === 0 ? groupListText(groups) : 'Pick the group to link:', choices: groups.map(({ id, name }) => ({ id, name })) }), fn => update($, groupAtom, fn))
    return groups.length === 0 ? groupListText(groups) : ''
  }
  if (arg === '' && rt.settings.autoCreateGroup) {
    const created = await createGroup($, rt, '')
    if (projectGroup(rt) !== undefined) return created
    await putIf(await read($, groupAtom), card => ({ ...card, note: created, choices: groups.map(({ id, name }) => ({ id, name })) }), fn => update($, groupAtom, fn))
    return `${created}\n${groupListText(groups)}`
  }
  if (arg === '') {
    await putIf(await read($, groupAtom), card => ({ ...card, choices: groups.map(({ id, name }) => ({ id, name })) }), fn => update($, groupAtom, fn))
    return groupListText(groups)
  }
  const index = Number(arg)
  const picked = Number.isInteger(index) && index >= 1 ? groups[index - 1] : groups.find(group => group.id === arg || group.name.toLowerCase() === arg.toLowerCase())
  if (picked === undefined) return `No such group. ${groupListText(groups)}`
  await linkGroup($, rt, picked.id, picked.name, ownGroupKey(rt))
  return `Linked "${picked.name}" to ${rt.project}. Updates for this ${rt.settings.groupScope} now go there.`
}

const groupListText = (groups: readonly { id: string; name: string; participantsCount: number }[]): string =>
  groups.length === 0
    ? 'The bot number is in no group yet: create one on your phone with the bot in it, then /wa link-project again.'
    : `Groups the bot is in — /wa link-project <n>:\n${groups.map((group, index) => `${index + 1}. ${group.name}${group.participantsCount > 0 ? ` (${plural(group.participantsCount, 'member')})` : ''}`).join('\n')}`

/** `/wa groups`: the managed groups, numbered for `/wa group … <n>`. */
const managedGroupsText = (rt: Runtime): string => {
  const rows = groupRows(rt, rt.lastSessions)
  if (rows.length === 0) return `No managed group yet. Create one: /wa group create [name] (default "${defaultGroupName(rt)}").`
  return [
    'Managed groups — /wa group rename|link|invite|unlink|leave <n>:',
    ...rows.map((row, index) => `${index + 1}. ${row.name} → ${row.routesTo} · ${plural(row.members, 'member')} · ${row.status === 'this' ? 'this session' : row.status === 'live' ? 'live' : 'no session running'}`),
  ].join('\n')
}

/** Where this project's messages go: its group (created on first use when allowed), else the owner's chat. */
async function projectChat($: EngineInterface, rt: Runtime): Promise<string> {
  const linked = projectGroup(rt)
  if (linked !== undefined) return linked.groupId
  if (rt.settings.autoCreateGroup && !rt.triedGroup && rt.mode === 'bot' && isConfigured(rt)) {
    rt.triedGroup = true
    const outcome = await createGroup($, rt, '')
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
async function emit($: EngineInterface, rt: Runtime, notice: Notice): Promise<{ action: 'send' | 'digest' | 'drop'; reason: string; messageId: string; isFailed?: boolean }> {
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
  return messageId === '' ? { action: 'drop', reason: 'the send failed (see /wa log)', messageId, isFailed: true } : { ...delivery, messageId }
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
  if (!rt.isHosted || !isConfigured(rt)) return
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
  await putIf(await read($, connectionAtom), connection => ({ ...connection, isLeader: rt.isLeader }), fn => update($, connectionAtom, fn))
}

async function stepDown($: EngineInterface, rt: Runtime): Promise<void> {
  rt.isLeader = false
  rt.leaseVerified = false
  rt.pollTimer?.cancel()
  rt.pollTimer = undefined
  await putIf(await read($, connectionAtom), connection => ({ ...connection, isLeader: false }), fn => update($, connectionAtom, fn))
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
  // A beat that came late (a suspended process) may find the lease taken: the new leader polls, never both.
  if (isLeaseTaken(parseLease(await readJsonFile($, paths.lease(rt))), rt.me, now)) return stepDown($, rt)
  let busy = false
  if (now >= rt.backoffUntil) {
    // Who wrote an outgoing row depends on the linked number: never judge rows before that is known.
    if (rt.mode === 'unknown') await checkConnection($, rt)
    // Silent, Night and Interaction as they are now (another session or the phone may have changed them).
    await refreshHub($, rt)
    const files = await readSessionFiles($, rt, SESSION_FILE_FRESH_MS)
    busy = await pollMessages($, rt, files)
    rt.polls += 1
    if (rt.polls % REACTION_EVERY_POLLS === 0) await pollReactions($, rt, files)
    const anyAway = isAway(attention(rt), Math.max(...files.map(file => file.info.lastActiveAt), rt.lastActiveAt), now)
    const anyOpen = files.some(file => file.pending.some(item => item.kind !== 'alert'))
    busy = busy || anyAway || anyOpen || now - rt.lastInboundAt < 5 * 60_000
    await leaderSchedules($, rt, files)
    if (rt.leader !== undefined) await writeJsonFile($, paths.leader(rt), rt.leader)
    await showInbound($, rt, rt.leader)
  }
  if (!rt.isLeader) return
  const targets = rt.scoped ? allowlist(rt).length : 1
  const wait = Math.max(pollInterval({ baseSeconds: rt.settings.pollSeconds, targets, isBusy: busy }), rt.backoffUntil - (await $.clock.now()))
  schedulePoll($, rt, wait)
}

/** The poll interval the pane's health judges by: the slow one (nobody away, nothing open). */
const quietPollMs = (rt: Runtime): number => pollInterval({ baseSeconds: rt.settings.pollSeconds, targets: rt.scoped ? allowlist(rt).length : 1, isBusy: false })

/** The pane's inbound line, from the leader's state (this session's, or the leader's file another session wrote). */
async function showInbound($: EngineInterface, rt: Runtime, leader: Partial<LeaderState> | undefined): Promise<void> {
  const health = inboundHealth({
    now: await $.clock.now(),
    isConfigured: isConfigured(rt),
    lastPollAt: typeof leader?.lastPollAt === 'number' ? leader.lastPollAt : 0,
    lastPollError: typeof leader?.lastPollError === 'string' ? leader.lastPollError : '',
    pollEveryMs: quietPollMs(rt),
  })
  const lastAt = typeof leader?.lastInboundAt === 'number' ? leader.lastInboundAt : 0
  await putIf(await read($, inboundAtom), () => ({ lastAt, ...health }), fn => update($, inboundAtom, fn))
}

/**
 * Reads what is new since the cursor of each target (one global listing, or one per allowlisted chat with a
 * chat-scoped key), oldest first, and handles each row once. Both directions are read: with the owner's own number
 * linked, what they type on the phone (self-chat, project groups) is stored as outgoing (fromMe). OpenWA 0.24 has no
 * `direction` filter anyway (see api.messages).
 */
async function pollMessages($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<boolean> {
  const leader = rt.leader ?? emptyLeader()
  rt.leader = leader
  const targets: (string | undefined)[] = rt.scoped ? allowlist(rt) : [undefined]
  let handled = 0
  for (const chatId of targets) {
    const key = chatId ?? '*'
    const cursor = leader.cursors[key]
    const fresh: WaRow[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await waCall($, rt, api.messages(rt.sessionId, { limit: PAGE_LIMIT, ...(chatId !== undefined ? { chatId } : {}), ...(after !== undefined ? { after } : {}) }))
      if (!result.ok) {
        leader.lastPollError = failure(result)
        if (result.status !== 429) {
          rt.backoffMs = backoff(rt.backoffMs, undefined)
          rt.backoffUntil = (await $.clock.now()) + rt.backoffMs
        }
        leader.lastPollAt = await $.clock.now()
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
  leader.lastPollAt = await $.clock.now()
  leader.lastPollError = ''
  if (handled > 0) rt.lastInboundAt = await $.clock.now()
  return handled > 0
}

/** Whether a row is one the bridge sent itself: its invisible mark, or an id a session recorded at send time. */
const isBotEcho = (rt: Runtime, files: readonly SessionFile[], row: WaRow): boolean =>
  row.body.endsWith(BOT_MARK) || rt.file.sentIds.includes(row.waMessageId) || files.some(file => file.sentIds.includes(row.waMessageId))

/**
 * Who wrote a row. Outgoing (fromMe) rows are the bot's own sends (skipped, by mark or id) or, with the owner's own
 * number linked, the owner typing on the phone. Incoming rows are the owner when the sender's number is theirs: a
 * group's `author`, a DM's `from`; an `@lid` sender is resolved through OpenWA (both engines report privacy ids).
 */
async function senderOf($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow): Promise<'owner' | 'member' | 'bot'> {
  if (row.direction === 'outgoing') {
    if (isBotEcho(rt, files, row)) return 'bot'
    return rt.mode === 'self' ? 'owner' : 'bot'
  }
  const phone = await phoneOfSender($, rt, row.author ?? row.from)
  return isOwnerPhone(phone, rt.owners) ? 'owner' : 'member'
}

/** The phone digits behind a WhatsApp id, an `@lid` resolved through OpenWA (cached); '' when unknown. */
async function phoneOfSender($: EngineInterface, rt: Runtime, waId: string): Promise<string> {
  const id = normalizeJid(waId)
  const phone = phoneOf(id)
  return phone !== '' || !id.endsWith('@lid') ? phone : resolveLid($, rt, id)
}

async function resolveLid($: EngineInterface, rt: Runtime, lid: string): Promise<string> {
  const leader = rt.leader ?? emptyLeader()
  const cached = leader.lidPhones[lid]
  if (cached !== undefined && cached !== '') return cached
  const result = await waCall($, rt, api.contactPhone(rt.sessionId, lid))
  const phone = isRecord(result.json) && typeof result.json.phone === 'string' ? result.json.phone.replace(/\D/g, '') : ''
  // A null answer is "not learned yet" (OpenWA's words): asked again next time, never cached as nobody.
  if (result.ok && phone !== '') leader.lidPhones[lid] = phone
  return phone
}

/**
 * Whether the leader may read a chat: an allowlisted one, or a direct chat that is the owner's under another id (a
 * DM or the self-chat keyed by an `@lid`, as WhatsApp's privacy ids now do). Such a chat is remembered in chats.json
 * (every session's allowlist reads it), so replies and later messages reach it.
 */
async function isReadable($: EngineInterface, rt: Runtime, row: WaRow): Promise<boolean> {
  const chatId = normalizeJid(row.chatId)
  if (isAllowed(rt, chatId)) return true
  if (isGroupChat(chatId) || !chatId.endsWith('@lid')) return false
  // With the owner's own number linked, "Message yourself" is the chat whose id is the sender's own: no lookup needed.
  const isSelfChat = rt.mode === 'self' && row.direction === 'outgoing' && normalizeJid(row.from) === chatId
  const phone = isSelfChat ? '' : await resolveLid($, rt, chatId)
  const isOwners = isSelfChat || isOwnerPhone(phone, rt.owners) || (rt.mode === 'self' && phone !== '' && phone === rt.botPhone)
  if (!isOwners) return false
  const stored = await readJsonFile($, paths.chats(rt))
  const known = isRecord(stored) && Array.isArray(stored.owner) ? stored.owner.filter((one): one is string => typeof one === 'string') : []
  rt.ownerChats = [...new Set([...known, ...rt.ownerChats, chatId])]
  await writeJsonFile($, paths.chats(rt), { owner: rt.ownerChats })
  return true
}

const sentIndex = (files: readonly SessionFile[]): Map<string, string> => {
  const index = new Map<string, string>()
  for (const file of files) for (const id of file.sentIds) index.set(id, file.info.id)
  return index
}

/** Notes one inbound row for `/wa inbox` (the leader's own file): never the text of a chat it may not read. */
async function noteInbound($: EngineInterface, rt: Runtime, row: WaRow, who: WaInboundEvent['who'], verdict: WaInboundEvent['verdict'], reason: string, isRead: boolean): Promise<void> {
  const event: WaInboundEvent = {
    at: await $.clock.now(),
    chat: maskChat(row.chatId, isRead),
    who,
    text: isRead ? oneLine(takePin(row.body.replace(BOT_MARK, ''), rt.settings.pin).text, 60) : '(not read)',
    verdict,
    reason,
  }
  const path = paths.inboundFrom(rt, rt.me || 'unknown')
  const lines = (await readLines($, path)).slice(-(INBOUND_KEEP - 1))
  await writeLines($, path, [...lines, event])
}

/** Handles one new row: allowlist first (anything else is dropped unread), then owner or member. */
async function handleRow($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow): Promise<boolean> {
  if (!(await isReadable($, rt, row))) {
    // The bot's own sends to a chat it may not read cannot happen (sends are allowlisted): skip them silently.
    if (!(row.direction === 'outgoing' && isBotEcho(rt, files, row))) await noteInbound($, rt, row, 'unknown', 'dropped', 'chat not allowlisted (read nothing)', false)
    return false
  }
  const who = await senderOf($, rt, files, row)
  if (who === 'bot') {
    // The bot's own echoes are not logged: they would fill /wa inbox with what the bridge itself said.
    if (!isBotEcho(rt, files, row)) await noteInbound($, rt, row, 'bot', 'dropped', 'sent by the linked bot number', true)
    return false
  }
  const now = await $.clock.now()
  if (rt.leader !== undefined) rt.leader.lastInboundAt = now
  const sessions = files.map(file => file.info)
  const sentBy = sentIndex(files)
  const text = row.body
  if (who === 'member') {
    if (!isGroupChat(row.chatId)) {
      await noteInbound($, rt, row, 'member', 'dropped', 'not the owner, in a direct chat', true)
      return false
    }
    return handleMemberRow($, rt, files, row, now)
  }
  const parsed = parseCommand(text, rt.settings.pin)
  const isTagged = /^\s*[#@][\p{L}\p{N}_.-]/u.test(text)
  // A tag picks a session for status and prompts; every other command is about all sessions anyway.
  const isGlobal = !(isTagged && parsed.command.kind === 'status')
  if (isGlobal && (await handleGlobalCommand($, rt, files, row, parsed.command, parsed.needsPin && !parsed.hasPin))) {
    await noteInbound($, rt, row, 'owner', 'accepted', `command: ${parsed.command.kind}`, true)
    return true
  }
  const kind = parsed.command.kind
  const mayAnswer = !isTagged && row.quotedId === undefined && (kind === 'prompt' || kind === 'approve' || kind === 'reject')
  // An unquoted "2" or "sì" answers the newest open question in this chat, whichever session asked it.
  const waiting = mayAnswer
    ? files
        .flatMap(file => file.pending.filter(item => item.chatId === row.chatId && item.expiresAt > now && item.kind !== 'alert' && item.kind !== 'preview').map(item => ({ item, id: file.info.id })))
        .filter(({ id }) => sessions.some(session => session.id === id && isLive(session, now)))
        .sort((a, b) => b.item.createdAt - a.item.createdAt)[0]
    : undefined
  // A reply to one of the bot's questions or alerts goes to the session that asked it.
  const isReplyToPending = row.quotedId !== undefined && files.some(file => file.pending.some(item => item.messageId === row.quotedId))
  const routed = waiting !== undefined
    ? { sessionId: waiting.id, text, reason: 'reply' as const }
    : route({ chatId: row.chatId, text, now, ...(row.quotedId !== undefined ? { quotedId: row.quotedId } : {}) }, { sessions, sentBy, groups: rt.groups })
  // A question is answered at once, by the leader or the session it is about: no Claude turn, no confirmation.
  const asked = routed.text
  if (waiting === undefined && !isReplyToPending && kind === 'prompt' && row.media === undefined && row.type === 'text' && classifyOwnerText(asked) === 'question') {
    await noteInbound($, rt, row, 'owner', 'accepted', 'question: answered from WhatsApp', true)
    await answerQuestion($, rt, files, { row, text: asked, audience: 'owner', author: row.author ?? row.from, targetId: routed.sessionId })
    return true
  }
  const target = routed.sessionId === null ? undefined : sessions.find(session => session.id === routed.sessionId)
  // In the owner's direct chat, a project that has its own group is steered from that group.
  const targetGroup = target === undefined ? undefined : groupOfSession(rt.groups, target)
  if (target !== undefined && targetGroup !== undefined && !isGroupChat(row.chatId) && routed.reason !== 'reply') {
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'reply', text: `🤖 ${target.project} is steered from its group "${targetGroup.name}": send it there.` })
    await noteInbound($, rt, row, 'owner', 'accepted', `pointed to the group "${targetGroup.name}"`, true)
    return true
  }
  if (routed.sessionId === null) {
    const why =
      routed.reason === 'unknown-tag'
        ? `No live session is tagged ${routed.detail}. Send *sessions* to list them.`
        : routed.reason === 'no-project-session'
          ? `No Claude Code session is running for ${projectNameOf(routed.detail)} right now.`
          : 'No Claude Code session is running right now.'
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'reply', text: `🤖 ${why}` })
    await noteInbound($, rt, row, 'owner', 'accepted', `no session to run it (${routed.reason})`, true)
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
  await noteInbound($, rt, row, 'owner', 'accepted', `${waiting !== undefined || isReplyToPending ? 'answer' : 'request'} → #${sessions.find(one => one.id === routed.sessionId)?.label ?? '?'}`, true)
  return true
}

/**
 * A group member's message: only when meant for Claude (mention, reply, trigger word, bug report), within the limits.
 * Members ask; they never command: a command or a work request gets a one-line refusal and nothing runs.
 */
async function handleMemberRow($: EngineInterface, rt: Runtime, files: SessionFile[], row: WaRow, now: number): Promise<boolean> {
  const sentBy = sentIndex(files)
  const trigger = memberTrigger(row.body, {
    triggers: rt.settings.memberTriggers,
    botPhone: rt.botPhone,
    isReplyToBot: row.quotedId !== undefined && sentBy.has(row.quotedId),
  })
  if (!trigger.isTriggered) {
    await noteInbound($, rt, row, 'member', 'dropped', 'chatter (no "?", mention or reply to the bot)', true)
    return false
  }
  const event: WaEventKey = trigger.isBug ? 'bugReports' : 'memberQuestions'
  if (!rt.prefs.events[event]) {
    await noteInbound($, rt, row, 'member', 'dropped', `${EVENT_LABELS[event]} is switched off`, true)
    return false
  }
  // A bug draft asks the owner for a 👍: an interaction, so only while interaction is on.
  if (trigger.isBug && !canInteract(rt, now)) {
    await noteInbound($, rt, row, 'member', 'dropped', 'bug report while interaction is off', true)
    return false
  }
  const leader = rt.leader ?? emptyLeader()
  const member = row.author ?? row.from
  if (!trigger.isBug && isMemberCommand(trigger.text, parseCommand(trigger.text).command.kind !== 'prompt')) {
    await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'member', audience: 'member', text: '🔒 Only the owner can ask Claude to do things. You can ask questions about the work (start with *?*).' })
    await appendMemberLog($, rt, { at: now, member: memberName(row), question: trigger.text, answer: '', outcome: 'limited' })
    await noteInbound($, rt, row, 'member', 'dropped', 'a command from a member (refused)', true)
    return true
  }
  const quota = takeQuota(leader.book, member, now, dayKey(now), { perTenMinutes: rt.settings.memberRate, dailyCap: rt.settings.memberDailyCap })
  leader.book = quota.book
  if (!quota.isAllowed) {
    await appendMemberLog($, rt, { at: now, member: memberName(row), question: trigger.text, answer: '', outcome: 'limited' })
    await noteInbound($, rt, row, 'member', 'dropped', quota.why ?? 'member limit', true)
    return false
  }
  const key = projectOfChat(rt.groups, row.chatId)
  const target = files
    .map(file => file.info)
    .filter(session => key !== undefined && isSessionOfKey(session, key) && isLive(session, now))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  if (trigger.isBug) {
    if (target === undefined) {
      await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'member', audience: 'member', text: '🤖 Claude is not running for this project right now; the owner will see your message.' })
      await noteInbound($, rt, row, 'member', 'accepted', 'bug report, no session running', true)
      return true
    }
    await deliver($, rt, target.id, { key: `row:${row.id}`, at: now, kind: 'bug', chatId: row.chatId, messageId: row.waMessageId, author: memberName(row), text: trigger.text })
    await noteInbound($, rt, row, 'member', 'accepted', `bug report → #${target.label}`, true)
    return true
  }
  await noteInbound($, rt, row, 'member', 'accepted', 'question: answered from WhatsApp', true)
  await answerQuestion($, rt, files, { row, text: trigger.text, audience: 'member', author: memberName(row), targetId: target?.id ?? null })
  return true
}

const memberName = (row: WaRow): string => {
  const id = row.author ?? row.from
  const phone = phoneOf(id)
  return phone !== '' ? `+${phone.slice(0, -4).replace(/\d/g, '•')}${phone.slice(-4)}` : 'a member'
}

// ── Questions over WhatsApp: answered at once, no Claude turn ────────────────────────────────────

type Question = { row: WaRow; text: string; audience: 'owner' | 'member'; author: string; targetId: string | null }

/** What answering cost today across every session (each session's file keeps its own). */
const qaSpentToday = (files: readonly SessionFile[], rt: Runtime, now: number): number =>
  files.reduce((sum, file) => sum + ((file.info.id === rt.me ? rt.file : file).stats.qaUsdByDay?.[dayKey(now)] ?? 0), 0)

/**
 * A question from the owner or a member: held while interaction is off (one "I'll answer later" per chat), refused
 * past the per-chat rate or the day's cost cap, else answered: by the session it is about when that is another live
 * session (from its own transcript), by the leader otherwise (its transcript when it is that session and idle, else
 * the facts it keeps). Nothing runs; members get the member rules.
 */
async function answerQuestion($: EngineInterface, rt: Runtime, files: SessionFile[], question: Question): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  const { row } = question
  const root = question.targetId !== null ? files.find(file => file.info.id === question.targetId)?.info.root : projectRootOfChat(rt, row.chatId)
  if (!mayReply(rt, now)) {
    leader.parkedQuestions = [...leader.parkedQuestions, { at: now, chatId: row.chatId, messageId: row.waMessageId, text: question.text, audience: question.audience, author: question.author, root }].slice(-PARKED_QUESTIONS_KEEP)
    if (!leader.toldLater.includes(row.chatId)) {
      leader.toldLater = [...leader.toldLater, row.chatId]
      await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'later', audience: question.audience, text: "🌙 Claude isn't answering right now (silent or night mode). I'll answer when interaction is back on." })
    }
    return
  }
  const quota = takeQa(leader.qa, row.chatId, now, { perTenMinutes: rt.settings.qaRate, dailyUsd: rt.settings.qaDailyUsd, spentToday: qaSpentToday(files, rt, now) })
  leader.qa = quota.book
  if (!quota.isAllowed) {
    if (question.audience === 'owner') await waSendText($, rt, { chatId: row.chatId, quotedId: row.waMessageId, kind: 'reply', text: `⏳ Not answered: ${quota.why ?? 'limit reached'}.` })
    else await appendMemberLog($, rt, { at: now, member: question.author, question: question.text, answer: '', outcome: 'limited' })
    return
  }
  const target = question.targetId === null ? undefined : files.find(file => file.info.id === question.targetId)?.info
  if (target !== undefined && target.id !== rt.me && isLive(target, now)) {
    await deliver($, rt, target.id, { key: `row:${row.id}`, at: now, kind: 'question', audience: question.audience, chatId: row.chatId, messageId: row.waMessageId, author: question.author, text: question.text })
    return
  }
  await appendLog($, rt, { dir: 'in', chatId: row.chatId, kind: 'question', text: question.text, messageId: row.waMessageId, who: question.audience })
  const info = target ?? newestSessionOf(files, root)
  await replyToQuestion($, rt, { chatId: row.chatId, messageId: row.waMessageId, text: question.text, audience: question.audience, author: question.author }, info, now)
}

/** The project root a chat stands for: its group's, or (the owner's chat) this session's. */
const projectRootOfChat = (rt: Runtime, chatId: string): string | undefined => {
  const key = projectOfChat(rt.groups, chatId)
  return key === undefined ? undefined : parseGroupKey(key).root
}

/** The most recently active session of a project (or of any project), live or not: what a question is about. */
const newestSessionOf = (files: readonly SessionFile[], root: string | undefined): WaSessionInfo | undefined =>
  files
    .map(file => file.info)
    .filter(info => root === undefined || info.root === root)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]

/**
 * Answers one question here: a fork of this session's transcript when the question is about this session and no
 * turn runs, else one short completion from the facts (status, last answer, git, the hub's recent events). Records
 * the estimated cost for the daily cap, and the member log for a member.
 */
async function replyToQuestion(
  $: EngineInterface,
  rt: Runtime,
  question: { chatId: string; messageId: string; text: string; audience: 'owner' | 'member'; author: string },
  info: WaSessionInfo | undefined,
  now: number,
): Promise<void> {
  const context = await questionContext($, rt, info, question.audience, now)
  const prompt = qaPrompt(question.text, context, question.audience, rt.settings.shareCodeWithMembers)
  let answer = ''
  let usage: Usage | undefined
  if (info?.id === rt.me && rt.state === 'idle') {
    const forked = await $.model.fork({ prompt }).catch(() => undefined)
    if (forked?.isAnswered === true) {
      answer = forked.text
      usage = forked.usage
    }
  }
  if (answer === '') {
    const done = await $.model.complete({ model: 'haiku', prompt, maxTokens: 300, timeoutMs: 30_000 }).catch(() => undefined)
    if (done?.isAnswered === true) {
      answer = done.text
      usage = done.usage
    }
  }
  if (usage !== undefined) {
    const day = dayKey(now)
    const byDay = rt.file.stats.qaUsdByDay ?? {}
    rt.file.stats.qaUsdByDay = { [day]: (byDay[day] ?? 0) + estimateUsd(usage) }
    await saveSelf($, rt)
  }
  const isMember = question.audience === 'member'
  const text = answer === '' ? '🤖 I could not answer right now.' : `🤖 ${clean(answer, { audience: question.audience, maxChars: isMember ? 700 : 900, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text}`
  await waSendText($, rt, { chatId: question.chatId, quotedId: question.messageId, kind: isMember ? 'member' : 'answer', audience: question.audience, text })
  if (isMember) await appendMemberLog($, rt, { at: now, member: question.author, question: question.text, answer: text, outcome: answer === '' ? 'failed' : 'answered' })
}

/** The facts a question is answered from. Git and the hub are asked with short timeouts; any of them may be missing. */
async function questionContext($: EngineInterface, rt: Runtime, info: WaSessionInfo | undefined, audience: 'owner' | 'member', now: number): Promise<QaContext> {
  const root = info?.root ?? rt.root
  const isThis = info === undefined || info.id === rt.me
  const git = async (argv: string[]): Promise<string> => {
    const ran = root === '' ? undefined : await $.process.run(['git', ...argv], { cwd: root, timeoutMs: 5_000 }).catch(() => undefined)
    return ran?.exitCode === 0 ? ran.stdout.trim() : ''
  }
  const status = await git(['status', '--short'])
  const events: string[] = []
  if (rt.hub !== undefined) {
    const recent = await $.mods.recent({ limit: 12 }).catch(() => [] as ModsEvent[])
    for (const event of recent) if (!event.topic.startsWith('channel.')) events.push(`${event.topic} from ${event.source}${typeof (event.data as { outcome?: unknown } | null)?.outcome === 'string' ? ` (${String((event.data as { outcome: string }).outcome)})` : ''}`)
  }
  return {
    project: info?.project ?? rt.project,
    label: info?.label ?? rt.label,
    branch: info?.branch ?? rt.branch,
    state: info === undefined || (!isThis && !isLive(info, now)) ? (isThis ? rt.state : 'offline') : isThis ? rt.state : info.state,
    task: info?.task ?? rt.task,
    summary: audience === 'owner' ? (info?.summary ?? '') : clean(info?.summary ?? '', { audience: 'member', maxChars: 300, root, shareCode: false }).text,
    changes: status === '' ? [] : status.split('\n').map(line => line.trim()).filter(line => line !== ''),
    lastCommit: await git(['log', '-1', '--format=%s']),
    events,
  }
}

/** One inbox line and the leader that wrote it ('' for the older single inbox file). */
type Posted = { writer: string; entry: InboxEntry }

/**
 * A session's inbox: one file per leader that delivered to it (`inbox/<id>/<leader>.jsonl`, one writer per file, so two
 * leaders overlapping during a takeover never overwrite each other's lines), and the older single file.
 */
async function readInbox($: EngineInterface, rt: Runtime, sessionId: string): Promise<Posted[]> {
  const lines = async (path: string): Promise<InboxEntry[]> => (await readLines($, path)).filter(isRecord) as unknown as InboxEntry[]
  const posted: Posted[] = (await lines(paths.inbox(rt, sessionId))).map(entry => ({ writer: '', entry }))
  for (const file of await $.fs.list(paths.inboxDir(rt, sessionId)).catch(() => [])) {
    if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
    const writer = file.name.slice(0, -'.jsonl'.length)
    posted.push(...(await lines(paths.inboxFrom(rt, sessionId, writer))).map(entry => ({ writer, entry })))
  }
  return posted
}

/** How far a session consumed a leader's inbox file, from its done file (`from`; `seq` for the older single file). */
const consumedOf = (done: unknown, writer: string): number => {
  if (!isRecord(done)) return 0
  const value = writer === '' ? done.seq : isRecord(done.from) ? done.from[writer] : undefined
  return typeof value === 'number' ? value : 0
}

/** Appends one entry to a session's inbox, in this leader's own file, trimming what that session has consumed of it. */
async function deliver($: EngineInterface, rt: Runtime, sessionId: string, entry: Omit<InboxEntry, 'seq'>): Promise<void> {
  const posted = await readInbox($, rt, sessionId)
  if (posted.some(one => one.entry.key === entry.key)) return
  const consumed = consumedOf(await readJsonFile($, paths.done(rt, sessionId)), rt.me)
  const mine = posted.filter(one => one.writer === rt.me).map(one => one.entry)
  const seq = Math.max(consumed, ...mine.map(line => line.seq)) + 1
  await writeLines($, paths.inboxFrom(rt, sessionId, rt.me), [...mine.filter(line => line.seq > consumed), { ...entry, seq }])
  if (sessionId === rt.me) void consumeInbox($, rt)
}

/** Reactions on the questions and alerts sessions wait on: the owner's 👍 ❌ ⏸ 🔁 go to that session. */
async function pollReactions($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const now = await $.clock.now()
  // One read per chat with something open: OpenWA 0.24 cannot fetch one message by id (no `messageId` filter).
  const pages = new Map<string, WaRow[]>()
  for (const file of files) {
    for (const item of file.pending.filter(one => one.expiresAt > now && one.messageId !== '').slice(-6)) {
      if (!isAllowed(rt, item.chatId)) continue
      if (!pages.has(item.chatId)) pages.set(item.chatId, parseRows((await waCall($, rt, api.messages(rt.sessionId, { chatId: item.chatId, limit: PAGE_LIMIT }))).json))
      const row = pages.get(item.chatId)?.find(one => one.waMessageId === item.messageId)
      if (row === undefined) continue
      for (const [reactor, emoji] of Object.entries(row.reactions)) {
        const key = `reaction:${item.messageId}:${reactor}:${emoji}`
        if (leader.seen.includes(key)) continue
        leader.seen = remember(leader.seen, [key])
        const phone = await phoneOfSender($, rt, reactor)
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
  const live = files.map(file => file.info).filter(session => isLive(session, now) && (groupRoot === undefined || isSessionOfKey(session, groupRoot)))
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
  if (leader.parkedQuestions.length > 0 && mayReply(rt, now)) await answerParkedQuestions($, rt, files)
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

/** Interaction is back on: the questions that came in meanwhile are answered now, and chats may be told "later" again. */
async function answerParkedQuestions($: EngineInterface, rt: Runtime, files: SessionFile[]): Promise<void> {
  const leader = rt.leader ?? emptyLeader()
  const parked = leader.parkedQuestions
  leader.parkedQuestions = []
  leader.toldLater = []
  const now = await $.clock.now()
  for (const one of parked) {
    await replyToQuestion($, rt, { chatId: one.chatId, messageId: one.messageId, text: one.text, audience: one.audience, author: one.author }, newestSessionOf(files, one.root), now)
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
    const posted = (await readInbox($, rt, rt.me)).sort((a, b) => a.entry.at - b.entry.at || a.entry.seq - b.entry.seq)
    for (const { writer, entry } of posted) {
      // Each leader's file is consumed in its own order; a line two leaders both delivered is handled once (by key).
      const isSeen = rt.doneIds.includes(entry.key)
      if (writer === '' ? isSeen : entry.seq <= (rt.doneFrom[writer] ?? 0)) continue
      if (writer === '') rt.doneSeq = Math.max(rt.doneSeq, entry.seq)
      else rt.doneFrom = { ...rt.doneFrom, [writer]: entry.seq }
      if (!isSeen) rt.doneIds = [...rt.doneIds, entry.key].slice(-DONE_KEEP)
      await writeJsonFile($, paths.done(rt, rt.me), { seq: rt.doneSeq, ids: rt.doneIds, from: rt.doneFrom })
      if (isSeen) continue
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
  const who = entry.kind === 'member' || entry.kind === 'bug' || entry.audience === 'member' ? 'member' : 'owner'
  // The PIN that unlocks "/compact 1234" is a secret: never in the log, the panel or the hub's bus.
  const shown = who === 'owner' ? takePin(entry.text, rt.settings.pin).text : entry.text
  await appendLog($, rt, { dir: 'in', chatId: entry.chatId, kind: entry.kind, text: entry.emoji ?? shown, messageId: entry.messageId, who })
  await publishInbound($, rt, { ...entry, text: shown }, who)
  switch (entry.kind) {
    case 'reaction':
      return handleReaction($, rt, entry)
    case 'member':
    case 'question':
      // From a timer of its own: the inbox is also read while `ask` waits inside a tool call, and a model call
      // must not run on that hook's budget.
      answerLater($, rt, { chatId: entry.chatId, messageId: entry.messageId, text: entry.text, audience: entry.kind === 'member' ? 'member' : who, author: entry.author })
      return
    case 'bug':
      return draftBug($, rt, entry)
    case 'owner':
      return handleOwner($, rt, entry)
  }
}

function answerLater($: EngineInterface, rt: Runtime, question: { chatId: string; messageId: string; text: string; audience: 'owner' | 'member'; author: string }): void {
  $.clock.after(0, () => {
    void $.clock
      .now()
      .then(now => replyToQuestion($, rt, question, rt.file.info, now))
      .catch(error => $.ui.log(`${NAME}: could not answer a WhatsApp question: ${messageOf(error)}`, { to: 'debug' }))
  })
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
      scheduleDrain($, rt)
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
  if (!mayReply(rt, now)) {
    await waSendText($, rt, replyTo(entry, '🌙 Interaction is off right now (silent or night). Send *interact on* first, then your request again.'))
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
      scheduleDrain($, rt)
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
  scheduleDrain($, rt)
}

/**
 * Submits the next phone prompt from a timer of its own, never inside the hook or command that queued it: a prompt
 * submitted from within a hook (a tool call waiting on `ask`, a command) would run inside that hook's budget.
 */
function scheduleDrain($: EngineInterface, rt: Runtime): void {
  $.clock.after(0, () => void drainPhoneQueue($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })))
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
      await waSendText($, rt, { chatId: item.chatId, quotedId: item.messageId, kind: 'reply', text: `⚙️ Working on it (#${rt.label}). I'll post the result here when it is done.` })
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
    scheduleDrain($, rt)
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
  // The chat's newest rows with their media, the one by id among them (OpenWA 0.24 has no `messageId` filter).
  const result = await waCall($, rt, api.messages(rt.sessionId, { chatId: entry.chatId, limit: 20, inlineMedia: true }))
  const data = parseRows(result.json).find(row => row.waMessageId === entry.messageId)?.media?.data ?? ''
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

/** The member Q&A of every session: one log per writer, and the older shared file; oldest first. */
async function readMemberLogs($: EngineInterface, rt: Runtime): Promise<Record<string, unknown>[]> {
  const rows = (await readLines($, paths.members(rt))).filter(isRecord)
  for (const file of await $.fs.list(paths.memberLogs(rt)).catch(() => [])) {
    if (file.kind === 'file' && file.name.endsWith('.jsonl')) rows.push(...(await readLines($, `${paths.memberLogs(rt)}/${file.name}`)).filter(isRecord))
  }
  return rows.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
}

async function appendMemberLog($: EngineInterface, rt: Runtime, qa: WaMemberQa): Promise<void> {
  // One writer per file: the leader (limits) and every answering session append to their own log.
  const path = `${paths.memberLogs(rt)}/${rt.me || 'unknown'}.jsonl`
  const lines = (await readLines($, path)).slice(-99)
  await writeLines($, path, [...lines, qa])
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
      "Send a short WhatsApp message to the user's phone when a long job finished or failed or needs attention while they are away; never for routine progress. priority: critical (now), normal (default), info (batched into a digest). attachPath: optional project file. The result says if it was held.",
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
      'Ask the user a question on WhatsApp and wait for the answer (timeoutMinutes, default 10). Only when blocked on a decision only they can make. options (2-12) are numbered. If interaction is off it returns at once: proceed on your best judgement and state the assumption.',
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
      'Send a file from this project (screenshot, chart, PDF, log) to the user on WhatsApp with a caption. Only when asked or when it is the result awaited; never source files or diffs unasked.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, caption: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'open_panel',
    description:
      'Open the WhatsApp panel.',
    inputSchema: { type: 'object' },
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

/** Registers Claude's tools once the bridge is set up (a token and a destination); until then they would only cost prompt tokens. */
async function offerTools($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.areToolsOffered || !isConfigured(rt)) return
  rt.areToolsOffered = true
  await registerTools($)
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
  return messageId === '' ? 'Not sent: OpenWA refused it (see /wa, Log).' : `Sent ${real.split(/[\\/]/).at(-1) ?? 'the file'} to the user's WhatsApp.`
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
  if (e.answer.trim() !== '') rt.file.info.summary = clean(oneLine(e.answer, 600), { audience: 'owner', maxChars: 600, root: rt.root }).text
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
  // Released only while it still names this session: a session that lost the lease must not clear the new leader's.
  if (rt.isLeader && parseLease(await readJsonFile($, paths.lease(rt)))?.sessionId === rt.me) await writeJsonFile($, paths.lease(rt), { sessionId: '', heartbeatAt: 0, since: 0 })
  if (rt.turns > 0 && isConfigured(rt) && rt.prefs.events.sessionEnd) {
    const messages = await $.session.messages().catch(() => [])
    const list = Array.isArray(messages) ? messages : []
    const edits = new Set(list.flatMap(message => message.toolUses).filter(use => use.tool === 'Edit' || use.tool === 'Write').map(use => String(use.input.file_path ?? '')))
    const last = [...list].reverse().find(message => message.role === 'assistant' && message.text.trim() !== '')
    await toDigest($, rt, `🏁 session ended: ${rt.turns} prompts, ${plural(edits.size, 'file')} edited, $${rt.costUsd.toFixed(2)}${last !== undefined ? ` — ${oneLine(last.text, 160)}` : ''}`)
  }
  await saveSelf($, rt)
  // The managed server keeps running for the other sessions; this one only stops vouching for it.
  await releaseLock($, rt)
  stopSetupTicks(rt)
  for (const timer of rt.timers) timer.cancel()
}

// ── mods-hub: one presence, one quiet, one notification router for every channel ──────────────────

/** The hub's global mode, re-read (another session or the phone may have changed it); unchanged without the hub. */
async function refreshHub($: EngineInterface, rt: Runtime): Promise<void> {
  const mode = await hubMode($)
  // A hub installed (or loaded) after this session started is greeted once it answers.
  if (mode !== undefined && rt.hub === undefined && rt.isBackgroundStarted && !rt.isHubGreeted) await greetHub($, rt)
  rt.hub = mode
}

type AttentionChange = { presence: 'away' | 'here' | 'auto' } | { interaction: 'on' | 'off' | 'auto' } | { night: boolean }

/**
 * With mods-hub installed, presence, interaction and night are the hub's (every session, every channel): a change
 * from /wa, the panel or the phone goes there. Undefined without the hub, and the bridge changes its own prefs.
 */
async function changeOnHub($: EngineInterface, rt: Runtime, change: AttentionChange, reason: 'manual' | 'channel'): Promise<HubMode | undefined> {
  // Asked live, not from this session's copy: the pane draws the hub's mode when the hub answers, so a change made
  // here must go to the hub then too (a stale copy sent it to the bridge's own prefs, and the button never moved).
  rt.hub = await hubMode($)
  if (rt.hub === undefined) return undefined
  try {
    if ('presence' in change) rt.hub = await $.mods.setPresence({ presence: change.presence, reason })
    else if ('interaction' in change) rt.hub = await $.mods.setMode({ interaction: change.interaction })
    else rt.hub = await $.mods.setMode({ isNightOn: change.night })
    await refreshAttention($, rt)
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
  if (rt.hub === undefined || rt.isHubGreeted) return
  rt.isHubGreeted = true
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

/**
 * The hub's notifications waiting for this channel: each goes out by its level (the hub judged presence and night).
 * At least once: the cursor acknowledges only notices sent, held for the digest or dropped on purpose (paused, off),
 * so one whose send failed (OpenWA down) or that a crash interrupted comes back on the next drain; ids already handled
 * are skipped. After HUB_MAX_TRIES failed sends a notice is given up, so it cannot hold back the ones behind it.
 */
async function drainHub($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.hub === undefined || !isConfigured(rt) || rt.isDraining) return
  rt.isDraining = true
  try {
    for (const notice of await $.mods.drain({ channel: CHANNEL, after: rt.hubCursor })) {
      if (!rt.hubHandled.includes(notice.id)) {
        const outcome = await emit($, rt, { text: hubNoticeText(notice), priority: HUB_PRIORITY[notice.level] ?? 'normal', kind: 'hub', isRouted: true })
        if (outcome.isFailed === true) {
          rt.hubFailures += 1
          if (rt.hubFailures < HUB_MAX_TRIES) return
        }
        rt.hubHandled = [...rt.hubHandled, notice.id].slice(-SENT_KEEP)
      }
      rt.hubFailures = 0
      rt.hubCursor = notice.id
    }
  } finally {
    rt.isDraining = false
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
  rt.project = projectNameOf(rt.root)
  const repo = await $.session.repo().catch(() => null)
  const branch = repo !== null ? await $.process.run(['git', 'branch', '--show-current'], { cwd: repo.root, timeoutMs: 5_000 }).catch(() => undefined) : undefined
  rt.branch = branch?.exitCode === 0 ? branch.stdout.trim() : ''
  rt.isInteractive = isInteractive
  rt.startedAt = await $.clock.now()
  rt.lastActiveAt = rt.startedAt
  await loadShared($, rt)
  await offerTools($, rt)
  const others = (await readSessionFiles($, rt, LIVE_MS)).filter(file => file.info.id !== rt.me && isLive(file.info, rt.startedAt))
  const kept = asSessionFile(await readJsonFile($, paths.session(rt, rt.me)))
  // A label older versions derived from a whole Windows path ("c-users-alexg-onedrive--") is derived again.
  const keptLabel = kept !== null && !isPathLabel(kept.info.label, rt.root) ? kept.info.label : ''
  rt.label = keptLabel || defaultLabel(rt.project, rt.branch, others.map(file => file.info.label))
  if (kept !== null) rt.file = { ...kept, info: { ...kept.info, label: rt.label, ended: false } }
  const done = await readJsonFile($, paths.done(rt, rt.me))
  if (isRecord(done)) {
    rt.doneSeq = typeof done.seq === 'number' ? done.seq : 0
    rt.doneIds = Array.isArray(done.ids) ? done.ids.map(String) : []
    rt.doneFrom = isRecord(done.from) ? Object.fromEntries(Object.entries(done.from).filter((pair): pair is [string, number] => typeof pair[1] === 'number')) : {}
  }
  await saveSelf($, rt)
  rt.isStarted = true
  await refreshPane($, rt)
  if (isConfigured(rt)) void checkConnection($, rt).then(connection => (isSettling(EMPTY_SETUP, connection) ? ensureSetupTicks($, rt) : undefined)).catch(() => undefined)
  // The desktop app (and an IDE or phone host) runs its sessions through the SDK: `isInteractive` is false there, yet a
  // person uses it all day. Such a session draws on a surface; a plain `claude -p` run draws on none and stays quiet.
  const surfaces = await $.session.surfaces().catch(() => [] as readonly RenderSurface[])
  if (isInteractive || surfaces.length > 0) await startBackground($, rt)
}

/**
 * The background work of a session someone uses: the heartbeat, the inbox, screenshots, the hub, and the lease (so
 * one such session polls WhatsApp for all). Once per load: from start-up, or when a surface attaches later.
 */
async function startBackground($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isBackgroundStarted || !rt.isStarted) return
  rt.isBackgroundStarted = true
  rt.isHosted = true
  // "Start automatically" is the user's own opt-in; without it nothing starts unless they press Start.
  if (rt.config.autoStart === true) inBackground($, rt, async () => (await autoStart($, rt), ''))
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
  await offerTools($, rt)
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
  await refreshGroupCard($, rt, '')
  await tickLease($, rt)
  await watchServer($, rt)
  await refreshHub($, rt)
  await syncChannel($, rt)
  await readBus($, rt)
  if (!rt.isLeader) await showInbound($, rt, isRecord(leader) ? (leader as Partial<LeaderState>) : undefined)
  await refreshAttention($, rt)
  if (rt.isPaneOpen || (rt.hub !== undefined && (await hubTabIs($, TAB.id)))) await refreshPane($, rt)
  if (rt.state === 'idle' && (rt.phoneQueue.length > 0 || rt.lateAnswers.length > 0)) scheduleDrain($, rt)
}

/**
 * The background health check, on the heartbeat: while the pane shows or the bridge is set up, at most every 60 s
 * when OpenWA answers and backing off (5 s doubling to 60 s) while it does not. Never while the setup's ticks run.
 * The session that started the managed server keeps its lock fresh, so no other session starts a second one.
 */
async function watchServer($: EngineInterface, rt: Runtime): Promise<void> {
  const lock = await readLock($, rt)
  if (lock?.owner === rt.me && !rt.isStartingServer) await holdLock($, rt, lock.phase)
  if (rt.setupTimer !== undefined || rt.isStartingServer) return
  const isWatched = rt.isPaneOpen || isConfigured(rt) || (rt.hub !== undefined && (await hubTabIs($, TAB.id)))
  if (!isWatched || (await $.clock.now()) < rt.nextCheckAt) return
  const connection = await checkConnection($, rt)
  if (isSettling(await read($, setupAtom), connection)) ensureSetupTicks($, rt)
}

/**
 * Fills the pane's atoms from the shared files, writing only what changed (see `put`): what a session file changes on
 * every heartbeat (when it was last seen, its cost) is left out of what the pane draws.
 */
async function refreshPane($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  const files = await readSessionFiles($, rt, LIVE_MS * 2)
  const live = files.map(file => file.info).filter(info => isLive(info, now)).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  rt.lastSessions = live
  await putIf(await read($, sessionsAtom), () => live.map(info => ({ ...info, lastSeen: 0, lastActiveAt: 0, costUsd: 0, turns: 0, summary: '' })), fn => update($, sessionsAtom, fn))
  const logs: WaLogEntry[] = []
  for (const file of files) logs.push(...((await readLines($, paths.log(rt, file.info.id))).filter(isRecord) as unknown as WaLogEntry[]))
  logs.sort((a, b) => a.at - b.at)
  await putIf(await read($, conversationAtom), () => logs.filter(entry => entry.dir === 'in' || entry.dir === 'out').slice(-30), fn => update($, conversationAtom, fn))
  const own = (await readLines($, paths.log(rt, rt.me))).filter(isRecord).slice(-40) as unknown as WaLogEntry[]
  await putIf(await read($, auditAtom), () => own, fn => update($, auditAtom, fn))
  const members = (await readMemberLogs($, rt)) as unknown as WaMemberQa[]
  await putIf(await read($, membersAtom), () => members.slice(-20), fn => update($, membersAtom, fn))
  await putIf(await read($, privacyAtom), privacy => ({ ...privacy, allowlist: allowlist(rt) }), fn => update($, privacyAtom, fn))
  await refreshGroupCard($, rt, '')
}

/**
 * The quick actions' one source of truth: mods-hub's mode when the hub answers, else the bridge's own prefs. Called
 * on the heartbeat and right after every change, so a press shows at once and a tick redraws only a real change.
 */
async function refreshAttention($: EngineInterface, rt: Runtime): Promise<WaAttention> {
  const now = await $.clock.now()
  const hub = await hubMode($)
  rt.hub = hub
  const prefs = rt.prefs
  const next: WaAttention =
    hub === undefined
      ? {
          canAsk: interactionAllowed(prefs, rt.settings.interactionOffHours, now),
          isAway: prefs.presence === 'away',
          isNight: prefs.interaction === 'night' && now < prefs.nightUntil,
          isPaused: prefs.paused,
          interaction: prefs.interaction,
          quietHours: prefs.quietHours,
          label: interactionLabel(prefs, rt.settings.interactionOffHours, now),
          isHub: false,
        }
      : { canAsk: hub.canAsk, isAway: hub.presence === 'away', isNight: hub.isNight, isPaused: prefs.paused, interaction: hub.interaction, quietHours: hub.quietHours, label: hubModeLabel(hub), isHub: true }
  return putIf(await read($, attentionAtom), () => next, fn => update($, attentionAtom, fn))
}

/** Whether the Interaction switch reads ON: allowed now, or set to on (mods-hub's night may hold it until morning). */
const isInteractionOn = (attention: WaAttention, interaction: string): boolean => attention.canAsk || interaction === 'on'

// ── /wa ──────────────────────────────────────────────────────────────────────────────────────────

const WA_USAGE = [
  '/wa — open the WhatsApp panel',
  '/wa setup — check OpenWA and walk through what is missing',
  '/wa start · /wa stop — run OpenWA in Docker on this machine (or stop it) · /wa qr — print the linking QR',
  '/wa url <http://host:port/api> — use your own OpenWA · /wa autostart on | off',
  '/wa owner <+number> · /wa session <name|id> · /wa key <key> · /wa pair <+number>',
  '/wa groups · /wa group create [name] · /wa group rename|link|invite|unlink|leave <n> … — WhatsApp groups',
  '/wa link-project [n] · /wa unlink-project — link an existing group to this project',
  '/wa inbox — the last inbound messages and what happened to each',
  '/wa away | here | auto · /wa pause | resume',
  '/wa interact on | off | auto · /wa night · /wa silent',
  '/wa label <name> · /wa test · /wa digest · /wa report · /wa status',
].join('\n')

/** The Channels tab of the hub's panel when the hub is installed, the bridge's own pane otherwise. */
async function openPane($: EngineInterface, rt: Runtime): Promise<void> {
  await refreshPane($, rt)
  // A first look when the pane opens (the backoff still holds while nothing answers).
  if ((await $.clock.now()) >= rt.nextCheckAt && rt.setupTimer === undefined) {
    const connection = await checkConnection($, rt)
    if (isSettling(await read($, setupAtom), connection)) ensureSetupTicks($, rt)
  }
  if (rt.hub !== undefined && (await hubShowTab($, TAB.id))) return
  rt.isPaneOpen = true
  await $.ui.open({ id: PANE, title: 'WhatsApp', columns: PANE_COLUMNS })
}

/** `/wa setup`: health, key, session, link, owner — and the exact next step for whatever is missing. */
async function runSetup($: EngineInterface, rt: Runtime): Promise<string> {
  await loadShared($, rt)
  const connection = await checkConnection($, rt)
  const lines: string[] = []
  switch (connection.phase) {
    case 'unreachable':
      return endpointOf(rt.baseUrl).isLocal
        ? [
            `${connection.detail} at ${rt.baseUrl}.`,
            'Easiest: open /wa and press "Start OpenWA" (or run /wa start). The mod runs OpenWA in Docker on 127.0.0.1,',
            'creates its WhatsApp session and a scoped key, and shows the QR to link your phone. It needs Docker Desktop.',
            '',
            'Running OpenWA yourself instead:',
            dockerSteps(rt.baseUrl),
          ].join('\n')
        : `${connection.detail} at ${rt.baseUrl}: start it on that host (or /wa url to change it).\n${connection.raw}`
    case 'no-key':
    case 'admin-key':
    case 'no-session':
      if (rt.config.managed === true && connection.phase !== 'admin-key') {
        inBackground($, rt, () => provision($, rt))
        return 'OpenWA is running: creating its WhatsApp session and a scoped key now. Open /wa for the QR.'
      }
      return `${connection.detail}\n\n${keySteps(connection.phase === 'no-session' ? '' : rt.sessionId)}`
    case 'qr':
      lines.push('WhatsApp is waiting to be linked: open /wa for the QR (or /wa qr prints it here), or link with a code: /wa pair <your bot number>.')
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
      return runSetup($, rt)
    case 'start':
      inBackground($, rt, () => startServer($, rt))
      return `Starting OpenWA in Docker on ${rt.baseUrl} (the first time downloads about 1 GB). Watch /wa for the QR.`
    case 'stop':
      return stopServer($, rt)
    case 'qr': {
      const connection = await checkConnection($, rt)
      if (connection.phase !== 'qr') return connection.phase === 'ready' ? `Already linked: ${connection.detail}` : `No QR now: ${connection.detail}`
      if (connection.qrModules.length === 0) return `The QR could not be drawn here: open ${dashboardOf(rt.baseUrl)} to scan it.`
      return ['Scan with WhatsApp › Linked devices › Link a device (it changes every ~20 s: /wa qr again if it expired):', '', ...qrBlocks(connection.qrModules, { quiet: 2, ink: 'light' })].join('\n')
    }
    case 'url':
      return arg === '' ? `OpenWA URL: ${rt.baseUrl}. Usage: /wa url http://127.0.0.1:2785/api` : saveBaseUrl($, rt, arg)
    case 'autostart': {
      if (arg !== 'on' && arg !== 'off') return `Start automatically is ${rt.config.autoStart === true ? 'on' : 'off'}. Usage: /wa autostart on | off`
      await saveConfig($, rt, { autoStart: arg === 'on' })
      return arg === 'on' ? 'OpenWA will be started in Docker when a session starts and nothing answers.' : 'OpenWA starts only when you press Start.'
    }
    case 'help':
      return WA_USAGE
    case 'inbox':
      return inboxText(await readInboundEvents($, rt), clockTime)
    case 'groups':
      return managedGroupsText(rt)
    case 'group':
      return runGroup($, rt, arg)
    case 'status':
      return `${(await read($, connectionAtom)).detail}\nInteraction: ${interactionText(rt, now)} · presence ${rt.hub?.presence ?? rt.prefs.presence} · ${rt.prefs.paused ? 'paused' : 'notifying'} · ${rt.isLeader ? 'this session polls' : 'another session polls'}`
    case 'owner': {
      const number = canonicalOwner(arg)
      if (number.length < 6) return 'Usage: /wa owner +39333…  (your own WhatsApp number, with country code)'
      await saveConfig($, rt, { ownerNumbers: [...new Set([...(rt.config.ownerNumbers ?? []), number])] })
      const warning = number.startsWith('0') ? ' It starts with 0: add your country code instead (+39…, +44…), or messages to you cannot be sent.' : ''
      return `Owner set: +${number}. Only this number can command Claude from WhatsApp.${warning}`
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
      return unlinkGroup($, rt, '', false)
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
      if (arg === 'off') {
        if ((await changeOnHub($, rt, { night: false }, 'manual')) !== undefined) return 'Night mode off in mods-hub.'
        await savePrefs($, rt, prefs => ({ ...prefs, interaction: 'auto', nightUntil: 0 }))
        return `Night mode off. Interaction: ${interactionLabel(rt.prefs, rt.settings.interactionOffHours, now)}.`
      }
      const onHub = await changeOnHub($, rt, { night: true }, 'manual')
      if (onHub !== undefined) return `Night mode on in mods-hub (quiet hours ${onHub.quietHours}): no questions then, only critical messages; the rest waits for the morning digest.`
      const until = windowEnd(rt.settings.interactionOffHours, now)
      await savePrefs($, rt, prefs => ({ ...prefs, interaction: 'night', nightUntil: until }))
      return `Night mode until ${clockTime(until)}: no questions, only the updates you enabled.`
    }
    case 'label': {
      const label = slugLabel(arg.replace(/^#/, ''))
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

/** The inbound events every leader noted (one file each), newest last, the last five. */
async function readInboundEvents($: EngineInterface, rt: Runtime): Promise<WaInboundEvent[]> {
  const events: WaInboundEvent[] = []
  for (const file of await $.fs.list(paths.inbound(rt)).catch(() => [])) {
    if (file.kind === 'file' && file.name.endsWith('.jsonl')) events.push(...((await readLines($, `${paths.inbound(rt)}/${file.name}`)).filter(isRecord) as unknown as WaInboundEvent[]))
  }
  return events.sort((a, b) => a.at - b.at).slice(-5)
}

/** `/wa group <verb> …`: create, rename, link (here), invite, unlink, leave; `<n>` from /wa groups, this session's group by default. */
async function runGroup($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const tail = rest.join(' ').trim()
  const numbered = /^(\d+)\s*(.*)$/.exec(tail)
  const ref = numbered?.[1] ?? ''
  const more = numbered !== null ? (numbered[2] ?? '').trim() : tail
  switch (verb.toLowerCase()) {
    case 'create':
      return createGroup($, rt, tail)
    case 'rename':
      return renameGroup($, rt, ref, more)
    case 'link':
    case 'relink':
      return relinkGroup($, rt, ref)
    case 'invite':
      return inviteToGroup($, rt, ref, more)
    case 'unlink':
      return unlinkGroup($, rt, ref, false)
    case 'leave':
      return unlinkGroup($, rt, ref, true)
    default:
      return `${managedGroupsText(rt)}\n\nUsage: /wa group create [name] · rename [n] <name> · link [n] · invite [n] <+numbers> · unlink [n] · leave [n]`
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

const INBOUND_LOOK: Record<WaInbound['health'], { glyph: string; color: string }> = {
  ok: { glyph: '●', color: 'success' },
  idle: { glyph: '○', color: 'warning' },
  error: { glyph: '⚠', color: 'error' },
  none: { glyph: '○', color: 'inactive' },
}
const GROUP_LOOK: Record<WaGroupRow['status'], { glyph: string; color: string; text: string }> = {
  this: { glyph: '●', color: 'success', text: 'this session' },
  live: { glyph: '●', color: 'suggestion', text: 'live' },
  idle: { glyph: '○', color: 'inactive', text: 'no session' },
}

const DIR_GLYPH: Record<WaLogEntry['dir'], string> = { in: '↘', out: '↗', held: '⏸', drop: '✕', note: '·' }

async function setTab($: EngineInterface, tab: WaTab): Promise<void> {
  await putIf(await read($, tabAtom), () => tab, fn => update($, tabAtom, fn))
}

async function paneAction($: EngineInterface, rt: Runtime, action: () => Promise<string>): Promise<void> {
  try {
    const outcome = await action()
    if (outcome !== '') toastOnce($, rt, await $.clock.now(), oneLine(outcome, 160))
  } catch (error) {
    toastOnce($, rt, await $.clock.now(), `Failed: ${oneLine(messageOf(error), 120)}`)
  }
  await refreshPane($, rt)
}

async function reconnect($: EngineInterface, rt: Runtime): Promise<string> {
  rt.healthFailures = 0
  const connection = await checkConnection($, rt)
  // Nothing to reconnect to: the setup card says why and offers Start.
  if (connection.phase === 'unreachable') return ''
  if (rt.sessionId === '') return 'No WhatsApp session yet: finish the setup in this panel.'
  const started = await waCall($, rt, api.start(rt.sessionId))
  ensureSetupTicks($, rt)
  return started.ok || started.status === 400 ? 'Starting the WhatsApp session…' : `Could not start: ${failure(started)}`
}

async function previewRedaction($: EngineInterface, rt: Runtime, sample: string): Promise<void> {
  const owner = clean(sample, { audience: 'owner', maxChars: rt.settings.maxMessageChars, root: rt.root }).text
  const member = clean(sample, { audience: 'member', maxChars: rt.settings.maxMessageChars, root: rt.root, shareCode: rt.settings.shareCodeWithMembers }).text
  await update($, privacyAtom, privacy => ({ ...privacy, sample, redacted: `To you: ${owner}\nTo members: ${member}` }))
}

async function drawPane($: EngineInterface, rt: Runtime, e: RenderInput<'Pane'>, isTab = false): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Link } = elements
  // Fields exist on every surface but mobile (Elements in the types).
  const hasFields = e.surface !== 'mobile'
  const Input = hasFields && 'Input' in elements ? elements.Input : undefined
  const Select = hasFields && 'Select' in elements ? elements.Select : undefined
  const width = Math.max(24, e.props.bodyColumns)
  const tab = await read($, tabAtom)
  const now = await $.clock.now()
  const row = (text: string, max = width): string => oneLine(text, max)
  // Presence, interaction and night: mods-hub's mode when it is installed, else the bridge's prefs, as ONE value the
  // handlers below also write (refreshAttention), so what a button shows is what its press changes.
  const attention = await read($, attentionAtom)

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
    const setup = await read($, setupAtom)
    const look = PHASE_LOOK[connection.phase]
    const sessions = await read($, sessionsAtom)
    const prefs = await read($, prefsAtom)
    const inbound = await read($, inboundAtom)
    const isOn = isInteractionOn(attention, attention.interaction)
    // Group, sessions, test and digest need a linked, set-up bridge: hidden until then so nothing looks broken.
    const isReady = connection.phase === 'ready' && isConfigured(rt)
    const title = connection.phase === 'unreachable' && connection.detail !== '' ? connection.detail : look.label
    const modeText = [connection.mode === 'self' ? 'Own number: allowlisted chats only' : connection.mode === 'bot' ? 'Dedicated bot number' : '', attention.isHub ? 'mods-hub mode' : '', connection.isLeader ? 'this session polls' : '']
      .filter(part => part !== '')
      .join(' · ')
    const health = INBOUND_LOOK[inbound.health]
    body = (
      <Box flexDirection="column" gap={1}>
        <Box key="connection" flexDirection="column">
          <Text bold wrap="truncate-end">
            <Text color={look.color}>{look.glyph}</Text> {title}
            {connection.phone !== '' ? ` · +${connection.phone}` : ''}
          </Text>
          {connection.detail !== '' && connection.detail !== title && <Text dimColor wrap="wrap">{connection.detail}</Text>}
          {modeText !== '' && <Text dimColor wrap="truncate-end">{row(modeText)}</Text>}
          {connection.raw !== '' && (
            <Box key="raw">
              <Text dimColor wrap="truncate-end">{row(connection.raw)}</Text>
            </Box>
          )}
          {isConfigured(rt) && (
            <Box key="inbound" flexDirection="row" gap={1}>
              <Text color={health.color}>{health.glyph}</Text>
              <Text wrap="truncate-end">{row(`Last message received ${inbound.lastAt > 0 ? clockTime(inbound.lastAt) : '—'} · ${inbound.detail}`, width - 2)}</Text>
            </Box>
          )}
          {connection.phase === 'qr' && drawQr(elements, e.surface, connection, width, rt.baseUrl)}
          {connection.pairingCode !== '' && <Text bold wrap="wrap">Pairing code: {connection.pairingCode}</Text>}
          {connection.phase === 'qr' && Input !== undefined && (
            <Input key="pair" label="Pair " placeholder="+number to link" submitLabel="code" onSubmit={value => void paneAction($, rt, () => runWa($, rt, `pair ${value}`))} />
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {connection.phase !== 'unreachable' && connection.phase !== 'unconfigured' && (
              <Button key="reconnect" label="Reconnect" hotkey="r" onPress={() => void paneAction($, rt, () => reconnect($, rt))} />
            )}
            <Button key="refresh" label={connection.phase === 'unreachable' ? 'Check again' : 'Refresh'} onPress={() => void paneAction($, rt, () => recheck($, rt))} />
            {rt.config.managed === true && connection.phase !== 'unreachable' && connection.phase !== 'unconfigured' && (
              <Button key="stop-openwa" label="Stop OpenWA" plain onPress={() => void paneAction($, rt, () => stopServer($, rt))} />
            )}
          </Box>
          {endpointOf(rt.baseUrl).isLocal && (
            <Button
              key="autostart"
              plain
              label={`${setup.autoStart ? '☑' : '☐'} Start OpenWA automatically`}
              onPress={() => void paneAction($, rt, () => runWa($, rt, `autostart ${setup.autoStart ? 'off' : 'on'}`))}
            />
          )}
        </Box>
        {!isReady && drawSetup($, rt, elements, setup, connection, width, Input)}
        {isReady && drawGroups($, rt, elements, await read($, groupsAtom), await read($, groupAtom), width, Input)}
        {isReady && (
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
        )}
        <Box key="actions" flexDirection="row" gap={1} flexWrap="wrap">
          {isReady && <Button key="test" label="Send test" hotkey="t" onPress={() => void paneAction($, rt, () => runWa($, rt, 'test'))} />}
          {isReady && <Button key="digest" label="Digest now" onPress={() => void paneAction($, rt, () => runWa($, rt, 'digest'))} />}
          <Button key="presence" label={attention.isAway ? 'I am here' : 'I am away'} hotkey="a" onPress={() => void paneAction($, rt, () => runWa($, rt, attention.isAway ? 'here' : 'away'))} />
          <Button key="pause" label={prefs.paused ? 'Resume all' : 'Pause all'} onPress={() => void paneAction($, rt, () => runWa($, rt, prefs.paused ? 'resume' : 'pause'))} />
          <Button key="interaction" label={`Interaction: ${isOn ? 'ON' : 'OFF'}${isOn && !attention.canAsk ? ' (night)' : ''}`} variant={isOn ? 'primary' : 'secondary'} hotkey="i" onPress={() => void paneAction($, rt, () => toggleInteraction($, rt))} />
          <Button key="night" label={attention.isNight ? 'Night mode: ON' : 'Night mode'} variant={attention.isNight ? 'primary' : 'secondary'} hotkey="n" onPress={() => void paneAction($, rt, () => runWa($, rt, attention.isNight ? 'night off' : 'night'))} />
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
          <Text bold wrap="wrap">Interaction: {attention.label}</Text>
          {attention.isHub && <Text dimColor wrap="wrap">Presence, interaction and night follow mods-hub, for every session and channel (/hub).</Text>}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {(['on', 'off', 'auto'] as const).map(mode => (
              <Button
                key={`interact:${mode}`}
                label={mode === 'off' ? 'Silent' : mode === 'on' ? 'On' : attention.isHub ? 'Auto (while away)' : `Auto (off ${rt.settings.interactionOffHours})`}
                variant={attention.interaction === mode ? 'primary' : 'secondary'}
                onPress={() => void paneAction($, rt, () => runWa($, rt, `interact ${mode}`))}
              />
            ))}
            <Button key="interact:night" label="Night" variant={attention.isNight ? 'primary' : 'secondary'} onPress={() => void paneAction($, rt, () => runWa($, rt, 'night'))} />
          </Box>
        </Box>
        <Box key="timing" flexDirection="column">
          {attention.isHub ? (
            <Text dimColor wrap="wrap">Quiet hours {attention.quietHours} and the away time are mods-hub's (/hub night, the hub's settings).</Text>
          ) : Select !== undefined ? (
            <Box flexDirection="column">
              <Select key="quiet" label="Quiet hours " value={prefs.quietHours} options={['22-7', '23-8', '0-7', 'off'].map(value => ({ value, label: value }))} onSelect={value => void savePrefs($, rt, current => ({ ...current, quietHours: value }))} />
              <Select key="awayMinutes" label="Away after " value={String(prefs.awayMinutes)} options={[5, 10, 15, 30, 60].map(n => ({ value: String(n), label: `${n} min` }))} onSelect={value => void savePrefs($, rt, current => ({ ...current, awayMinutes: Number(value) }))} />
            </Box>
          ) : (
            <Text dimColor wrap="wrap">Quiet hours {prefs.quietHours} · away after {prefs.awayMinutes} min</Text>
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
          <Text bold wrap="wrap">Allowlist — the only chats read or written</Text>
          {privacy.allowlist.length === 0 && <Text dimColor wrap="wrap">Empty: set your number with /wa owner.</Text>}
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

/** The Interaction switch: off when it reads ON, on otherwise, judged from the same value the switch draws. */
async function toggleInteraction($: EngineInterface, rt: Runtime): Promise<string> {
  const attention = await refreshAttention($, rt)
  return runWa($, rt, `interact ${isInteractionOn(attention, attention.interaction) ? 'off' : 'on'}`)
}

/**
 * The Groups section: every managed group (name, where it routes, members, whether a session runs for it) with Link
 * here / Unlink / Leave; rename and invite for this session's group; or, when it has none, the name to create one
 * under (editable; typing is kept out of state) and the primary Create button, plus the groups the bot is in to link.
 */
function drawGroups(
  $: EngineInterface,
  rt: Runtime,
  elements: ElementTable,
  rows: readonly WaGroupRow[],
  card: WaGroupCard,
  width: number,
  Input: ElementConstructor<InputProps> | undefined,
): RenderElement {
  const { Box, Text, Button, Link } = elements
  const own = rows.find(one => one.status === 'this')
  const scope = rt.settings.groupScope
  const target = scope === 'session' ? 'this session' : 'this project'
  return (
    <Box key="groups" flexDirection="column">
      <Text bold>Groups ({rows.length})</Text>
      {rows.length === 0 && <Text dimColor wrap="wrap">No group yet: updates go to your direct chat.</Text>}
      {rows.map((one, index) => (
        <Box key={`grp:${one.groupId}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={GROUP_LOOK[one.status].color}>{GROUP_LOOK[one.status].glyph}</Text>
            <Text wrap="truncate-end">{oneLine(`${index + 1}. ${one.name} → ${one.routesTo} · ${plural(one.members, 'member')} · ${GROUP_LOOK[one.status].text}`, width - 2)}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {one.status !== 'this' && <Button key={`grp-link:${one.groupId}`} plain label={`Link to ${target}`} onPress={() => void paneAction($, rt, () => relinkGroup($, rt, one.key))} />}
            <Button key={`grp-unlink:${one.groupId}`} plain label="Unlink" onPress={() => void paneAction($, rt, () => unlinkGroup($, rt, one.key, false))} />
            <Button key={`grp-leave:${one.groupId}`} plain label="Leave" onPress={() => void paneAction($, rt, () => unlinkGroup($, rt, one.key, true))} />
            {one.inviteLink !== '' && <Link href={one.inviteLink} label="Invite link" />}
          </Box>
        </Box>
      ))}
      {own !== undefined && Input !== undefined && (
        <Box key="grp-manage" flexDirection="column">
          <Input key="grp-rename" label="Rename " value={own.name} submitLabel="rename" onSubmit={value => void paneAction($, rt, () => renameGroup($, rt, own.key, value))} />
          <Input key="grp-invite" label="Invite " placeholder="+39333…, +44…" submitLabel="add" onSubmit={value => void paneAction($, rt, () => inviteToGroup($, rt, own.key, value))} />
        </Box>
      )}
      {own === undefined && (
        <Box key="grp-create" flexDirection="column">
          {Input !== undefined && (
            <Input
              key="grp-name"
              label="Name "
              value={defaultGroupName(rt)}
              submitLabel="create"
              onInput={value => {
                rt.groupNameDraft = value
              }}
              onSubmit={value => void paneAction($, rt, () => createGroup($, rt, value))}
            />
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="grp-create-btn" label={`Create group for ${target}`} variant="primary" onPress={() => void paneAction($, rt, () => createGroup($, rt, rt.groupNameDraft))} />
            <Button key="grp-list" plain label="Link an existing group" onPress={() => void paneAction($, rt, () => linkProject($, rt, '#list'))} />
          </Box>
          {card.note !== '' && <Text dimColor wrap="wrap">{card.note}</Text>}
          {card.choices.map((choice, index) => (
            <Button key={`choice:${choice.id}`} label={`${index + 1}. ${oneLine(choice.name, width - 6)}`} plain onPress={() => void paneAction($, rt, () => linkProject($, rt, choice.id))} />
          ))}
        </Box>
      )}
    </Box>
  )
}

async function recheck($: EngineInterface, rt: Runtime): Promise<string> {
  rt.healthFailures = 0
  const connection = await checkConnection($, rt)
  if (isSettling(await read($, setupAtom), connection)) ensureSetupTicks($, rt)
  return ''
}

const STEP_GLYPH = { done: { glyph: '✓', color: 'success' }, busy: { glyph: '◌', color: 'warning' }, todo: { glyph: '○', color: 'inactive' }, bad: { glyph: '✗', color: 'error' } } as const

/**
 * The guided setup, while the bridge is not linked and set up: the server (start it, or point at your own), the
 * link (the QR above), your number. Nothing starts without a press, or the "Start automatically" opt-in.
 */
function drawSetup(
  $: EngineInterface,
  rt: Runtime,
  elements: ElementTable,
  setup: WaSetup,
  connection: WaConnection,
  width: number,
  Input: ElementConstructor<InputProps> | undefined,
): RenderElement {
  const { Box, Text, Button, Link } = elements
  const endpoint = endpointOf(rt.baseUrl)
  const isUp = connection.phase !== 'unreachable' && connection.phase !== 'unconfigured'
  const isBusy = ['checking', 'pulling', 'booting', 'provisioning', 'elsewhere'].includes(setup.step)
  const needsKey = isUp && (connection.phase === 'no-key' || connection.phase === 'no-session' || connection.phase === 'admin-key')
  const where = `${endpoint.host}:${endpoint.port}`
  const server: [keyof typeof STEP_GLYPH, string] = isBusy
    ? ['busy', setup.note]
    : isUp
      ? ['done', `OpenWA running at ${where}${setup.owner === 'this' ? ' (started here)' : setup.owner === 'other' ? ' (another session)' : ''}`]
      : setup.step === 'failed' || setup.step === 'no-docker' || setup.step === 'docker-off'
        ? ['bad', setup.note]
        : ['todo', `Start OpenWA (nothing answers at ${where})`]
  const link: [keyof typeof STEP_GLYPH, string] =
    connection.phase === 'ready' ? ['done', `WhatsApp linked as +${connection.phone}`] : connection.phase === 'qr' ? ['busy', 'Scan the QR above with your phone'] : ['todo', 'Link WhatsApp (a QR appears here)']
  const owner: [keyof typeof STEP_GLYPH, string] =
    rt.owners.length > 0 ? ['done', `Your number: ${rt.owners.map(n => `+${n}`).join(', ')}`] : ['todo', 'Your own number: the only one that can command Claude']
  const step = (key: string, n: number, [state, text]: [keyof typeof STEP_GLYPH, string]): RenderElement => (
    <Box key={key} flexDirection="row" gap={1}>
      <Text color={STEP_GLYPH[state].color}>{STEP_GLYPH[state].glyph}</Text>
      <Text wrap="wrap" dimColor={state === 'todo'}>
        {`${n}. ${oneLine(text, 200)}`}
      </Text>
    </Box>
  )
  const showForm = setup.isManual || (needsKey && rt.config.managed !== true)
  return (
    <Box key="setup" flexDirection="column">
      <Text bold>Setup</Text>
      {step('step:server', 1, server)}
      {setup.raw !== '' && (
        <Box key="setup-raw">
          <Text dimColor wrap="truncate-end">{oneLine(setup.raw, width)}</Text>
        </Box>
      )}
      {step('step:link', 2, link)}
      {step('step:owner', 3, owner)}
      {rt.owners.length === 0 && Input !== undefined && (
        <Input key="owner" label="Me " placeholder="+39… your WhatsApp number" submitLabel="save" onSubmit={value => void paneAction($, rt, () => runWa($, rt, `owner ${value}`))} />
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {!isUp && !isBusy && endpoint.isLocal && (
          <Button key="start-openwa" label="Start OpenWA" variant="primary" hotkey="o" onPress={() => inBackground($, rt, () => startServer($, rt))} />
        )}
        {needsKey && rt.config.managed === true && (
          <Button key="provision" label="Finish setup" variant="primary" onPress={() => inBackground($, rt, () => provision($, rt))} />
        )}
        {!isBusy && <Button key="manual" label={setup.isManual ? 'Hide' : 'I run it myself → set URL'} plain onPress={() => void setSetup($, { isManual: !setup.isManual })} />}
        {setup.step === 'no-docker' && <Link href="https://docs.docker.com/get-started/get-docker/" label="Get Docker Desktop" />}
      </Box>
      {showForm && (
        <Box key="manual-form" flexDirection="column">
          <Text dimColor wrap="wrap">Your own OpenWA: its URL, and a scoped operator key (/wa setup prints how to mint one).</Text>
          {Input !== undefined && <Input key="base-url" label="URL " placeholder={rt.baseUrl} submitLabel="save" onSubmit={value => void paneAction($, rt, () => saveBaseUrl($, rt, value))} />}
          {Input !== undefined && <Input key="setup-key" label="Key " placeholder="owa_k1_… (scoped operator key)" submitLabel="save" onSubmit={value => void paneAction($, rt, () => saveKey($, rt, value.trim()))} />}
        </Box>
      )}
    </Box>
  )
}

/**
 * The linking QR: an SVG where the surface draws one (desktop, the editor, mobile), half-block characters on a
 * terminal pane wide enough, the PNG itself on other terminals (kitty, Ghostty), else the dashboard link.
 */
function drawQr(elements: ElementTable, surface: RenderSurface, connection: WaConnection, width: number, baseUrl: string): RenderElement {
  const { Box, Text, Link } = elements
  const modules = connection.qrModules
  const hint = <Text dimColor wrap="wrap">WhatsApp › Linked devices › Link a device. The code changes every ~20 s.</Text>
  if (modules.length > 0 && 'Svg' in elements) {
    const { Svg } = elements
    return (
      <Box key="qr" flexDirection="column">
        <Svg source={qrSvg(modules)} alt="WhatsApp linking QR code" width={240} height={240} />
        {hint}
      </Box>
    )
  }
  if (modules.length > 0 && modules.length + 4 <= width) {
    return (
      <Box key="qr" flexDirection="column">
        {qrBlocks(modules, { quiet: 2, ink: 'dark' }).map((line, index) => (
          <Text key={`qr:${index}`} color="#000000" backgroundColor="#ffffff" wrap="truncate-end">
            {line}
          </Text>
        ))}
        {hint}
      </Box>
    )
  }
  if (surface === 'terminal' && 'Image' in elements && isPng(connection.qr)) {
    const { Image } = elements
    return (
      <Box key="qr" flexDirection="column">
        <Image key="qr-image" source={{ png: connection.qr }} columns={Math.min(32, width)} rows={16} alt="QR code: run /wa qr to print it in the conversation" />
        <Text dimColor wrap="wrap">No picture? /wa qr prints the QR in the conversation.</Text>
      </Box>
    )
  }
  return (
    <Box key="qr-fallback" flexDirection="column">
      <Text wrap="wrap">Run /wa qr to print the QR in the conversation, or scan it in the OpenWA dashboard:</Text>
      <Link href={dashboardOf(baseUrl)} label={`Open ${dashboardOf(baseUrl)}`} />
    </Box>
  )
}

async function closePane($: EngineInterface, rt: Runtime): Promise<void> {
  rt.isPaneOpen = false
  await $.ui.close({ id: PANE })
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  await registerCommand($, { name: 'wa', description: 'WhatsApp bridge: panel, setup, presence, interaction, project group', argumentHint: '[setup | test | away | here | interact on|off | night | link-project | help]', immediate: true })
  // Start-up (git, the channel, the hub) waits until session.start has returned (afterStart): with every mod
  // installed, waiting on a process or the hub here ran session.start past its 10 s budget.
  booting.set(rt, { isInteractive })
  afterStart($, 'whatsapp-bridge', () => ensureStarted($, rt))
}

/** Start-up per session, run once: after session.start has returned (afterStart) or at the first /wa, whichever comes first. */
const booting = new WeakMap<Runtime, { isInteractive: boolean; started?: Promise<void> }>()

function ensureStarted($: EngineInterface, rt: Runtime): Promise<void> {
  const boot = booting.get(rt) ?? { isInteractive: false }
  booting.set(rt, boot)
  boot.started ??= startUp($, rt, boot.isInteractive).catch(error => $.ui.log(`${NAME}: start-up failed: ${messageOf(error)}`, { to: 'debug' }))
  return boot.started
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readSettings(options))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSession($, rt, e.isInteractive)
    return started
  })

  // A desktop, IDE or phone client attaching to a session started without one: it is used, so it does the work.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (rt.isStarted) $.clock.after(0, () => void startBackground($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' })))
    return attached
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
      await ensureStarted($, rt)
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

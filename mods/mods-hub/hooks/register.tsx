import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type {
  Mods,
  ModsChannel,
  ModsControl,
  ModsControlAction,
  ModsControlScope,
  ModsDrainInput,
  ModsEvent,
  ModsFact,
  ModsInstall,
  ModsInstalled,
  ModsJson,
  ModsLevel,
  ModsMode,
  ModsNotice,
  ModsNotifyInput,
  ModsNotifyResult,
  ModsPrefs,
  ModsPresence,
  ModsPanelView,
  ModsPresenceReason,
  ModsPublishInput,
  ModsStopInput,
  ModsTab,
} from '../types'
import { problemWith, topicMatches } from './catalog'
import {
  DEFAULT_PREFS,
  GLYPH,
  HUB_USAGE,
  type HubCommand,
  INTERACTIONS,
  LEVELS,
  ROUTES,
  commandSignature,
  cycle,
  deriveMode,
  describeMode,
  noticeLine,
  parseHubArgs,
  presenceOf,
  route,
  sanitizePrefs,
} from './router'
import { categoryOf, dotSvg, glyphOf, iconSvg, markSvg } from './icons'
import {
  CHANNEL_DOT,
  CHANNEL_STATUS,
  type Tone,
  badge,
  controlLine,
  feedRow,
  fit,
  headerCounts,
  modCounts,
  modePill,
  needsSetup,
  plural,
  statusReport,
  statusText,
  tabLayout,
} from './look'
import { costOf } from './shared/prices'
import { redactText } from './shared/secrets'
import { isTestCommand, summarizeRun } from './shared/test-runners'

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────

const PANE = 'claude-mods'
const PANE_TITLE = 'Claude Mods'
const HOME = 'home'
/** Cross-session files, under the home directory. */
const HUB_DIR = '.claude/claude-mods/hub'
const FEED_SIZE = 50
const INBOX_SIZE = 30
const GLOBAL_FEED_SIZE = 20
const TICK_MS = 30_000
const HEARTBEAT_MS = 60_000
/** Activity is written for other sessions at most this often. */
const ACTIVITY_WRITE_MS = 30_000
/** A session whose heartbeat is older than this is gone. */
const SESSION_STALE_MS = 10 * 60_000
const DEDUPE_MS = 30_000
/** Notification keys remembered for the 30-second repeat check, at most. */
const MAX_RECENT_NOTICES = 500
const REPEATS_TO_REPORT = 3
const CONTEXT_STEPS = [70, 85, 95] as const
const LIST_TIMEOUT_MS = 15_000
const LIST_REFRESH_MS = 10 * 60_000
const MINUTE_MS = 60_000
const TAB_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const FACT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_FACT_CHARS = 16_000
const MAX_TEXT = 2_000
/** Notices kept per pull channel until its owner acknowledges them; beyond this the oldest are dropped. */
const OUTBOX_SIZE = 100
/** How often a session looks for a stop, pause or resume another session raised for all sessions. */
const CONTROL_POLL_MS = 5_000
const CONTROL_KEEP = 20
const CONTROL_MAX_AGE_MS = 60 * 60_000
const CONTROL_ACTIONS: readonly ModsControlAction[] = ['stop', 'pause', 'resume']
const CONTROL_SCOPES: readonly ModsControlScope[] = ['session', 'all']
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Changed values are copied to state on the next turn of the clock, once per round however many calls changed them. */
const FLUSH_MS = 0
const FLUSH_RETRY_MS = 1_000
const MAX_FLUSH_ROUNDS = 20
/** A mode derived this recently answers `mods.mode` from memory. */
const MODE_FRESH_MS = 1_000

// ── State the panel draws from ──────────────────────────────────────────────────────────────────────

const INITIAL_MODE: ModsMode = deriveMode(DEFAULT_PREFS, 'here', 0, 12 * 60)
const EMPTY_INSTALLED: ModsInstalled = { hello: [], plugins: [], listedAt: null }

const modeAtom = atom({ plugin: 'mods-hub', key: 'mode' } as const, INITIAL_MODE)
const prefsAtom = atom({ plugin: 'mods-hub', key: 'prefs' } as const, DEFAULT_PREFS)
const tabAtom = atom({ plugin: 'mods-hub', key: 'tab' } as const, HOME)
const tabsAtom = atom({ plugin: 'mods-hub', key: 'tabs' } as const, [] as ModsTab[])
const channelsAtom = atom({ plugin: 'mods-hub', key: 'channels' } as const, [] as ModsChannel[])
const feedAtom = atom({ plugin: 'mods-hub', key: 'feed' } as const, [] as ModsEvent[])
const inboxAtom = atom({ plugin: 'mods-hub', key: 'inbox' } as const, [] as ModsNotice[])
const installedAtom = atom({ plugin: 'mods-hub', key: 'installed' } as const, EMPTY_INSTALLED)
/** Pull channels' notices, by channel id; in state so a hot reload loses none. */
const outboxAtom = atom({ plugin: 'mods-hub', key: 'outbox' } as const, {} as Record<string, ModsNotice[]>)
const controlAtom = atom({ plugin: 'mods-hub', key: 'control' } as const, null as ModsControl | null)
const CLOSED_VIEW: ModsPanelView = { isMoreOpen: false, openChannel: null }
const viewAtom = atom({ plugin: 'mods-hub', key: 'view' } as const, CLOSED_VIEW)
/** Families: the member id is the topic (latest) or the fact's key (facts). */
const LATEST = { plugin: 'mods-hub', key: 'latest' } as const
const FACTS = { plugin: 'mods-hub', key: 'facts' } as const

// ── The noun ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The bottom of every `mods.<method>` chain. The hub's own hooks on those events do the work (they have `$`);
 * these answers stand only where a hook above the hub answered nothing better.
 */
const BOTTOM: Mods = {
  publish: async () => ({ id: '' }),
  recent: async () => [],
  latest: async () => null,
  notify: async () => ({ id: '', targets: [], held: false, reason: 'the hub did not route it' }),
  mode: async () => INITIAL_MODE,
  setMode: async () => INITIAL_MODE,
  setPresence: async () => INITIAL_MODE,
  registerTab: async () => ({ tabs: [] }),
  showTab: async () => ({ isPlaced: false }),
  registerChannel: async () => ({ channels: [] }),
  channelStatus: async () => ({ channels: [] }),
  deliver: async () => ({ isDelivered: false, reason: 'no mod delivers to this channel' }),
  drain: async () => [],
  stop: async input => ({ id: '', action: input.action ?? 'stop', scope: input.scope ?? 'session', reason: input.reason, by: input.by ?? '', session: '', source: '', at: 0 }),
  hello: async () => ({ installed: EMPTY_INSTALLED }),
  installed: async () => EMPTY_INSTALLED,
  share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
  read: async () => null,
}

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Options = { idleMs: number; awayMs: number; sensors: boolean; captureToasts: boolean }

/**
 * The hub's own values, held in memory: every `mods.*` call answers from here and writes here, and `flush` copies
 * what changed to `$.state` (for drawings and the mods that read the hub's state) at most once per round, with plain
 * writes. The hub is the only writer of its keys, so no read-modify-write (`update`) is needed: with ~165 mods calling
 * at once, `update`'s retry-on-conflict made every call re-read and re-write the same key hundreds of times.
 */
type Memory = {
  mode: ModsMode
  prefs: ModsPrefs
  tabs: ModsTab[]
  channels: ModsChannel[]
  feed: ModsEvent[]
  inbox: ModsNotice[]
  installed: ModsInstalled
  outbox: Record<string, ModsNotice[]>
  control: ModsControl | null
}
type MemoryKey = keyof Memory

type Runtime = {
  options: Options
  sessionId: string
  /** Tells this load's ids from an earlier load's (sequence numbers start again after a hot reload). */
  load: string
  startedAt: number
  cwd: string
  project: string
  /** The hub's folder under the home directory; '' until known (no files are written then). */
  dir: string
  lastActivityAt: number
  lastActivityWrittenAt: number
  presence: ModsPresence
  presenceSince: number
  wasNight: boolean
  seq: number
  sessionUsd: number
  isUsdEstimate: boolean
  turns: number
  turnTools: number
  failures: Map<string, number>
  contextStep: number
  recentNotices: Map<string, number>
  held: ModsNotice[]
  globalFeed: ModsEvent[]
  lastHeartbeatAt: number
  timer: Timer | undefined
  controlTimer: Timer | undefined
  /** Controls already applied here (raised here, or read from control.json). */
  controlSeen: Set<string>
  /** control.json entries older than this were raised before this session (or load) looked. */
  controlFloor: number
  mem: Memory
  /** The latest event per topic this load recorded (older ones are read from state). */
  latest: Map<string, ModsEvent>
  /** Whether `mem` holds what state held when this load began (state outlives a hot reload; module variables do not). */
  isHydrated: boolean
  hydrating: Promise<void> | undefined
  dirty: Set<MemoryKey>
  dirtyLatest: Set<string>
  isFlushScheduled: boolean
  flushing: Promise<void> | undefined
  /** Changes of the shared prefs run one after another, so two at once never drop each other's change. */
  prefsChain: Promise<unknown>
  /** Timer work in flight: a tick, a control poll or a listing never overlaps itself on a busy worker. */
  isTicking: boolean
  isPolling: boolean
  listing: Promise<void> | undefined
  /** Shared files already read, by path, with the mtime they had: unchanged files are not read again. */
  files: Map<string, { mtimeMs: number; value: unknown }>
  /** When `mem.mode` was last derived, in wall-clock milliseconds (how fresh a cached answer is, not the session's time). */
  modeComputedAt: number
  /** What this load last put on the status line. */
  statusText: string | undefined
}

const newRuntime = (options: Options): Runtime => ({
  options,
  sessionId: '',
  load: Math.random().toString(36).slice(2, 6),
  startedAt: 0,
  cwd: '',
  project: '',
  dir: '',
  lastActivityAt: 0,
  lastActivityWrittenAt: 0,
  presence: 'here',
  presenceSince: 0,
  wasNight: false,
  seq: 0,
  sessionUsd: 0,
  isUsdEstimate: false,
  turns: 0,
  turnTools: 0,
  failures: new Map(),
  contextStep: 0,
  recentNotices: new Map(),
  held: [],
  globalFeed: [],
  lastHeartbeatAt: 0,
  timer: undefined,
  controlTimer: undefined,
  controlSeen: new Set(),
  controlFloor: 0,
  mem: { mode: INITIAL_MODE, prefs: DEFAULT_PREFS, tabs: [], channels: [], feed: [], inbox: [], installed: EMPTY_INSTALLED, outbox: {}, control: null },
  latest: new Map(),
  isHydrated: false,
  hydrating: undefined,
  dirty: new Set(),
  dirtyLatest: new Set(),
  isFlushScheduled: false,
  flushing: undefined,
  prefsChain: Promise.resolve(),
  isTicking: false,
  isPolling: false,
  listing: undefined,
  files: new Map(),
  modeComputedAt: 0,
  statusText: undefined,
})

/** The prefix of the ids this load gives notices and controls: session, then load. */
const idTag = (rt: Runtime): string => `${rt.sessionId.slice(0, 8) || 'hub'}-${rt.load}`

const minuteOfDay = (now: number): number => {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/** A channel's hint is kept to this many characters, cut with an ellipsis; Home shows two lines of it, Set up all. */
const MAX_CHANNEL_DETAIL = 240
const oneLine = (text: string, max = MAX_TEXT): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

const asJson = (value: unknown): ModsJson => JSON.parse(JSON.stringify(value ?? null)) as ModsJson

// ── Memory, and its copy in state ───────────────────────────────────────────────────────────────────

/** Loads what state held into memory (state outlives a hot reload, module variables do not). */
async function hydrate($: EngineInterface, rt: Runtime): Promise<void> {
  const [mode, prefs, tabs, channels, feed, inbox, installed, outbox, control, now] = await Promise.all([
    read($, modeAtom),
    read($, prefsAtom),
    read($, tabsAtom),
    read($, channelsAtom),
    read($, feedAtom),
    read($, inboxAtom),
    read($, installedAtom),
    read($, outboxAtom),
    read($, controlAtom),
    $.clock.now(),
  ])
  if (rt.isHydrated) return
  rt.mem = { mode, prefs, tabs, channels, feed, inbox, installed, outbox, control }
  // A mod that asks before the hub's own session.start ran: the person counts as here from now, not since 1970.
  if (rt.lastActivityAt === 0) {
    rt.lastActivityAt = now
    rt.presenceSince = now
  }
  rt.isHydrated = true
}

/** Every hook awaits this first; one load reads state once, whoever asks first (single flight). */
async function ready($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isHydrated) return
  rt.hydrating ??= hydrate($, rt).finally(() => {
    rt.hydrating = undefined
  })
  try {
    await rt.hydrating
  } catch {
    // The dispatch that started it was abandoned; this caller reads for itself below.
  }
  if (!rt.isHydrated) await hydrate($, rt)
}

/** Changes a value in memory and has it copied to state with the next flush. */
function remember<K extends MemoryKey>($: EngineInterface, rt: Runtime, key: K, value: Memory[K]): Memory[K] {
  rt.mem[key] = value
  rt.dirty.add(key)
  scheduleFlush($, rt, FLUSH_MS)
  return value
}

function scheduleFlush($: EngineInterface, rt: Runtime, delayMs: number): void {
  if (rt.isFlushScheduled) return
  rt.isFlushScheduled = true
  $.clock.after(delayMs, () => {
    rt.isFlushScheduled = false
    void flush($, rt)
  })
}

/** Copies what changed to state: one plain write per changed key per round, however many calls changed it. */
function flush($: EngineInterface, rt: Runtime): Promise<void> {
  rt.flushing ??= writeDirty($, rt).finally(() => {
    rt.flushing = undefined
  })
  return rt.flushing
}

async function writeDirty($: EngineInterface, rt: Runtime): Promise<void> {
  let hasFailed = false
  for (let round = 0; round < MAX_FLUSH_ROUNDS && !hasFailed && (rt.dirty.size > 0 || rt.dirtyLatest.size > 0); round += 1) {
    const keys = [...rt.dirty]
    const topics = [...rt.dirtyLatest]
    rt.dirty.clear()
    rt.dirtyLatest.clear()
    const writes = [
      ...keys.map(key =>
        writeKey($, rt, key).then(
          () => true,
          () => {
            rt.dirty.add(key)
            return false
          },
        ),
      ),
      ...topics.map(topic => {
        const event = rt.latest.get(topic)
        if (event === undefined) return Promise.resolve(true)
        return $.state.set({ ...LATEST, id: topic }, event).then(
          () => true,
          () => {
            rt.dirtyLatest.add(topic)
            return false
          },
        )
      }),
    ]
    hasFailed = (await Promise.all(writes)).includes(false)
  }
  // A failed write (or a burst longer than the rounds) is tried again a moment later, never in a tight loop.
  if (rt.dirty.size > 0 || rt.dirtyLatest.size > 0) scheduleFlush($, rt, hasFailed ? FLUSH_RETRY_MS : FLUSH_MS)
}

function writeKey($: EngineInterface, rt: Runtime, key: MemoryKey): Promise<unknown> {
  const mem = rt.mem
  switch (key) {
    case 'mode':
      return $.state.set({ plugin: 'mods-hub', key: 'mode' }, mem.mode)
    case 'prefs':
      return $.state.set({ plugin: 'mods-hub', key: 'prefs' }, mem.prefs)
    case 'tabs':
      return $.state.set({ plugin: 'mods-hub', key: 'tabs' }, mem.tabs)
    case 'channels':
      return $.state.set({ plugin: 'mods-hub', key: 'channels' }, mem.channels)
    case 'feed':
      return $.state.set({ plugin: 'mods-hub', key: 'feed' }, mem.feed)
    case 'inbox':
      return $.state.set({ plugin: 'mods-hub', key: 'inbox' }, mem.inbox)
    case 'installed':
      return $.state.set({ plugin: 'mods-hub', key: 'installed' }, mem.installed)
    case 'outbox':
      return $.state.set({ plugin: 'mods-hub', key: 'outbox' }, mem.outbox)
    case 'control':
      return $.state.set({ plugin: 'mods-hub', key: 'control' }, mem.control)
  }
}

// ── Files shared by sessions ────────────────────────────────────────────────────────────────────────

async function readJsonFile($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path)) as unknown
  } catch {
    return undefined
  }
}

async function writeJsonFile($: EngineInterface, path: string, value: unknown): Promise<void> {
  try {
    await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
  } catch {
    // A read-only home or a full disk costs the cross-session view, never the session.
  }
}

/** A shared file a listing found: read again only when its mtime moved (a listing without mtimes reads every time). */
async function readJsonCached($: EngineInterface, rt: Runtime, path: string, mtimeMs: number): Promise<unknown> {
  const known = rt.files.get(path)
  if (mtimeMs > 0 && known !== undefined && known.mtimeMs === mtimeMs) return known.value
  const value = await readJsonFile($, path)
  if (mtimeMs > 0) rt.files.set(path, { mtimeMs, value })
  return value
}

/** Drops what is remembered of files under `prefix` that the last listing no longer showed. */
function forgetFiles(rt: Runtime, prefix: string, seen: ReadonlySet<string>): void {
  for (const path of rt.files.keys()) if (path.startsWith(prefix) && !seen.has(path)) rt.files.delete(path)
}

/**
 * Reads prefs.json (another session may have changed it) and the shared last activity. A missing or unreadable file
 * changes nothing: a home where the write failed must not undo, 30 s later, what the person just set.
 */
async function loadShared($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '') return
  const raw = await readJsonFile($, `${rt.dir}/prefs.json`)
  if (raw !== undefined) {
    const prefs = sanitizePrefs(raw)
    if (JSON.stringify(rt.mem.prefs) !== JSON.stringify(prefs)) remember($, rt, 'prefs', prefs)
  }
  const activity = (await readJsonFile($, `${rt.dir}/activity.json`)) as { at?: unknown } | undefined
  if (typeof activity?.at === 'number' && activity.at > rt.lastActivityAt) rt.lastActivityAt = activity.at
}

/** Changes the prefs every session shares, then recomputes the mode; changes made at once run one after another. */
function changePrefs($: EngineInterface, rt: Runtime, change: (prefs: ModsPrefs) => ModsPrefs): Promise<ModsMode> {
  const next = rt.prefsChain.then(
    () => applyPrefs($, rt, change),
    () => applyPrefs($, rt, change),
  )
  rt.prefsChain = next.catch(() => undefined)
  return next
}

async function applyPrefs($: EngineInterface, rt: Runtime, change: (prefs: ModsPrefs) => ModsPrefs): Promise<ModsMode> {
  // From the file, not this session's copy (up to 30 s old): what another session changed meanwhile is kept.
  const onDisk = rt.dir === '' ? undefined : await readJsonFile($, `${rt.dir}/prefs.json`)
  const next = sanitizePrefs(change(onDisk === undefined ? rt.mem.prefs : sanitizePrefs(onDisk)))
  remember($, rt, 'prefs', next)
  if (rt.dir !== '') await writeJsonFile($, `${rt.dir}/prefs.json`, next)
  const mode = await refreshMode($, rt, 'manual')
  // A change someone made is drawn (and read by other mods) right away.
  await flush($, rt)
  return mode
}

/**
 * This session's heartbeat. Each session writes only its own `sessions/<id>.json` (one writer per file: two sessions
 * beating at once can no longer drop each other's line, and an ended session cannot be written back by another), then
 * rebuilds `sessions.json`, the merged view mission-control, resume-brief, handoff and standup read, from those files.
 */
async function heartbeat($: EngineInterface, rt: Runtime, isEnding = false): Promise<void> {
  if (rt.dir === '' || rt.sessionId === '') return
  const now = await $.clock.now()
  rt.lastHeartbeatAt = now
  const mode = rt.mem.mode
  const own = {
    id: rt.sessionId,
    project: rt.project,
    cwd: rt.cwd,
    startedAt: rt.startedAt,
    lastSeen: now,
    presence: mode.presence,
    turns: rt.turns,
    usd: Math.round(rt.sessionUsd * 10_000) / 10_000,
    events: rt.globalFeed,
    ...(isEnding ? { ended: true } : {}),
  }
  await writeJsonFile($, `${rt.dir}/sessions/${fileId(rt.sessionId)}.json`, own)
  const sessions = await mergedSessions($, rt, now)
  if (isEnding) delete sessions[rt.sessionId]
  else sessions[rt.sessionId] = { ...own }
  await writeJsonFile($, `${rt.dir}/sessions.json`, sessions)
}

/** A session id as a file name. */
const fileId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The live sessions from their own files (fresh and not ended), plus the lines of sessions.json that no file speaks for
 * (a session still on an older hub, which writes only there).
 */
async function mergedSessions($: EngineInterface, rt: Runtime, now: number): Promise<Record<string, unknown>> {
  const sessions: Record<string, unknown> = {}
  const spoken = new Set<string>()
  const entries = await $.fs.list(`${rt.dir}/sessions`).catch(() => [])
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || (entry.mtimeMs > 0 && now - entry.mtimeMs >= SESSION_STALE_MS)) continue
    const path = `${rt.dir}/sessions/${entry.name}`
    seen.add(path)
    const one = (await readJsonCached($, rt, path, entry.mtimeMs)) as { id?: unknown; lastSeen?: unknown; ended?: unknown } | undefined
    if (typeof one?.id !== 'string' || typeof one.lastSeen !== 'number') continue
    spoken.add(one.id)
    if (one.ended === true || now - one.lastSeen >= SESSION_STALE_MS) continue
    const { ended: _ended, ...line } = one
    sessions[one.id] = line
  }
  forgetFiles(rt, `${rt.dir}/sessions/`, seen)
  const legacy = ((await readJsonFile($, `${rt.dir}/sessions.json`)) ?? {}) as Record<string, { lastSeen?: unknown } | null>
  for (const [id, entry] of Object.entries(legacy)) {
    if (!spoken.has(id) && id !== rt.sessionId && typeof entry?.lastSeen === 'number' && now - entry.lastSeen < SESSION_STALE_MS) sessions[id] = entry
  }
  return sessions
}

// ── Presence and the mode ───────────────────────────────────────────────────────────────────────────

/**
 * Recomputes presence and the mode from memory (no state read, no file read: one clock read); the mode goes to state
 * only when it changed, and a change of presence is published as session.idle / away / back.
 */
async function refreshMode($: EngineInterface, rt: Runtime, reason: ModsPresenceReason): Promise<ModsMode> {
  const now = await $.clock.now()
  const prefs = rt.mem.prefs
  const presence = presenceOf(prefs.presence, { lastActivityAt: rt.lastActivityAt, now, idleMs: rt.options.idleMs, awayMs: rt.options.awayMs })
  const mode = deriveMode(prefs, presence, now, minuteOfDay(now), { idleMinutes: rt.options.idleMs / MINUTE_MS, awayMinutes: rt.options.awayMs / MINUTE_MS })
  if (!sameMode(rt.mem.mode, mode)) remember($, rt, 'mode', mode)
  rt.modeComputedAt = Date.now()
  showStatus($, rt, now)
  const isNightOver = rt.wasNight && !mode.isNight
  rt.wasNight = mode.isNight
  if (presence !== rt.presence) {
    const since = rt.presenceSince
    const wasAway = rt.presence === 'away'
    rt.presence = presence
    rt.presenceSince = now
    if (presence === 'here') {
      if (wasAway) await publishSelf($, rt, { topic: 'session.back', data: { since: now, reason, awayMs: now - since } })
    } else if (presence === 'idle') {
      await publishSelf($, rt, { topic: 'session.idle', data: { since: now, reason } })
    } else {
      await publishSelf($, rt, { topic: 'session.away', data: { since: now, reason } })
    }
  }
  if (isNightOver) await sendDigest($, rt)
  return mode
}

/** The status line entry, set only when it changes (Silent, Night, away or held work; cleared otherwise). */
function showStatus($: EngineInterface, rt: Runtime, now: number): void {
  const text = statusText(rt.mem.mode, rt.mem.control, now)
  if (text === rt.statusText) return
  rt.statusText = text
  $.ui.status(text)
}

const MODE_FIELDS: readonly (keyof ModsMode)[] = ['presence', 'isSilent', 'silentUntil', 'isNight', 'isNightOn', 'quietHours', 'idleMinutes', 'awayMinutes', 'interaction', 'canAsk']
const sameMode = (a: ModsMode, b: ModsMode): boolean => MODE_FIELDS.every(field => a[field] === b[field])

/** The person did something: they are here, and a manual "away" ends. */
async function noteActivity($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  rt.lastActivityAt = now
  if (rt.mem.prefs.presence === 'away') {
    await changePrefs($, rt, current => ({ ...current, presence: 'auto' }))
  } else {
    await refreshMode($, rt, 'activity')
  }
  if (rt.dir !== '' && now - rt.lastActivityWrittenAt >= ACTIVITY_WRITE_MS) {
    rt.lastActivityWrittenAt = now
    await writeJsonFile($, `${rt.dir}/activity.json`, { at: now, session: rt.sessionId })
  }
}

/**
 * Every 30 s: other sessions' prefs and activity, presence timers, silent's end, night's end, the heartbeat. A tick
 * still running when the next is due (a busy worker) lets it pass rather than stacking a second one on it.
 */
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    await ready($, rt)
    await loadShared($, rt)
    const prefs = rt.mem.prefs
    const now = await $.clock.now()
    if (prefs.isSilent && prefs.silentUntil !== null && now >= prefs.silentUntil) {
      await changePrefs($, rt, current => ({ ...current, isSilent: false, silentUntil: null }))
      $.ui.toast('Silent is over: toasts and sounds are back.')
    } else {
      await refreshMode($, rt, 'timer')
    }
    if (now - rt.lastHeartbeatAt >= HEARTBEAT_MS) await heartbeat($, rt)
  } finally {
    rt.isTicking = false
  }
}

// ── The bus ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The hub publishing on its own behalf (sensors, presence). A plugin's call on its own noun skips its own hooks
 * on that event, so the hub records the event itself, then raises it through `$.mods` for every subscriber.
 */
async function publishSelf($: EngineInterface, rt: Runtime, input: ModsPublishInput): Promise<void> {
  await record($, rt, input, 'mods-hub')
  try {
    await $.mods.publish(input)
  } catch {
    // A subscriber that refused the hub's own event changes nothing here.
  }
}

/** Stamps and keeps an accepted event: the feed, the latest of its topic, and the cross-session feed. */
async function record($: EngineInterface, rt: Runtime, input: ModsPublishInput, source: string): Promise<ModsEvent> {
  rt.seq += 1
  const event: ModsEvent = {
    // The load tag keeps ids unique across a hot reload: the feed survives it in state, the sequence does not.
    id: `${idTag(rt)}-${rt.seq}`,
    topic: input.topic,
    data: asJson(input.data),
    source,
    at: await $.clock.now(),
    session: rt.sessionId,
    scope: input.scope ?? 'session',
  }
  remember($, rt, 'feed', [...rt.mem.feed.slice(1 - FEED_SIZE), event])
  rt.latest.set(event.topic, event)
  rt.dirtyLatest.add(event.topic)
  scheduleFlush($, rt, FLUSH_MS)
  if (event.scope === 'global') rt.globalFeed = [...rt.globalFeed, event].slice(-GLOBAL_FEED_SIZE)
  return event
}

function recentEvents(rt: Runtime, input: { topic?: string; prefix?: string; since?: number; limit?: number }): ModsEvent[] {
  const feed = rt.mem.feed
  const limit = Math.max(1, Math.min(FEED_SIZE, input.limit ?? FEED_SIZE))
  return feed
    .filter(event => (input.topic === undefined || event.topic === input.topic) && (input.prefix === undefined || topicMatches(event.topic, input.prefix)))
    .filter(event => input.since === undefined || event.at > input.since)
    .slice(-limit)
}

// ── Notifications ───────────────────────────────────────────────────────────────────────────────────

const problemWithNotice = (input: ModsNotifyInput): string | undefined => {
  if (!LEVELS.includes(input.level)) return `level must be one of ${LEVELS.join(', ')}`
  if (typeof input.title !== 'string' || input.title.trim() === '') return 'a notification needs a title'
  if (input.body !== undefined && typeof input.body !== 'string') return 'a notification body is text'
  return undefined
}

function addToInbox($: EngineInterface, rt: Runtime, notice: ModsNotice): void {
  remember($, rt, 'inbox', [...rt.mem.inbox.slice(1 - INBOX_SIZE), notice])
}

/** Routes one notification: toast, channels (in the background), or held for the digest. */
async function dispatch($: EngineInterface, rt: Runtime, input: ModsNotifyInput, source: string): Promise<ModsNotifyResult> {
  const now = await $.clock.now()
  // Identical means the same text too: two different "CI failed" bodies (two repos) are two notifications.
  const key = `${source}|${input.level}|${input.title}|${input.body ?? ''}`
  // Oldest first (a key is set again only after it expired and was dropped): stop at the first fresh one.
  for (const [old, at] of rt.recentNotices) {
    if (now - at <= DEDUPE_MS && rt.recentNotices.size <= MAX_RECENT_NOTICES) break
    rt.recentNotices.delete(old)
  }
  const seen = rt.recentNotices.get(key)
  rt.seq += 1
  const id = `n-${idTag(rt)}-${rt.seq}`
  if (seen !== undefined && now - seen < DEDUPE_MS) return { id, targets: [], held: false, reason: 'a repeat of the last 30 seconds' }
  rt.recentNotices.set(key, now)

  const mode = await refreshMode($, rt, 'timer')
  const decision = route(input, mode, rt.mem.prefs, rt.mem.channels)
  const targets = [...(decision.toast ? ['toast'] : []), ...decision.channels]
  const notice: ModsNotice = {
    ...input,
    title: oneLine(input.title, 200),
    ...(input.body === undefined ? {} : { body: input.body.slice(0, MAX_TEXT) }),
    id,
    source,
    at: now,
    targets,
    held: decision.held,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  }
  addToInbox($, rt, notice)
  if (decision.toast) $.ui.toast(noticeLine(notice))
  if (decision.held) rt.held = [...rt.held, notice].slice(-INBOX_SIZE)
  if (decision.channels.length > 0) $.clock.after(0, () => void deliverAll($, rt, notice, decision.channels))
  await publishSelf($, rt, { topic: 'notification.sent', data: { level: notice.level, title: notice.title, source, targets, held: decision.held } })
  return { id, targets, held: decision.held, ...(decision.reason === undefined ? {} : { reason: decision.reason }) }
}

/** What leaves the machine has its secrets masked first. */
const forChannels = (notice: ModsNotice): ModsNotice => ({
  ...notice,
  title: redactText(notice.title).text,
  ...(notice.body === undefined ? {} : { body: redactText(notice.body).text }),
})

/** Hands a notice to each channel: push channels answer `mods.deliver`, pull channels find it in their outbox. */
async function deliverAll($: EngineInterface, rt: Runtime, notice: ModsNotice, ids: readonly string[]): Promise<void> {
  const safe = forChannels(notice)
  const channels = rt.mem.channels
  for (const id of ids) {
    const channel = channels.find(one => one.id === id)
    if (channel === undefined) continue
    let isDelivered = false
    if (channel.delivery === 'push') {
      try {
        isDelivered = (await $.mods.deliver({ channel: id, notice: safe })).isDelivered
      } catch {
        isDelivered = false
      }
    }
    if (!isDelivered) {
      const box = rt.mem.outbox
      remember($, rt, 'outbox', { ...box, [id]: [...(box[id] ?? []).slice(1 - OUTBOX_SIZE), safe] })
      // In state before anything else happens: a hot reload must not lose a notice its channel has not drained.
      await flush($, rt)
    }
  }
}

/**
 * A pull channel's drain. With a cursor (`after`: the last id its owner handled, null at first) it acknowledges
 * everything up to that id and returns what still waits, keeping it: at-least-once. Without one (the first
 * contract) it hands the notices over and forgets them.
 */
async function drainOutbox($: EngineInterface, rt: Runtime, input: ModsDrainInput): Promise<ModsNotice[]> {
  const box = rt.mem.outbox
  const list = box[input.channel] ?? []
  if (input.after === undefined) {
    if (list.length === 0) return []
    remember($, rt, 'outbox', { ...box, [input.channel]: [] })
    await flush($, rt)
    return list
  }
  const handled = input.after === null ? -1 : list.findIndex(notice => notice.id === input.after)
  const waiting = list.slice(handled + 1)
  if (handled >= 0) {
    remember($, rt, 'outbox', { ...box, [input.channel]: waiting })
    await flush($, rt)
  }
  return waiting
}

/** Night is over: what was held goes out as one digest to the person's channels. */
async function sendDigest($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.held.length === 0) return
  const held = rt.held
  rt.held = []
  const now = await $.clock.now()
  rt.seq += 1
  const digest: ModsNotice = {
    id: `d-${idTag(rt)}-${rt.seq}`,
    level: 'info',
    title: `${held.length} notification${held.length === 1 ? '' : 's'} overnight`,
    body: held.map(notice => `${GLYPH[notice.level]} ${notice.source}: ${notice.title}`).join('\n').slice(0, MAX_TEXT),
    source: 'mods-hub',
    at: now,
    targets: [],
    held: false,
  }
  const channels = rt.mem.channels.filter(channel => channel.audience === 'me' && channel.status !== 'unconfigured').map(channel => channel.id)
  addToInbox($, rt, { ...digest, targets: channels })
  if (channels.length > 0) await deliverAll($, rt, digest, channels)
}

// ── Stop, pause, resume: the automatic work, in this session or all of them ─────────────────────────

const isControl = (value: unknown): value is ModsControl => {
  if (value === null || typeof value !== 'object') return false
  const one = value as Record<string, unknown>
  return (
    typeof one.id === 'string' &&
    CONTROL_ACTIONS.includes(one.action as ModsControlAction) &&
    CONTROL_SCOPES.includes(one.scope as ModsControlScope) &&
    typeof one.reason === 'string' &&
    typeof one.by === 'string' &&
    typeof one.session === 'string' &&
    typeof one.source === 'string' &&
    typeof one.at === 'number'
  )
}

const problemWithStop = (input: ModsStopInput): string | undefined => {
  if (input.action !== undefined && !CONTROL_ACTIONS.includes(input.action)) return `action must be one of ${CONTROL_ACTIONS.join(', ')}`
  if (input.scope !== undefined && !CONTROL_SCOPES.includes(input.scope)) return `scope must be one of ${CONTROL_SCOPES.join(', ')}`
  if (typeof input.reason !== 'string' || input.reason.trim() === '') return 'a stop needs a reason'
  return undefined
}

/** One control file's list: `{ controls: [...] }`. */
async function readControlFile($: EngineInterface, path: string): Promise<ModsControl[]> {
  return controlsIn(await readJsonFile($, path))
}

const controlsIn = (raw: unknown): ModsControl[] => {
  const controls = (raw as { controls?: unknown } | undefined)?.controls
  return Array.isArray(controls) ? controls.filter(isControl) : []
}

/**
 * The stops, pauses and resumes raised for all sessions in the last hour: each session writes only its own
 * `control/<id>.json` (one writer per file, so two STOP ALLs raised at once both survive), and an older hub's shared
 * control.json is still read.
 */
async function readControls($: EngineInterface, rt: Runtime, now: number): Promise<ModsControl[]> {
  const controls = await readControlFile($, `${rt.dir}/control.json`)
  const seen = new Set<string>()
  for (const entry of await $.fs.list(`${rt.dir}/control`).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || (entry.mtimeMs > 0 && now - entry.mtimeMs >= CONTROL_MAX_AGE_MS)) continue
    const path = `${rt.dir}/control/${entry.name}`
    seen.add(path)
    controls.push(...controlsIn(await readJsonCached($, rt, path, entry.mtimeMs)))
  }
  forgetFiles(rt, `${rt.dir}/control/`, seen)
  return controls
}

/** A control takes effect here: the `control` state, and `control.<action>` on the bus with the asking mod as source. */
async function applyControl($: EngineInterface, rt: Runtime, control: ModsControl): Promise<void> {
  rt.controlSeen.add(control.id)
  remember($, rt, 'control', control)
  showStatus($, rt, await $.clock.now())
  // Mods that run on their own read it from state: written before they hear of it.
  await flush($, rt)
  const input = { topic: `control.${control.action}`, data: { id: control.id, scope: control.scope, reason: control.reason, by: control.by, session: control.session } } as ModsPublishInput
  await record($, rt, input, control.source)
  try {
    await $.mods.publish(input)
  } catch {
    // A subscriber that refused it changes nothing: the state and the feed hold it.
  }
}

/** `$.mods.stop` (and `/hub stop|pause|resume`): applied here, and written for the other sessions when scope is all. */
async function raiseControl($: EngineInterface, rt: Runtime, input: ModsStopInput, source: string): Promise<ModsControl> {
  const now = await $.clock.now()
  rt.seq += 1
  const control: ModsControl = {
    id: `c-${idTag(rt)}-${rt.seq}`,
    action: input.action ?? 'stop',
    scope: input.scope ?? 'session',
    reason: oneLine(input.reason, 200),
    by: oneLine(input.by ?? '', 80) || source,
    session: rt.sessionId,
    source,
    at: now,
  }
  await applyControl($, rt, control)
  if (control.scope === 'all' && rt.dir !== '') {
    const path = `${rt.dir}/control/${fileId(rt.sessionId || 'hub')}.json`
    const kept = (await readControlFile($, path)).filter(one => now - one.at < CONTROL_MAX_AGE_MS && one.id !== control.id)
    await writeJsonFile($, path, { controls: [...kept, control].slice(-CONTROL_KEEP) })
  }
  return control
}

/** Every 5 s: what other sessions raised for all sessions since this one started, applied in order, once. */
async function pollControls($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '' || rt.isPolling) return
  rt.isPolling = true
  try {
    await ready($, rt)
    if (rt.controlFloor === 0) rt.controlFloor = await $.clock.now()
    const fresh = (await readControls($, rt, await $.clock.now()))
      .filter(one => one.scope === 'all' && one.session !== rt.sessionId && one.at >= rt.controlFloor && !rt.controlSeen.has(one.id))
      .sort((a, b) => a.at - b.at)
    for (const control of fresh) await applyControl($, rt, control)
  } finally {
    rt.isPolling = false
  }
}

// ── Sensors: standard events from what the session does ─────────────────────────────────────────────

const bashOutput = (ran: { result?: unknown; text?: string }): string => {
  const result = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  if (result !== undefined && result !== null && typeof result === 'object' && typeof result.stdout === 'string') {
    return `${result.stdout}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  }
  return ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
}

async function observeBash($: EngineInterface, rt: Runtime, command: string, output: string, hasFailed: boolean, durationMs: number): Promise<void> {
  if (isTestCommand(command)) {
    const run = summarizeRun(command, output, hasFailed)
    await publishSelf($, rt, {
      topic: 'test.result',
      data: { runner: run.runner ?? 'unknown', outcome: run.outcome, passed: run.passed, failed: run.failed, durationMs, command: command.slice(0, 200) },
    })
  }
  if (!hasFailed) return
  const signature = commandSignature(command)
  const count = (rt.failures.get(signature) ?? 0) + 1
  rt.failures.set(signature, count)
  if (count === REPEATS_TO_REPORT) {
    await publishSelf($, rt, { topic: 'error.repeated', data: { signature, count, tool: 'Bash', command: command.slice(0, 200) } })
  }
}

async function observeTurn($: EngineInterface, rt: Runtime, usage: Parameters<typeof costOf>[0] & { model: string }, durationMs: number, isAborted: boolean): Promise<void> {
  const costed = costOf(usage, usage.model)
  rt.sessionUsd += costed.usd
  rt.isUsdEstimate ||= !costed.isKnownModel
  await publishSelf($, rt, {
    topic: 'cost.update',
    data: { turnUsd: costed.usd, sessionUsd: rt.sessionUsd, model: usage.model, tokens: costed.tokens, isEstimate: rt.isUsdEstimate },
  })
  await publishSelf($, rt, { topic: 'turn.finished', data: { durationMs, tools: rt.turnTools, isAborted } })
}

// ── Installed plugins ───────────────────────────────────────────────────────────────────────────────

/**
 * `claude plugin list --json`, in the background, when the last listing is missing or older than 10 minutes; one at a
 * time however many mods ask (`installed()` and `hello` answer from memory meanwhile).
 */
function refreshInstalled($: EngineInterface, rt: Runtime, now: number): void {
  const listedAt = rt.mem.installed.listedAt
  if (rt.listing !== undefined || (listedAt !== null && now - listedAt <= LIST_REFRESH_MS)) return
  rt.listing = listPlugins($, rt).finally(() => {
    rt.listing = undefined
  })
}

async function listPlugins($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const ran = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS })
    if (ran.exitCode !== 0) return
    const rows = JSON.parse(ran.stdout) as { id?: unknown; version?: unknown; enabled?: unknown }[]
    const plugins: ModsInstall[] = rows
      .filter(row => typeof row.id === 'string')
      .map(row => {
        const [name = '', marketplace = ''] = String(row.id).split('@')
        return { name, marketplace, version: typeof row.version === 'string' ? row.version : '', isEnabled: row.enabled !== false }
      })
    const now = await $.clock.now()
    remember($, rt, 'installed', { ...rt.mem.installed, plugins, listedAt: now })
  } catch {
    // No `claude` on PATH, or an older CLI: the Home tab lists the mods that said hello.
  }
}

// ── The /hub command ────────────────────────────────────────────────────────────────────────────────

async function openPanel($: EngineInterface, rt: Runtime, tab: string): Promise<boolean> {
  // What the panel draws from is in state before it opens.
  await flush($, rt)
  await $.state.set({ plugin: 'mods-hub', key: 'tab' }, tab)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  return opened.isPlaced
}

/** `/hub` words that only look (status, a test, a tab): they must not end the "away" the person just set to try them. */
const LOOKING: ReadonlySet<HubCommand['kind']> = new Set(['open', 'status', 'tab', 'test', 'error'])

async function runHub($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const command = parseHubArgs(args)
  if (!LOOKING.has(command.kind)) await noteActivity($, rt)
  const now = await $.clock.now()
  switch (command.kind) {
    case 'open':
      return (await openPanel($, rt, HOME)) ? 'Claude Mods panel opened.' : 'Claude Mods panel opened; widen the terminal to see it.'
    case 'status': {
      const mode = await refreshMode($, rt, 'timer')
      const { channels, tabs, control, installed } = rt.mem
      return statusReport({ mode, modeLine: describeMode(mode, now), control, channels, tabs, installed })
    }
    case 'silent': {
      const until = command.minutes === null ? null : now + command.minutes * MINUTE_MS
      await changePrefs($, rt, prefs => ({ ...prefs, isSilent: true, silentUntil: until }))
      return command.minutes === null ? 'Silent until /hub silent off: mods keep their toasts and sounds in the Home tab.' : `Silent for ${command.minutes} min.`
    }
    case 'loud':
      await changePrefs($, rt, prefs => ({ ...prefs, isSilent: false, silentUntil: null }))
      return 'Silent is off.'
    case 'night':
      await changePrefs($, rt, prefs => ({ ...prefs, isNightOn: command.isOn, quietHours: command.quietHours ?? prefs.quietHours }))
      return command.isOn ? `Night mode on (${command.quietHours ?? rt.mem.prefs.quietHours}).` : 'Night mode off.'
    case 'away':
      await changePrefs($, rt, prefs => ({ ...prefs, presence: 'away' }))
      return 'Marked away until your next prompt: notifications routed "away" go to your channels.'
    case 'back':
      rt.lastActivityAt = now
      await changePrefs($, rt, prefs => ({ ...prefs, presence: 'auto' }))
      return 'Welcome back.'
    case 'interaction':
      await changePrefs($, rt, prefs => ({ ...prefs, interaction: command.value }))
      return `Interaction: ${command.value}.`
    case 'route':
      await changePrefs($, rt, prefs => ({ ...prefs, routes: { ...prefs.routes, [command.level]: command.value } }))
      return `${command.level} → ${command.value}.`
    case 'tab': {
      const tabs = rt.mem.tabs
      if (command.id !== HOME && !tabs.some(tab => tab.id === command.id)) return `No tab "${command.id}". Tabs: ${['home', ...tabs.map(tab => tab.id)].join(', ')}.`
      await openPanel($, rt, command.id)
      return `Showing ${command.id}.`
    }
    case 'test': {
      const result = await dispatch($, rt, { level: command.level, title: 'Test notification', body: 'Sent with /hub test' }, 'mods-hub')
      return `Routed to ${result.targets.length === 0 ? 'nowhere' : result.targets.join(', ')}${result.held ? ' (held for the morning digest)' : ''}${result.reason === undefined ? '' : ` — ${result.reason}`}.`
    }
    case 'control': {
      await raiseControl($, rt, { action: command.action, scope: command.scope, reason: `/hub ${command.action}`, by: 'you, at the terminal' }, 'mods-hub')
      const where = command.scope === 'all' ? 'every session' : 'this session'
      return command.action === 'resume'
        ? `Resume sent to ${where}: mods that work on their own may start again.`
        : `${command.action === 'stop' ? 'Stop' : 'Pause'} sent to ${where}: autopilot, task-queue, night-shift and workflows ${command.action === 'stop' ? 'stop' : 'pause'} (/hub resume${command.scope === 'all' ? ' all' : ''} lifts it).`
    }
    case 'error':
      return command.message === HUB_USAGE ? HUB_USAGE : `${command.message}\n${HUB_USAGE}`
  }
}

// ── The panel ───────────────────────────────────────────────────────────────────────────────────────
//
// One frame for every tab (docs/DESIGN.md, as mod-store draws it): the Slot mark with "Claude Mods · Hub", the counts
// and the mode as a pill; then the tab bar (the owner's category glyph in the terminal, its icon elsewhere): Home and
// the first nine tabs pinned with their digits `0`–`9`, the rest behind More (a menu on the desktop, a dim second row
// on the terminal, a fold on the phone); then the tab. Home is cards: the mode as segmented controls, the
// automatic-work strip, the channels with health dots, routing, the mods, and the activity feed.
//
// Nothing may run past the pane's edge on any surface: every row that can grow is a Box with `minWidth={0}` and
// `overflow="hidden"` around a Text with `wrap="truncate-end"`, and the text is also cut to the cells the row has
// (`fit`), so a remote renderer that lays out with its own font still ellipsizes instead of clipping. A row is one
// line, so a redraw with new data never moves what is below it; the exceptions wrap on purpose, bounded: a channel's
// setup hint (two lines at most), its open help and the two empty-state sentences. A tab's own body (from `next`) is
// never put under a sized Box.

const ROUTE_LABEL: Record<string, string> = { terminal: 'terminal', away: 'when away', always: 'always', off: 'off' }
/** The label column every Home row shares: the mode rows' labels, the channels' dot and name. */
const LABEL_COLUMNS = 15
const BADGE_COLUMNS = 16
/** Below this the panel is narrow: shorter badges, no feed destination, no header counts. */
const NARROW_COLUMNS = 64
/** The cells a channel row's controls take on the right: `[ Set up ]`, `[ On ]`, `[ Off ]` and their gaps. */
const CHANNEL_CONTROLS = 26
/** The same without Set up: `[ On ] [ Off ]`. */
const CHANNEL_SWITCH = 15
/** The Select option that stands for "nothing picked" in the desktop's More menu. */
const MORE_VALUE = '·more'

type Look = ReturnType<typeof kit>

/** The pieces every section draws with, made once per drawing for its surface. */
function kit($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text } = $.ui.resolve(e)
  const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
  const isTerminal = e.surface === 'terminal'
  const columns = Math.max(20, e.props.bodyColumns || 80)
  const icon = (category: string, size = 14): RenderElement =>
    Svg === undefined ? <Text color="claude">{glyphOf(category)}</Text> : <Svg source={iconSvg(category, size)} alt={category} width={size} height={size} />
  const kicker = (text: string, aside?: string): RenderElement => (
    <Box flexDirection="row" columnGap={1} minWidth={0} overflow="hidden">
      <Text color="claude">▪</Text>
      <Text bold dimColor>
        {text.toUpperCase()}
      </Text>
      {aside === undefined ? null : (
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {fit(aside, columns - text.length - 3)}
          </Text>
        </Box>
      )}
    </Box>
  )
  const pill = (text: string, tone: Tone): RenderElement =>
    isTerminal ? (
      <Text color={tone}>{text}</Text>
    ) : (
      <Box borderStyle="round" borderColor={tone} paddingX={1} flexShrink={0}>
        <Text color={tone}>{text}</Text>
      </Box>
    )
  const dot = (status: ModsChannel['status']): RenderElement => {
    const look = CHANNEL_DOT[status]
    return Svg === undefined ? <Text color={look.tone}>{look.glyph}</Text> : <Svg source={dotSvg(look.hex, look.isHollow)} alt={status} width={8} height={8} />
  }
  /** One line that takes what is left of its row and ellipsizes: cut to `cells`, truncated by the surface too. */
  const line = (text: string, cells: number, style: { color?: Tone; dimColor?: boolean; bold?: boolean } = {}): RenderElement => (
    <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
      <Text {...style} wrap="truncate-end">
        {fit(text, cells)}
      </Text>
    </Box>
  )
  return { isTerminal, isNarrow: columns < NARROW_COLUMNS, columns, Svg, icon, kicker, pill, dot, line }
}

/** The frame's header: mark and name, then the counts and the mode pill (the counts give way first when narrow). */
function drawHeader($: EngineInterface, e: RenderInput<'Pane'>, look: Look, mem: { mode: ModsMode; installed: ModsInstalled; tabs: ModsTab[]; channels: ModsChannel[] }, now: number): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const mark =
    look.Svg === undefined ? (
      <Text>
        <Text dimColor>▪▪</Text>
        <Text color="claude">▪</Text>
      </Text>
    ) : (
      <look.Svg source={markSvg(18)} alt="Claude Mods" width={18} height={18} />
    )
  const pill = modePill(mem.mode, now)
  // `▪▪▪ Claude Mods · Hub` is 21 cells, the pill its text and its frame; the counts get the rest.
  const countsRoom = look.columns - 21 - pill.text.length - (look.isTerminal ? 4 : 8)
  return (
    <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
      <Box flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
        {mark}
        <Text>
          <Text bold>Claude </Text>
          <Text bold italic color="claude">
            Mods
          </Text>
          <Text dimColor> · Hub</Text>
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={2} flexShrink={1} minWidth={0} justifyContent="flex-end" alignItems="center">
        {look.isNarrow || countsRoom < 12 ? null : (
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {fit(headerCounts(mem.installed, mem.tabs, mem.channels), countsRoom)}
            </Text>
          </Box>
        )}
        {look.pill(pill.text, pill.tone)}
      </Box>
    </Box>
  )
}

/**
 * The tab bar. Row one: Home and the first nine tabs, each with its digit (the contract's `0`–`9`), wrapping only
 * when the pane is too narrow for them. The rest: a More menu on the desktop and in the editor; on the terminal a
 * dim second row of what fits (the shown tab always among them) and `+N more ▾` that unfolds the others; on the
 * phone, which draws no menu, a `More ▾` fold. A hairline under it on the terminal.
 */
function drawTabBar($: EngineInterface, e: RenderInput<'Pane'>, look: Look, tabs: readonly ModsTab[], current: ModsTab | undefined, view: ModsPanelView): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const Select = e.surface === 'desktop' || e.surface === 'vscode' ? $.ui.resolve(e).Select : undefined
  const labelOf = (tab: { title: string; owner: string }): string => (look.isTerminal ? `${glyphOf(categoryOf(tab.owner))} ${tab.title}` : tab.title)
  const layout = tabLayout(tabs, { currentId: current?.id, columns: look.columns - 2, isRow: look.isTerminal, labelOf })
  const tabButton = (key: string, id: string, tab: { title: string; owner: string }, hotkey: string | undefined, isActive: boolean): RenderElement => (
    <Box key={`slot-${key}`} flexDirection="row" columnGap={look.isTerminal ? 0 : 1} flexShrink={0} alignItems="center">
      {look.isTerminal ? null : look.icon(categoryOf(tab.owner))}
      <Button
        key={key}
        plain
        {...(hotkey === undefined ? {} : { hotkey })}
        dimColor={!isActive}
        variant={isActive ? 'primary' : 'secondary'}
        label={labelOf(tab)}
        onPress={() => showTabFromPanel($, id)}
      />
    </Box>
  )
  const overflowButton = (tab: ModsTab): RenderElement => tabButton(`tab-${tab.id}`, tab.id, tab, undefined, tab.id === current?.id)
  const isCurrentHidden = current !== undefined && layout.overflow.includes(current)

  let more: RenderElement | null = null
  let second: RenderElement | null = null
  if (layout.overflow.length > 0 && Select !== undefined) {
    more = (
      <Box key="slot-tab-more" flexShrink={0}>
        <Select
          key="tab-more"
          options={[{ value: MORE_VALUE, label: `More · ${layout.overflow.length}` }, ...layout.overflow.map(tab => ({ value: tab.id, label: tab.title }))]}
          value={isCurrentHidden ? current.id : MORE_VALUE}
          onSelect={value => (value === MORE_VALUE ? undefined : showTabFromPanel($, value))}
        />
      </Box>
    )
  } else if (layout.overflow.length > 0 && look.isTerminal) {
    const rest = view.isMoreOpen ? layout.hidden : []
    second = (
      <Box key="tabs-more" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {[...layout.shown, ...rest].map(overflowButton)}
        {layout.hidden.length === 0 ? null : (
          <Button key="tab-more" plain dimColor label={view.isMoreOpen ? 'less ▴' : `+${layout.hidden.length} more ▾`} onPress={() => foldMore($, !view.isMoreOpen)} />
        )}
      </Box>
    )
  } else if (layout.overflow.length > 0) {
    more = (
      <Button
        key="tab-more"
        plain
        dimColor={!isCurrentHidden}
        label={view.isMoreOpen ? 'Less ▴' : isCurrentHidden ? `${current.title} ▾` : `More · ${layout.overflow.length} ▾`}
        onPress={() => foldMore($, !view.isMoreOpen)}
      />
    )
    second = view.isMoreOpen ? (
      <Box key="tabs-more" flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
        {layout.overflow.map(overflowButton)}
      </Box>
    ) : null
  }
  return (
    <Box key="tab-bar" flexDirection="column">
      <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {tabButton('tab-home', HOME, { title: 'Home', owner: 'mods-hub' }, '0', current === undefined)}
        {layout.pinned.map((tab, index) => tabButton(`tab-${tab.id}`, tab.id, tab, String(index + 1), tab.id === current?.id))}
        {more}
      </Box>
      {second}
      {look.isTerminal ? <Text dimColor>{'─'.repeat(Math.min(look.columns, 160))}</Text> : null}
    </Box>
  )
}

/** One segmented control: the label column, then one button per value, the current one the primary. */
function segmented<T extends string>(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  look: Look,
  input: { key: string; label: string; aside?: string; values: readonly { value: T; label: string }[]; current: T; onPick: (value: T) => Promise<unknown> },
): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const buttons = input.values.reduce((sum, one) => sum + one.label.length + 5, 0)
  return (
    <Box key={`seg-${input.key}`} flexDirection="row" columnGap={1} alignItems="center">
      <Box width={LABEL_COLUMNS} flexShrink={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {fit(input.label, LABEL_COLUMNS)}
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={1} minWidth={0} alignItems="center">
        {input.values.map(one => (
          <Button
            key={`${input.key}-${one.value}`}
            label={one.label}
            dimColor={one.value !== input.current}
            variant={one.value === input.current ? 'primary' : 'secondary'}
            onPress={() => (one.value === input.current ? undefined : input.onPick(one.value))}
          />
        ))}
        {input.aside === undefined ? null : (
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {fit(input.aside, look.columns - LABEL_COLUMNS - buttons - 2)}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/**
 * One channel: the dot and the name in the label column, its state in two words, then Set up (when it is not set
 * up or failing) and an On/Off switch drawn like the mode's segments. Under it, in the same column as the state, the
 * owner's hint, dim, wrapped to two lines at most; Set up opens the owner's tab in this panel, or, when the owner
 * has none, unfolds the whole hint with where its options live.
 */
function drawChannel($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime, look: Look, channel: ModsChannel, input: { isOn: boolean; isOpen: boolean; setupTab: ModsTab | undefined }): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const state = CHANNEL_STATUS[channel.status]
  const isSetup = needsSetup(channel.status)
  const hasHint = channel.detail !== undefined && channel.detail !== '' && channel.status !== 'connected'
  const room = look.columns - LABEL_COLUMNS - 1
  // Too narrow for the state and the controls side by side (a phone): the controls go on a row of their own.
  const controlsWidth = isSetup ? CHANNEL_CONTROLS : CHANNEL_SWITCH
  const isStacked = room - controlsWidth < 12
  const stateText = `${state.text}${channel.audience === 'team' ? ' · team' : ''}${!hasHint && channel.detail !== undefined && channel.detail !== '' ? ` · ${channel.detail}` : ''}`
  const switchButton = (value: 'on' | 'off'): RenderElement => {
    const isCurrent = (value === 'on') === input.isOn
    return (
      <Button
        key={`channel-${channel.id}-${value}`}
        label={value === 'on' ? 'On' : 'Off'}
        dimColor={!isCurrent}
        variant={isCurrent ? 'primary' : 'secondary'}
        onPress={() => (isCurrent ? undefined : toggleChannel($, rt, channel.id))}
      />
    )
  }
  const controls = (
    <Box flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
      {isSetup ? (
        <Button
          key={`setup-${channel.id}`}
          label={input.isOpen ? 'Hide' : 'Set up'}
          variant={input.isOpen ? 'secondary' : 'primary'}
          onPress={() => setUpChannel($, channel.id, input.setupTab?.id)}
        />
      ) : null}
      {switchButton('on')}
      {switchButton('off')}
    </Box>
  )
  return (
    <Box key={`channel-${channel.id}`} flexDirection="column">
      <Box key={`channel-row-${channel.id}`} flexDirection="row" columnGap={1} alignItems="center">
        <Box width={LABEL_COLUMNS} flexShrink={0} flexDirection="row" columnGap={1} alignItems="center" overflow="hidden">
          <Box key={`dot-${channel.id}`} width={1} flexShrink={0} alignItems="center">
            {look.dot(channel.status)}
          </Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text wrap="truncate-end" dimColor={!input.isOn}>
              {fit(channel.title, LABEL_COLUMNS - 2)}
            </Text>
          </Box>
        </Box>
        {look.line(stateText, isStacked ? room : room - controlsWidth, { color: state.tone })}
        {isStacked ? null : controls}
      </Box>
      {isStacked ? (
        <Box key={`controls-${channel.id}`} flexDirection="row" paddingLeft={LABEL_COLUMNS + 1}>
          {controls}
        </Box>
      ) : null}
      {hasHint ? (
        <Box key={`hint-${channel.id}`} flexDirection="column" paddingLeft={LABEL_COLUMNS + 1} minWidth={0}>
          <Text dimColor wrap="wrap">
            {input.isOpen ? (channel.detail ?? '').replace(/\s+/g, ' ') : fit(channel.detail ?? '', 2 * room - 12)}
          </Text>
          {input.isOpen ? (
            <Text dimColor wrap="wrap">
              {`Its options: /plugin, then ${channel.owner}.`}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

async function drawHome($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime, look: Look): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [mode, prefs, channels, tabs, inbox, installed, control, view, now] = await Promise.all([
    read($, modeAtom),
    read($, prefsAtom),
    read($, channelsAtom),
    read($, tabsAtom),
    read($, inboxAtom),
    read($, installedAtom),
    read($, controlAtom),
    read($, viewAtom),
    $.clock.now(),
  ])
  const work = controlLine(control)
  const counts = modCounts(installed)
  const width = look.columns
  // The feed fills what is left of the pane; never fewer than three rows.
  const room = Math.max(3, (e.props.scroll.bodyRows || 24) - 22 - channels.length * 2)
  const badgeColumns = look.isNarrow ? 10 : BADGE_COLUMNS

  const modeCard = (
    <Box key="card-mode" flexDirection="column">
      {look.kicker('Mode', describeMode(mode, now))}
      {segmented($, e, look, {
        key: 'presence',
        label: 'Presence',
        values: [
          { value: 'here', label: 'Here' },
          { value: 'away', label: 'Away' },
        ],
        current: mode.presence === 'away' ? 'away' : 'here',
        onPick: value => setPresenceFromPanel($, rt, value),
      })}
      {segmented($, e, look, {
        key: 'interaction',
        label: 'Interaction',
        values: [
          { value: 'auto', label: 'Auto' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
        current: prefs.interaction,
        onPick: value => setFromPanel($, rt, current => ({ ...current, interaction: value })),
      })}
      {segmented($, e, look, {
        key: 'silent',
        label: 'Silent',
        values: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: mode.isSilent && mode.silentUntil !== null ? `On · ${Math.max(1, Math.ceil((mode.silentUntil - now) / MINUTE_MS))}m` : 'On' },
        ],
        current: mode.isSilent ? 'on' : 'off',
        onPick: value => setFromPanel($, rt, current => ({ ...current, isSilent: value === 'on', silentUntil: null })),
      })}
      {segmented($, e, look, {
        key: 'night',
        label: 'Night',
        aside: prefs.quietHours,
        values: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
        current: prefs.isNightOn ? 'on' : 'off',
        onPick: value => setFromPanel($, rt, current => ({ ...current, isNightOn: value === 'on' })),
      })}
    </Box>
  )

  // The control strip: one line, the same height whether the work runs or is held.
  const controlStrip = (
    <Box key="control" flexDirection="row" columnGap={1} alignItems="center">
      {look.line(work.isHalted ? work.text : `● ${work.text}`, width - (work.isHalted ? 12 : 20), { color: work.tone })}
      {work.isHalted && control !== null ? (
        <Box flexShrink={0}>
          <Button key="resume" label="Resume" variant="primary" onPress={() => resumeFromPanel($, rt, control.scope)} />
        </Box>
      ) : (
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Button key="control-pause" label="Pause" dimColor onPress={() => holdFromPanel($, rt, 'pause')} />
          <Button key="control-stop" label="Stop" dimColor onPress={() => holdFromPanel($, rt, 'stop')} />
        </Box>
      )}
    </Box>
  )

  const channelsCard = (
    <Box key="card-channels" flexDirection="column">
      {look.kicker('Channels', channels.length === 0 ? undefined : `${channels.filter(channel => channel.status === 'connected').length}/${channels.length} connected`)}
      {channels.length === 0 ? (
        <Text dimColor wrap="wrap">
          No channels yet: whatsapp-bridge, telegram-bridge, slack-bridge or desktop-notify reach you away from the terminal.
        </Text>
      ) : (
        <Box key="channel-rows" flexDirection="column" rowGap={look.isTerminal ? 0 : 1}>
          {channels.map(channel =>
            drawChannel($, e, rt, look, channel, {
              isOn: prefs.channels[channel.id]?.isEnabled !== false,
              isOpen: view.openChannel === channel.id,
              setupTab: tabs.find(tab => tab.owner === channel.owner),
            }),
          )}
        </Box>
      )}
    </Box>
  )

  const routingCard = (
    <Box key="card-routing" flexDirection="column">
      {look.kicker('Routing', 'where each level goes')}
      <Box key="routes" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {LEVELS.map(level => (
          <Button key={`route-${level}`} label={`${GLYPH[level]} ${level}: ${ROUTE_LABEL[prefs.routes[level]] ?? prefs.routes[level]}`} onPress={() => cycleRoute($, rt, level)} />
        ))}
      </Box>
    </Box>
  )

  const modsCard = (
    <Box key="card-mods" flexDirection="column">
      {look.kicker('Mods')}
      <Box flexDirection="row" minWidth={0}>
        {look.line(
          installed.listedAt === null && counts.onBus === 0
            ? 'Listing the installed mods…'
            : `${plural(counts.installed, 'Claude Mod')} installed${counts.isListed ? ` · ${counts.enabled} enabled` : ''} · ${counts.onBus} on the bus`,
          width,
          { dimColor: true },
        )}
      </Box>
    </Box>
  )

  const feed = inbox.slice(-room).reverse()
  // when (3) · glyph (1) · badge, then the text; the destination (at most 22) on wide panes.
  const textRoom = width - 3 - 1 - badgeColumns - 3
  const feedCard = (
    <Box key="card-recent" flexDirection="column">
      {look.kicker('Recent', inbox.length === 0 ? undefined : `${inbox.length} kept`)}
      {feed.length === 0 ? (
        <Text dimColor wrap="wrap">
          Nothing yet. Notifications and other mods' toasts land here.
        </Text>
      ) : (
        feed.map(notice => {
          const row = feedRow(notice, now)
          const where = row.where === '' || look.isNarrow ? '' : fit(row.where, 22)
          return (
            <Box key={`n-${notice.id}`} flexDirection="row" columnGap={1} minWidth={0}>
              <Box width={3} flexShrink={0}>
                <Text dimColor>{row.when}</Text>
              </Box>
              <Box width={1} flexShrink={0}>
                <Text color={row.tone}>{row.glyph}</Text>
              </Box>
              <Box width={badgeColumns} flexShrink={0} overflow="hidden">
                <Text color="claude" dimColor wrap="truncate-end">
                  {badge(row.source, badgeColumns)}
                </Text>
              </Box>
              {look.line(row.text, textRoom - (where === '' ? 0 : where.length + 1), { dimColor: notice.targets.length === 0 })}
              {where === '' ? null : (
                <Box flexShrink={0}>
                  <Text dimColor>{where}</Text>
                </Box>
              )}
            </Box>
          )
        })
      )}
    </Box>
  )

  return (
    <Box key="home" flexDirection="column" rowGap={1} minWidth={0}>
      {modeCard}
      {controlStrip}
      {channelsCard}
      {routingCard}
      {modsCard}
      {feedCard}
    </Box>
  )
}

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, next: (e: RenderInput<'Pane'>) => Promise<RenderElement>, rt: Runtime): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const look = kit($, e)
  const [active, registered, mode, installed, channels, view, now] = await Promise.all([
    read($, tabAtom),
    read($, tabsAtom),
    read($, modeAtom),
    read($, installedAtom),
    read($, channelsAtom),
    read($, viewAtom),
    $.clock.now(),
  ])
  const tabs = [...registered].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  const current = tabs.find(tab => tab.id === active)
  const frame = (
    <Box key="frame" flexDirection="column" rowGap={look.isTerminal ? 0 : 1}>
      {drawHeader($, e, look, { mode, installed, tabs, channels }, now)}
      {drawTabBar($, e, look, tabs, current, view)}
    </Box>
  )
  if (current === undefined) {
    return (
      <Box flexDirection="column" rowGap={1} minWidth={0}>
        {frame}
        {await drawHome($, e, rt, look)}
      </Box>
    )
  }
  // A registered tab: its owner draws the body by hooking this same pane (see MOD_CONTRACT.md); whatever the hooks
  // beneath the hub drew comes back from `next`. Never under a sized Box: the owner sizes its own body.
  let body: RenderElement | undefined
  try {
    body = await next(e)
  } catch {
    body = undefined
  }
  if (isEmptyTree(body)) body = undefined
  return (
    <Box flexDirection="column" rowGap={1} minWidth={0}>
      {frame}
      <Box key="tab-title" flexDirection="row" columnGap={1} alignItems="center" minWidth={0}>
        {look.icon(categoryOf(current.owner))}
        <Box flexShrink={0}>
          <Text bold>{current.title}</Text>
        </Box>
        {look.line(`by ${current.owner}${current.command === undefined ? '' : ` · full view: /${current.command}`}`, look.columns - current.title.length - 4, { dimColor: true })}
      </Box>
      <Box key="tab-body" flexDirection="column">
        {body ?? (
          <Box flexDirection="column">
            <Text dimColor>{`${current.title} has nothing to show here yet.`}</Text>
            {current.command === undefined ? null : <Text dimColor>{`/${current.command} opens it.`}</Text>}
          </Box>
        )}
      </Box>
    </Box>
  )
}

/** Whether what came back from beneath draws nothing: no tree, or a bare Box with no children. */
function isEmptyTree(tree: RenderElement | undefined): boolean {
  if (tree === undefined || tree === null) return true
  const node = tree as unknown as { type?: unknown; children?: unknown }
  return node.type === 'Box' && (!Array.isArray(node.children) || node.children.length === 0)
}

// Button handlers: each is the person at the keyboard (activity), then a change written through changePrefs.
async function setFromPanel($: EngineInterface, rt: Runtime, change: (prefs: ModsPrefs) => ModsPrefs): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, change)
}

async function setPresenceFromPanel($: EngineInterface, rt: Runtime, presence: 'here' | 'away'): Promise<void> {
  if (presence === 'here') {
    await noteActivity($, rt)
    await changePrefs($, rt, prefs => ({ ...prefs, presence: 'auto' }))
  } else {
    await changePrefs($, rt, prefs => ({ ...prefs, presence: 'away' }))
  }
}

async function resumeFromPanel($: EngineInterface, rt: Runtime, scope: ModsControlScope): Promise<void> {
  await noteActivity($, rt)
  await raiseControl($, rt, { action: 'resume', scope, reason: 'Resume in the Claude Mods panel', by: 'you, at the terminal' }, 'mods-hub')
}

async function holdFromPanel($: EngineInterface, rt: Runtime, action: 'pause' | 'stop'): Promise<void> {
  await noteActivity($, rt)
  await raiseControl($, rt, { action, scope: 'session', reason: `${action === 'stop' ? 'Stop' : 'Pause'} in the Claude Mods panel`, by: 'you, at the terminal' }, 'mods-hub')
}

async function cycleRoute($: EngineInterface, rt: Runtime, level: ModsLevel): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => ({ ...prefs, routes: { ...prefs.routes, [level]: cycle(ROUTES, prefs.routes[level]) } }))
}

/** A tab press: show that tab, and fold the More row and any open channel help away. */
async function showTabFromPanel($: EngineInterface, id: string): Promise<void> {
  await $.state.set({ plugin: 'mods-hub', key: 'view' }, CLOSED_VIEW)
  await $.state.set({ plugin: 'mods-hub', key: 'tab' }, id)
}

async function foldMore($: EngineInterface, isOpen: boolean): Promise<void> {
  await update($, viewAtom, view => ({ ...view, isMoreOpen: isOpen }))
}

/** Set up: the channel owner's own tab when it has one, else the channel's whole hint unfolds (pressed again, folds). */
async function setUpChannel($: EngineInterface, id: string, tabId: string | undefined): Promise<void> {
  if (tabId !== undefined) {
    await showTabFromPanel($, tabId)
    return
  }
  await update($, viewAtom, view => ({ ...view, openChannel: view.openChannel === id ? null : id }))
}

async function toggleChannel($: EngineInterface, rt: Runtime, id: string): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => {
    const setting = prefs.channels[id] ?? { isEnabled: true, minLevel: 'info' as const }
    return { ...prefs, channels: { ...prefs.channels, [id]: { ...setting, isEnabled: !setting.isEnabled } } }
  })
}

// ── Session lifecycle ───────────────────────────────────────────────────────────────────────────────

async function startSession($: EngineInterface, rt: Runtime): Promise<void> {
  await ready($, rt)
  const now = await $.clock.now()
  rt.startedAt = now
  rt.lastActivityAt = now
  rt.presenceSince = now
  rt.sessionId = await $.session.id()
  rt.cwd = await $.session.cwd()
  const root = (await $.session.repo())?.root ?? rt.cwd
  rt.project = root.slice(root.lastIndexOf('/') + 1) || root
  const home = await $.env.get('HOME')
  rt.dir = home === undefined || home === '' ? '' : `${home}/${HUB_DIR}`
  // Small reads only (its own prefs and activity files); the mode, the bus and the listing wait for afterStart, so
  // ~200 mods' session.start chain never waits on the hub (scripts/check-startup.mjs).
  await loadShared($, rt)
  await registerCommand($, {
    name: 'hub',
    description: 'Opens the Claude Mods panel (Home: mode, channels, routing, mods); with a word, sets silent, night, away, interaction or a route.',
    argumentHint: '[status | silent [min|off] | night [on|off|22:00-07:00] | away | back | interaction auto|on|off | route <level> <where> | tab <id> | test]',
  })
  rt.timer?.cancel()
  rt.timer = $.clock.every(TICK_MS, () => void tick($, rt))
  rt.controlFloor = now
  rt.controlTimer?.cancel()
  rt.controlTimer = $.clock.every(CONTROL_POLL_MS, () => void pollControls($, rt))
  $.clock.after(0, () => void afterStart($, rt))
}

async function afterStart($: EngineInterface, rt: Runtime): Promise<void> {
  await refreshMode($, rt, 'activity')
  if (rt.options.sensors) await publishSelf($, rt, { topic: 'session.started', data: { project: rt.project, cwd: rt.cwd }, scope: 'global' })
  await heartbeat($, rt)
  refreshInstalled($, rt, await $.clock.now())
  await rt.listing
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is logged, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`mods-hub: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// ── Registration ────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const rt = newRuntime({
    idleMs: Math.max(1, Number(options.idleMinutes ?? 10)) * MINUTE_MS,
    awayMs: Math.max(1, Number(options.awayMinutes ?? 30)) * MINUTE_MS,
    sensors: options.sensors !== false,
    captureToasts: options.captureToasts !== false,
  })

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, mods: BOTTOM }
  })

  // ── $.mods: the hub's answers ──
  // Every answer comes from memory: no state read-modify-write and no file read per call, so a burst of hundreds of
  // calls (every mod's session.start after a reload) is answered at once. A hook that fails anyway answers from
  // memory in its `.catch` rather than leaving the caller with nothing.
  on('mods.publish', async ($, e, next) => {
    // The hub's own events are recorded by publishSelf.
    if (next.origin.plugin === 'mods-hub') return next(e)
    if (e.topic.startsWith('control.')) return { deny: 'mods-hub: control.* events are raised by $.mods.stop({ action, scope, reason }), not published' }
    const problem = problemWith(e.topic, e.data)
    if (problem !== undefined) return { deny: `mods-hub: ${problem}` }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    await ready($, rt)
    const event = await record($, rt, e, next.origin.plugin)
    return { value: { id: event.id } }
  })
  on('mods.recent', async ($, e) => {
    await ready($, rt)
    return { value: recentEvents(rt, e) }
  }).catch(($, e) => ({ value: recentEvents(rt, e) }))
  on('mods.latest', async ($, e) => {
    await ready($, rt)
    const kept = rt.latest.get(e.topic)
    if (kept !== undefined) return { value: kept }
    // An event an earlier load recorded: state outlives a reload, the map does not.
    return { value: (await $.state.get({ ...LATEST, id: e.topic })).value ?? null }
  }).catch(($, e) => ({ value: rt.latest.get(e.topic) ?? null }))
  on('mods.notify', async ($, e, next) => {
    const problem = problemWithNotice(e)
    if (problem !== undefined) return { deny: `mods-hub: ${problem}` }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    await ready($, rt)
    return { value: await dispatch($, rt, e, next.origin.plugin) }
  })
  on('mods.mode', async $ => {
    await ready($, rt)
    // Recomputed at most once a second however many mods ask; the tick, every activity and every change of the
    // prefs recompute it too, so the answer from memory is never staler than that.
    if (Date.now() - rt.modeComputedAt < MODE_FRESH_MS) return { value: rt.mem.mode }
    return { value: await refreshMode($, rt, 'timer') }
  }).catch(() => ({ value: rt.mem.mode }))
  on('mods.setMode', async ($, e) => {
    await ready($, rt)
    const now = await $.clock.now()
    const mode = await changePrefs($, rt, prefs => ({
      ...prefs,
      ...(e.interaction === undefined ? {} : { interaction: e.interaction }),
      ...(e.isNightOn === undefined ? {} : { isNightOn: e.isNightOn }),
      ...(e.quietHours === undefined ? {} : { quietHours: e.quietHours }),
      ...(e.isSilent === false
        ? { isSilent: false, silentUntil: null }
        : e.isSilent === true
          ? { isSilent: true, silentUntil: typeof e.silentMinutes === 'number' && e.silentMinutes > 0 ? now + e.silentMinutes * MINUTE_MS : null }
          : e.silentMinutes === undefined
            ? {}
            : e.silentMinutes === null || e.silentMinutes <= 0
              ? { isSilent: false, silentUntil: null }
              : { isSilent: true, silentUntil: now + e.silentMinutes * MINUTE_MS }),
    }))
    return { value: mode }
  })
  on('mods.setPresence', async ($, e) => {
    await ready($, rt)
    if (e.presence === 'here' || e.presence === 'auto') rt.lastActivityAt = await $.clock.now()
    const mode = await changePrefs($, rt, prefs => ({ ...prefs, presence: e.presence === 'here' ? 'auto' : e.presence }))
    return { value: mode }
  })
  on('mods.registerTab', async ($, e, next) => {
    if (!TAB_ID.test(e.id) || e.id === HOME) return { deny: `mods-hub: a tab id is 1-32 of a-z, 0-9 and -, and not "home"` }
    await ready($, rt)
    const owner = next.origin.plugin
    const tab: ModsTab = { id: e.id, title: oneLine(e.title, 24) || e.id, owner, order: e.order ?? 50, ...(e.command === undefined ? {} : { command: e.command }) }
    const taken = rt.mem.tabs.find(one => one.id === e.id && one.owner !== owner)
    if (taken !== undefined) return { deny: `mods-hub: tab "${e.id}" belongs to ${taken.owner}` }
    const tabs = remember($, rt, 'tabs', [...rt.mem.tabs.filter(one => one.id !== e.id), tab])
    return { value: { tabs } }
  })
  on('mods.showTab', async ($, e) => {
    await ready($, rt)
    if (e.id !== HOME && !rt.mem.tabs.some(tab => tab.id === e.id)) return { deny: `mods-hub: no tab "${e.id}"` }
    return { value: { isPlaced: await openPanel($, rt, e.id) } }
  })
  on('mods.registerChannel', async ($, e, next) => {
    if (!CHANNEL_ID.test(e.id)) return { deny: 'mods-hub: a channel id is 1-32 of a-z, 0-9 and -' }
    await ready($, rt)
    const owner = next.origin.plugin
    const taken = rt.mem.channels.find(one => one.id === e.id && one.owner !== owner)
    if (taken !== undefined) return { deny: `mods-hub: channel "${e.id}" belongs to ${taken.owner}` }
    const channel: ModsChannel = {
      ...e,
      title: oneLine(e.title, 32) || e.id,
      owner,
      ...(e.detail === undefined ? {} : { detail: fit(e.detail, MAX_CHANNEL_DETAIL) }),
    }
    const channels = remember($, rt, 'channels', [...rt.mem.channels.filter(one => one.id !== e.id), channel])
    return { value: { channels } }
  })
  on('mods.channelStatus', async ($, e, next) => {
    await ready($, rt)
    const channel = rt.mem.channels.find(one => one.id === e.id)
    if (channel === undefined || channel.owner !== next.origin.plugin) return { deny: `mods-hub: no channel "${e.id}" of yours` }
    const channels = remember(
      $,
      rt,
      'channels',
      rt.mem.channels.map(one => (one.id === e.id ? { ...one, status: e.status, ...(e.detail === undefined ? {} : { detail: fit(e.detail, MAX_CHANNEL_DETAIL) }) } : one)),
    )
    return { value: { channels } }
  })
  on('mods.drain', async ($, e, next) => {
    await ready($, rt)
    const channel = rt.mem.channels.find(one => one.id === e.channel)
    if (channel === undefined || channel.owner !== next.origin.plugin) return { deny: `mods-hub: no channel "${e.channel}" of yours` }
    if (e.after !== undefined && e.after !== null && typeof e.after !== 'string') return { deny: 'mods-hub: after is the id of the last notice you handled, or null' }
    return { value: await drainOutbox($, rt, e) }
  })
  on('mods.stop', async ($, e, next) => {
    const problem = problemWithStop(e)
    if (problem !== undefined) return { deny: `mods-hub: ${problem}` }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    await ready($, rt)
    return { value: await raiseControl($, rt, e, next.origin.plugin) }
  })
  on('mods.hello', async ($, e, next) => {
    await ready($, rt)
    const name = next.origin.plugin
    const hello = { name, version: String(e.version), publishes: [...(e.publishes ?? [])], consumes: [...(e.consumes ?? [])] }
    const installed = remember($, rt, 'installed', { ...rt.mem.installed, hello: [...rt.mem.installed.hello.filter(one => one.name !== name), hello] })
    return { value: { installed } }
  }).catch(() => ({ value: { installed: rt.mem.installed } }))
  on('mods.installed', async $ => {
    await ready($, rt)
    refreshInstalled($, rt, await $.clock.now())
    return { value: rt.mem.installed }
  }).catch(() => ({ value: rt.mem.installed }))
  on('mods.share', async ($, e, next) => {
    if (!FACT_NAME.test(e.name)) return { deny: 'mods-hub: a fact name is 1-64 of a-z, 0-9, ., _ and -' }
    if (JSON.stringify(e.value ?? null).length > MAX_FACT_CHARS) return { deny: `mods-hub: a fact holds at most ${MAX_FACT_CHARS} characters of JSON` }
    const owner = next.origin.plugin
    const fact: ModsFact = { key: `${owner}.${e.name}`, owner, value: asJson(e.value), at: await $.clock.now() }
    await $.state.set({ ...FACTS, id: fact.key }, fact)
    return { value: fact }
  })
  on('mods.read', async ($, e) => ({ value: (await $.state.get({ ...FACTS, id: e.key })).value ?? null }))

  // ── The session ──
  on('session.start', async ($, e, next) => {
    await startSession($, rt)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    rt.timer?.cancel()
    rt.controlTimer?.cancel()
    if (rt.options.sensors) {
      const now = await $.clock.now()
      await publishSelf($, rt, { topic: 'session.ended', data: { durationMs: now - rt.startedAt, turns: rt.turns, usd: rt.sessionUsd }, scope: 'global' })
    }
    await heartbeat($, rt, true)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    const isPerson = PERSON_ORIGINS.has(e.origin.kind) || (e.origin.kind === 'plugin' && e.origin.asUser === true)
    if (isPerson) await noteActivity($, rt)
    rt.turnTools = 0
    return next(e)
  })
  on('command.run', { command: 'hub' }, async ($, e) => ({ text: await runHub($, rt, e.args) }))

  on('tool.call', async ($, e, next) => {
    rt.turnTools += 1
    if (!rt.options.sensors || e.tool !== 'Bash') return next(e)
    const started = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const durationMs = (await $.clock.now()) - started
    const command = e.command
    const output = bashOutput(ran)
    const hasFailed = ran.isError === true
    $.clock.after(0, () => void observeBash($, rt, command, output, hasFailed, durationMs))
    return ran
  })
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      rt.turns += 1
      const usage = e.usage
      if (rt.options.sensors && usage !== undefined) $.clock.after(0, () => void observeTurn($, rt, usage, e.durationMs, e.isAborted))
    }
    return ran
  })
  on('session.measure', async ($, e, next) => {
    const percent = e.context.percent
    if (rt.options.sensors && typeof percent === 'number') {
      const step = CONTEXT_STEPS.filter(threshold => percent >= threshold).length
      if (step > rt.contextStep) {
        await publishSelf($, rt, { topic: 'context.pressure', data: { percent, tokens: e.context.tokens ?? 0, window: e.context.window ?? 0 } })
      }
      rt.contextStep = step
    }
    return next(e)
  })

  // ── Other mods' toasts and sounds: kept in Recent, held while Silent (and sounds at night) ──
  on('ui.toast', async ($, e, next) => {
    const origin = next.origin
    if (origin.tier !== 'user' || origin.plugin === 'mods-hub' || !rt.options.captureToasts) return next(e)
    await ready($, rt)
    const mode = rt.mem.mode
    const now = await $.clock.now()
    rt.seq += 1
    addToInbox($, rt, {
      id: `t-${idTag(rt)}-${rt.seq}`,
      level: 'info',
      title: oneLine(e.text, 200),
      source: origin.plugin,
      at: now,
      targets: mode.isSilent ? [] : ['toast'],
      held: false,
      ...(mode.isSilent ? { reason: 'silent' } : {}),
    })
    return mode.isSilent ? { value: undefined } : next(e)
  })
  on('audio.play', async ($, e, next) => {
    const origin = next.origin
    await ready($, rt)
    const mode = rt.mem.mode
    return origin.tier === 'user' && origin.plugin !== 'mods-hub' && (mode.isSilent || mode.isNight) ? { value: undefined } : next(e)
  })
  on('audio.speak', async ($, e, next) => {
    const origin = next.origin
    await ready($, rt)
    const mode = rt.mem.mode
    return origin.tier === 'user' && origin.plugin !== 'mods-hub' && (mode.isSilent || mode.isNight) ? { value: { via: 'system' as const } } : next(e)
  })

  // ── The panel ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => drawPane($, e, next, rt))
}

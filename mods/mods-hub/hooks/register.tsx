import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type {
  Mods,
  ModsChannel,
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
  ModsPresenceReason,
  ModsPublishInput,
  ModsTab,
} from '../types'
import { problemWith, topicMatches } from './catalog'
import {
  DEFAULT_PREFS,
  GLYPH,
  HUB_USAGE,
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
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

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
  hello: async () => ({ installed: EMPTY_INSTALLED }),
  installed: async () => EMPTY_INSTALLED,
  share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
  read: async () => null,
}

// ── The per-load runtime ────────────────────────────────────────────────────────────────────────────

type Options = { idleMs: number; awayMs: number; sensors: boolean; captureToasts: boolean }

type Runtime = {
  options: Options
  sessionId: string
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
  outbox: Map<string, ModsNotice[]>
  globalFeed: ModsEvent[]
  lastHeartbeatAt: number
  timer: Timer | undefined
}

const newRuntime = (options: Options): Runtime => ({
  options,
  sessionId: '',
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
  outbox: new Map(),
  globalFeed: [],
  lastHeartbeatAt: 0,
  timer: undefined,
})

const minuteOfDay = (now: number): number => {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

const oneLine = (text: string, max = MAX_TEXT): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

const asJson = (value: unknown): ModsJson => JSON.parse(JSON.stringify(value ?? null)) as ModsJson

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

/** Reads prefs.json (another session may have changed it) and the shared last activity. */
async function loadShared($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.dir === '') return
  const prefs = sanitizePrefs(await readJsonFile($, `${rt.dir}/prefs.json`))
  const current = await read($, prefsAtom)
  if (JSON.stringify(current) !== JSON.stringify(prefs)) await update($, prefsAtom, () => prefs)
  const activity = (await readJsonFile($, `${rt.dir}/activity.json`)) as { at?: unknown } | undefined
  if (typeof activity?.at === 'number' && activity.at > rt.lastActivityAt) rt.lastActivityAt = activity.at
}

/** Changes the prefs every session shares, then recomputes the mode. */
async function changePrefs($: EngineInterface, rt: Runtime, change: (prefs: ModsPrefs) => ModsPrefs): Promise<ModsMode> {
  const next = sanitizePrefs(change(await read($, prefsAtom)))
  await update($, prefsAtom, () => next)
  if (rt.dir !== '') await writeJsonFile($, `${rt.dir}/prefs.json`, next)
  return refreshMode($, rt, 'manual')
}

/** This session's line in sessions.json: what mission-control and session-sync read. */
async function heartbeat($: EngineInterface, rt: Runtime, isEnding = false): Promise<void> {
  if (rt.dir === '' || rt.sessionId === '') return
  const now = await $.clock.now()
  rt.lastHeartbeatAt = now
  const path = `${rt.dir}/sessions.json`
  const raw = ((await readJsonFile($, path)) ?? {}) as Record<string, { lastSeen?: number }>
  const sessions: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry?.lastSeen === 'number' && now - entry.lastSeen < SESSION_STALE_MS && id !== rt.sessionId) sessions[id] = entry
  }
  if (!isEnding) {
    const mode = await read($, modeAtom)
    sessions[rt.sessionId] = {
      id: rt.sessionId,
      project: rt.project,
      cwd: rt.cwd,
      startedAt: rt.startedAt,
      lastSeen: now,
      presence: mode.presence,
      turns: rt.turns,
      usd: Math.round(rt.sessionUsd * 10_000) / 10_000,
      events: rt.globalFeed,
    }
  }
  await writeJsonFile($, path, sessions)
}

// ── Presence and the mode ───────────────────────────────────────────────────────────────────────────

/** Recomputes presence and the mode; a change of presence is published as session.idle / away / back. */
async function refreshMode($: EngineInterface, rt: Runtime, reason: ModsPresenceReason): Promise<ModsMode> {
  const now = await $.clock.now()
  const prefs = await read($, prefsAtom)
  const presence = presenceOf(prefs.presence, { lastActivityAt: rt.lastActivityAt, now, idleMs: rt.options.idleMs, awayMs: rt.options.awayMs })
  const mode = deriveMode(prefs, presence, now, minuteOfDay(now))
  await update($, modeAtom, () => mode)
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
  if (rt.wasNight && !mode.isNight) await sendDigest($, rt)
  rt.wasNight = mode.isNight
  return mode
}

/** The person did something: they are here, and a manual "away" ends. */
async function noteActivity($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  rt.lastActivityAt = now
  const prefs = await read($, prefsAtom)
  if (prefs.presence === 'away') {
    await changePrefs($, rt, current => ({ ...current, presence: 'auto' }))
  } else {
    await refreshMode($, rt, 'activity')
  }
  if (rt.dir !== '' && now - rt.lastActivityWrittenAt >= ACTIVITY_WRITE_MS) {
    rt.lastActivityWrittenAt = now
    await writeJsonFile($, `${rt.dir}/activity.json`, { at: now, session: rt.sessionId })
  }
}

/** Every 30 s: other sessions' prefs and activity, presence timers, silent's end, night's end, the heartbeat. */
async function tick($: EngineInterface, rt: Runtime): Promise<void> {
  await loadShared($, rt)
  const prefs = await read($, prefsAtom)
  const now = await $.clock.now()
  if (prefs.isSilent && prefs.silentUntil !== null && now >= prefs.silentUntil) {
    await changePrefs($, rt, current => ({ ...current, isSilent: false, silentUntil: null }))
    $.ui.toast('Silent is over: toasts and sounds are back.')
  } else {
    await refreshMode($, rt, 'timer')
  }
  if (now - rt.lastHeartbeatAt >= HEARTBEAT_MS) await heartbeat($, rt)
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
    id: `${rt.sessionId.slice(0, 8) || 'hub'}-${rt.seq}`,
    topic: input.topic,
    data: asJson(input.data),
    source,
    at: await $.clock.now(),
    session: rt.sessionId,
    scope: input.scope ?? 'session',
  }
  await update($, feedAtom, feed => [...feed, event].slice(-FEED_SIZE))
  await $.state.set({ ...LATEST, id: event.topic }, event)
  if (event.scope === 'global') rt.globalFeed = [...rt.globalFeed, event].slice(-GLOBAL_FEED_SIZE)
  return event
}

async function recentEvents($: EngineInterface, input: { topic?: string; prefix?: string; since?: number; limit?: number }): Promise<ModsEvent[]> {
  const feed = await read($, feedAtom)
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
  return undefined
}

async function addToInbox($: EngineInterface, notice: ModsNotice): Promise<void> {
  await update($, inboxAtom, inbox => [...inbox, notice].slice(-INBOX_SIZE))
}

/** Routes one notification: toast, channels (in the background), or held for the digest. */
async function dispatch($: EngineInterface, rt: Runtime, input: ModsNotifyInput, source: string): Promise<ModsNotifyResult> {
  const now = await $.clock.now()
  const key = `${source}|${input.level}|${input.title}`
  const seen = rt.recentNotices.get(key)
  for (const [old, at] of rt.recentNotices) if (now - at > DEDUPE_MS) rt.recentNotices.delete(old)
  rt.seq += 1
  const id = `n-${rt.sessionId.slice(0, 8) || 'hub'}-${rt.seq}`
  if (seen !== undefined && now - seen < DEDUPE_MS) return { id, targets: [], held: false, reason: 'a repeat of the last 30 seconds' }
  rt.recentNotices.set(key, now)

  const mode = await refreshMode($, rt, 'timer')
  const decision = route(input, mode, await read($, prefsAtom), await read($, channelsAtom))
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
  await addToInbox($, notice)
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
  const channels = await read($, channelsAtom)
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
    if (!isDelivered) rt.outbox.set(id, [...(rt.outbox.get(id) ?? []), safe].slice(-INBOX_SIZE))
  }
}

/** Night is over: what was held goes out as one digest to the person's channels. */
async function sendDigest($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.held.length === 0) return
  const held = rt.held
  rt.held = []
  const now = await $.clock.now()
  rt.seq += 1
  const digest: ModsNotice = {
    id: `d-${rt.seq}`,
    level: 'info',
    title: `${held.length} notification${held.length === 1 ? '' : 's'} overnight`,
    body: held.map(notice => `${GLYPH[notice.level]} ${notice.source}: ${notice.title}`).join('\n').slice(0, MAX_TEXT),
    source: 'mods-hub',
    at: now,
    targets: [],
    held: false,
  }
  const channels = (await read($, channelsAtom)).filter(channel => channel.audience === 'me' && channel.status !== 'unconfigured').map(channel => channel.id)
  await addToInbox($, { ...digest, targets: channels })
  if (channels.length > 0) await deliverAll($, rt, digest, channels)
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

/** `claude plugin list --json`, in the background; the Home tab shows what it found. */
async function listPlugins($: EngineInterface): Promise<void> {
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
    await update($, installedAtom, installed => ({ ...installed, plugins, listedAt: now }))
  } catch {
    // No `claude` on PATH, or an older CLI: the Home tab lists the mods that said hello.
  }
}

// ── The /hub command ────────────────────────────────────────────────────────────────────────────────

async function openPanel($: EngineInterface, tab: string): Promise<boolean> {
  await update($, tabAtom, () => tab)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  return opened.isPlaced
}

async function runHub($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  await noteActivity($, rt)
  const command = parseHubArgs(args)
  const now = await $.clock.now()
  switch (command.kind) {
    case 'open':
      return (await openPanel($, HOME)) ? 'Claude Mods panel opened.' : 'Claude Mods panel opened; widen the terminal to see it.'
    case 'status': {
      const mode = await refreshMode($, rt, 'timer')
      const channels = await read($, channelsAtom)
      const tabs = await read($, tabsAtom)
      return [
        `Mode: ${describeMode(mode, now)}`,
        `Channels: ${channels.length === 0 ? 'none registered' : channels.map(channel => `${channel.id} (${channel.status})`).join(', ')}`,
        `Tabs: ${['home', ...tabs.map(tab => tab.id)].join(', ')}`,
      ].join('\n')
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
      return command.isOn ? `Night mode on (${command.quietHours ?? (await read($, prefsAtom)).quietHours}).` : 'Night mode off.'
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
      const tabs = await read($, tabsAtom)
      if (command.id !== HOME && !tabs.some(tab => tab.id === command.id)) return `No tab "${command.id}". Tabs: ${['home', ...tabs.map(tab => tab.id)].join(', ')}.`
      await openPanel($, command.id)
      return `Showing ${command.id}.`
    }
    case 'test': {
      const result = await dispatch($, rt, { level: command.level, title: 'Test notification', body: 'Sent with /hub test' }, 'mods-hub')
      return `Routed to ${result.targets.length === 0 ? 'nowhere' : result.targets.join(', ')}${result.held ? ' (held for the morning digest)' : ''}${result.reason === undefined ? '' : ` — ${result.reason}`}.`
    }
    case 'error':
      return command.message === HUB_USAGE ? HUB_USAGE : `${command.message}\n${HUB_USAGE}`
  }
}

// ── The panel ───────────────────────────────────────────────────────────────────────────────────────

const ago = (ms: number): string => (ms < MINUTE_MS ? 'now' : ms < 60 * MINUTE_MS ? `${Math.floor(ms / MINUTE_MS)}m` : `${Math.floor(ms / (60 * MINUTE_MS))}h`)

const ROUTE_LABEL: Record<string, string> = { terminal: 'terminal', away: 'when away', always: 'always', off: 'off' }
const STATUS_GLYPH: Record<ModsChannel['status'], string> = { connected: '●', connecting: '◐', disconnected: '○', error: '✗', unconfigured: '·' }

async function drawHome($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const mode = await read($, modeAtom)
  const prefs = await read($, prefsAtom)
  const channels = await read($, channelsAtom)
  const inbox = await read($, inboxAtom)
  const installed = await read($, installedAtom)
  const tabs = await read($, tabsAtom)
  const now = await $.clock.now()
  const ours = installed.plugins.filter(plugin => plugin.marketplace === 'claude-mods')
  const room = Math.max(3, (e.props.scroll.bodyRows || 24) - 16)

  return (
    <Box key="home" flexDirection="column">
      <Text bold>Mode</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{describeMode(mode, now)}</Text>
      </Box>
      <Box key="mode-buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="interaction" label={`Interaction: ${prefs.interaction}`} onPress={() => cycleInteraction($, rt)} />
        <Button key="silent" label={mode.isSilent ? 'Silent: on' : 'Silent: off'} onPress={() => toggleSilent($, rt)} />
        <Button key="night" label={`Night ${prefs.quietHours}: ${prefs.isNightOn ? 'on' : 'off'}`} onPress={() => toggleNight($, rt)} />
        <Button key="presence" label={mode.presence === 'away' ? "I'm back" : "I'm away"} onPress={() => togglePresence($, rt)} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Channels</Text>
        {channels.length === 0 ? (
          <Text dimColor>No channel mods yet: install whatsapp-bridge, telegram-bridge, slack-bridge or desktop-notify to get notified away from the terminal.</Text>
        ) : (
          channels.map(channel => {
            const setting = prefs.channels[channel.id]
            const isOn = setting?.isEnabled !== false
            return (
              <Box key={`channel-${channel.id}`} flexDirection="row" columnGap={1}>
                <Text color={channel.status === 'connected' ? 'success' : channel.status === 'error' ? 'error' : 'subtle'}>{STATUS_GLYPH[channel.status]}</Text>
                <Text>{channel.title}</Text>
                <Text dimColor>
                  {channel.status}
                  {channel.detail === undefined ? '' : ` · ${channel.detail}`} · {channel.audience === 'team' ? 'team' : 'you'}
                </Text>
                <Button key={`toggle-${channel.id}`} plain label={isOn ? '[on]' : '[off]'} onPress={() => toggleChannel($, rt, channel.id)} />
              </Box>
            )
          })
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Routing</Text>
        <Box key="routes" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {LEVELS.map(level => (
            <Button key={`route-${level}`} label={`${GLYPH[level]} ${level}: ${ROUTE_LABEL[prefs.routes[level]] ?? prefs.routes[level]}`} onPress={() => cycleRoute($, rt, level)} />
          ))}
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Mods</Text>
        <Text dimColor wrap="truncate-end">
          {installed.listedAt === null ? 'Installed: (listing…)' : `Installed: ${ours.length} Claude Mods${ours.length > 0 ? ` (${ours.filter(plugin => plugin.isEnabled).length} enabled)` : ''}`}
          {` · on the bus: ${installed.hello.length === 0 ? 'none yet' : installed.hello.map(hello => hello.name).join(', ')}`}
          {tabs.length === 0 ? '' : ` · tabs: ${tabs.map(tab => tab.title).join(', ')}`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent</Text>
        {inbox.length === 0 ? (
          <Text dimColor>Nothing yet. Notifications and other mods' toasts land here.</Text>
        ) : (
          inbox
            .slice(-room)
            .reverse()
            .map(notice => (
              <Text key={`n-${notice.id}`} wrap="truncate-end" dimColor={notice.targets.length === 0}>
                {ago(now - notice.at).padStart(3)} {noticeLine(notice)}
                {notice.held ? ' · held' : notice.targets.some(target => target !== 'toast') ? ` → ${notice.targets.filter(target => target !== 'toast').join(', ')}` : ''}
              </Text>
            ))
        )}
      </Box>
    </Box>
  )
}

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, next: (e: RenderInput<'Pane'>) => Promise<RenderElement>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const active = await read($, tabAtom)
  const tabs = [...(await read($, tabsAtom))].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  const current = tabs.find(tab => tab.id === active)
  const strip = (
    <Box key="tabs" flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Button key="tab-home" hotkey="0" variant={current === undefined ? 'primary' : 'secondary'} label="Home" onPress={() => update($, tabAtom, () => HOME)} />
      {tabs.slice(0, 9).map((tab, index) => (
        <Button key={`tab-${tab.id}`} hotkey={String(index + 1)} variant={tab.id === current?.id ? 'primary' : 'secondary'} label={tab.title} onPress={() => update($, tabAtom, () => tab.id)} />
      ))}
    </Box>
  )
  if (current === undefined) {
    return (
      <Box flexDirection="column">
        {strip}
        <Box marginTop={1}>{await drawHome($, e, rt)}</Box>
      </Box>
    )
  }
  // A registered tab: its owner draws the body by hooking this same pane (see MOD_CONTRACT.md); whatever
  // the hooks beneath the hub drew comes back from `next`.
  let body: RenderElement | undefined
  try {
    body = await next(e)
  } catch {
    body = undefined
  }
  return (
    <Box flexDirection="column">
      {strip}
      {current.command === undefined ? null : <Text dimColor>{`${current.title} by ${current.owner} · full view: /${current.command}`}</Text>}
      <Box key="tab-body" marginTop={1} flexDirection="column">
        {body ?? <Text dimColor>{`${current.title} is not drawing here right now.`}</Text>}
      </Box>
    </Box>
  )
}

// Button handlers: each reads the prefs fresh and writes through changePrefs.
async function cycleInteraction($: EngineInterface, rt: Runtime): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => ({ ...prefs, interaction: cycle(INTERACTIONS, prefs.interaction) }))
}

async function toggleSilent($: EngineInterface, rt: Runtime): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => (prefs.isSilent ? { ...prefs, isSilent: false, silentUntil: null } : { ...prefs, isSilent: true, silentUntil: null }))
}

async function toggleNight($: EngineInterface, rt: Runtime): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => ({ ...prefs, isNightOn: !prefs.isNightOn }))
}

async function togglePresence($: EngineInterface, rt: Runtime): Promise<void> {
  const mode = await read($, modeAtom)
  if (mode.presence === 'away') {
    await noteActivity($, rt)
    await changePrefs($, rt, prefs => ({ ...prefs, presence: 'auto' }))
  } else {
    await changePrefs($, rt, prefs => ({ ...prefs, presence: 'away' }))
  }
}

async function cycleRoute($: EngineInterface, rt: Runtime, level: ModsLevel): Promise<void> {
  await noteActivity($, rt)
  await changePrefs($, rt, prefs => ({ ...prefs, routes: { ...prefs.routes, [level]: cycle(ROUTES, prefs.routes[level]) } }))
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
  await loadShared($, rt)
  await refreshMode($, rt, 'activity')
  await $.command.register({
    name: 'hub',
    description: 'Opens the Claude Mods panel (Home: mode, channels, routing, mods); with a word, sets silent, night, away, interaction or a route.',
    argumentHint: '[status | silent [min|off] | night [on|off|22:00-07:00] | away | back | interaction auto|on|off | route <level> <where> | tab <id> | test]',
  })
  rt.timer?.cancel()
  rt.timer = $.clock.every(TICK_MS, () => void tick($, rt))
  $.clock.after(0, () => void afterStart($, rt))
}

async function afterStart($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.options.sensors) await publishSelf($, rt, { topic: 'session.started', data: { project: rt.project, cwd: rt.cwd }, scope: 'global' })
  await heartbeat($, rt)
  const installed = await read($, installedAtom)
  const now = await $.clock.now()
  if (installed.listedAt === null || now - installed.listedAt > LIST_REFRESH_MS) await listPlugins($)
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
  on('mods.publish', async ($, e, next) => {
    // The hub's own events are recorded by publishSelf.
    if (next.origin.plugin === 'mods-hub') return next(e)
    const problem = problemWith(e.topic, e.data)
    if (problem !== undefined) return { deny: `mods-hub: ${problem}` }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const event = await record($, rt, e, next.origin.plugin)
    return { value: { id: event.id } }
  })
  on('mods.recent', async ($, e) => ({ value: await recentEvents($, e) }))
  on('mods.latest', async ($, e) => ({ value: (await $.state.get({ ...LATEST, id: e.topic })).value ?? null }))
  on('mods.notify', async ($, e, next) => {
    const problem = problemWithNotice(e)
    if (problem !== undefined) return { deny: `mods-hub: ${problem}` }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    return { value: await dispatch($, rt, e, next.origin.plugin) }
  })
  on('mods.mode', async $ => ({ value: await refreshMode($, rt, 'timer') }))
  on('mods.setMode', async ($, e) => {
    const now = await $.clock.now()
    const mode = await changePrefs($, rt, prefs => ({
      ...prefs,
      ...(e.interaction === undefined ? {} : { interaction: e.interaction }),
      ...(e.isNightOn === undefined ? {} : { isNightOn: e.isNightOn }),
      ...(e.quietHours === undefined ? {} : { quietHours: e.quietHours }),
      ...(e.silentMinutes === undefined
        ? {}
        : e.silentMinutes === null || e.silentMinutes <= 0
          ? { isSilent: false, silentUntil: null }
          : { isSilent: true, silentUntil: now + e.silentMinutes * MINUTE_MS }),
    }))
    return { value: mode }
  })
  on('mods.setPresence', async ($, e) => {
    if (e.presence === 'here' || e.presence === 'auto') rt.lastActivityAt = await $.clock.now()
    const mode = await changePrefs($, rt, prefs => ({ ...prefs, presence: e.presence === 'here' ? 'auto' : e.presence }))
    return { value: mode }
  })
  on('mods.registerTab', async ($, e, next) => {
    if (!TAB_ID.test(e.id) || e.id === HOME) return { deny: `mods-hub: a tab id is 1-32 of a-z, 0-9 and -, and not "home"` }
    const owner = next.origin.plugin
    const tab: ModsTab = { id: e.id, title: oneLine(e.title, 24) || e.id, owner, order: e.order ?? 50, ...(e.command === undefined ? {} : { command: e.command }) }
    const taken = (await read($, tabsAtom)).find(one => one.id === e.id && one.owner !== owner)
    if (taken !== undefined) return { deny: `mods-hub: tab "${e.id}" belongs to ${taken.owner}` }
    const tabs = await update($, tabsAtom, list => [...list.filter(one => one.id !== e.id), tab])
    return { value: { tabs } }
  })
  on('mods.showTab', async ($, e) => {
    const tabs = await read($, tabsAtom)
    if (e.id !== HOME && !tabs.some(tab => tab.id === e.id)) return { deny: `mods-hub: no tab "${e.id}"` }
    return { value: { isPlaced: await openPanel($, e.id) } }
  })
  on('mods.registerChannel', async ($, e, next) => {
    if (!CHANNEL_ID.test(e.id)) return { deny: 'mods-hub: a channel id is 1-32 of a-z, 0-9 and -' }
    const owner = next.origin.plugin
    const taken = (await read($, channelsAtom)).find(one => one.id === e.id && one.owner !== owner)
    if (taken !== undefined) return { deny: `mods-hub: channel "${e.id}" belongs to ${taken.owner}` }
    const channel: ModsChannel = { ...e, title: oneLine(e.title, 32) || e.id, owner }
    const channels = await update($, channelsAtom, list => [...list.filter(one => one.id !== e.id), channel])
    return { value: { channels } }
  })
  on('mods.channelStatus', async ($, e, next) => {
    const list = await read($, channelsAtom)
    const channel = list.find(one => one.id === e.id)
    if (channel === undefined || channel.owner !== next.origin.plugin) return { deny: `mods-hub: no channel "${e.id}" of yours` }
    const channels = await update($, channelsAtom, current =>
      current.map(one => (one.id === e.id ? { ...one, status: e.status, ...(e.detail === undefined ? {} : { detail: oneLine(e.detail, 80) }) } : one)),
    )
    return { value: { channels } }
  })
  on('mods.drain', async ($, e, next) => {
    const channel = (await read($, channelsAtom)).find(one => one.id === e.channel)
    if (channel === undefined || channel.owner !== next.origin.plugin) return { deny: `mods-hub: no channel "${e.channel}" of yours` }
    const waiting = rt.outbox.get(e.channel) ?? []
    rt.outbox.delete(e.channel)
    return { value: waiting }
  })
  on('mods.hello', async ($, e, next) => {
    const name = next.origin.plugin
    const hello = { name, version: String(e.version), publishes: [...(e.publishes ?? [])], consumes: [...(e.consumes ?? [])] }
    const installed = await update($, installedAtom, current => ({ ...current, hello: [...current.hello.filter(one => one.name !== name), hello] }))
    return { value: { installed } }
  })
  on('mods.installed', async $ => ({ value: await read($, installedAtom) }))
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
    const mode = await read($, modeAtom)
    const now = await $.clock.now()
    rt.seq += 1
    await addToInbox($, {
      id: `t-${rt.seq}`,
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
    const mode = await read($, modeAtom)
    return origin.tier === 'user' && origin.plugin !== 'mods-hub' && (mode.isSilent || mode.isNight) ? { value: undefined } : next(e)
  })
  on('audio.speak', async ($, e, next) => {
    const origin = next.origin
    const mode = await read($, modeAtom)
    return origin.tier === 'user' && origin.plugin !== 'mods-hub' && (mode.isSilent || mode.isNight) ? { value: { via: 'system' as const } } : next(e)
  })

  // ── The panel ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => drawPane($, e, next, rt))
}

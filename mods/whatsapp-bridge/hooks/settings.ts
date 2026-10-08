import type { WaEventKey, WaGroupScope, WaPhase, WaPrefs } from '../types'
import { canonicalOwner } from './inbound'

/** The userConfig values, cleaned and clamped. */
export type Settings = {
  baseUrl: string
  apiKey: string
  ownerNumbers: string[]
  extraChats: string[]
  autoCreateGroup: boolean
  awayMinutes: number
  quietHours: string
  interactionOffHours: string
  notifyMode: 'away' | 'always' | 'off'
  digestMinutes: number
  maxPerHour: number
  pin: string
  remoteApprovals: boolean
  longTurnMinutes: number
  budgetSteps: number[]
  briefingTime: string
  eveningTime: string
  memberTriggers: string[]
  /** all: in a linked project/session group every member message is for Claude; trigger: only with a trigger word, mention or reply. */
  memberMode: 'all' | 'trigger'
  /** Members may ask for the cost (`cost` / `costo`). */
  memberSeesCost: boolean
  memberRate: number
  memberDailyCap: number
  shareCodeWithMembers: boolean
  ownerOnlyAlertsInGroup: boolean
  maxMessageChars: number
  maxFileMb: number
  pollSeconds: number
  /** One WhatsApp group per project (default) or per session. */
  groupScope: WaGroupScope
  /** Questions answered per chat in ten minutes. */
  qaRate: number
  /** What answering questions may cost in a day, all sessions together (USD, estimated). */
  qaDailyUsd: number
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:2785/api'

export const EVENT_KEYS: readonly WaEventKey[] = [
  'longTurn',
  'turnFailed',
  'toolErrors',
  'tests',
  'ci',
  'budget',
  'sessionEnd',
  'briefing',
  'evening',
  'permissions',
  'liveStatus',
  'confirmPrompts',
  'memberQuestions',
  'bugReports',
  'uiPreviews',
  'visualReports',
]

export const EVENT_LABELS: Record<WaEventKey, string> = {
  longTurn: 'Long turn finished',
  turnFailed: 'Turn failed',
  toolErrors: 'Repeated tool errors',
  tests: 'Tests red/green',
  ci: 'CI result (gh)',
  budget: 'Budget thresholds',
  sessionEnd: 'Session end summary',
  briefing: 'Morning briefing',
  evening: 'Evening digest',
  permissions: 'Permission alerts',
  liveStatus: 'Live status message',
  confirmPrompts: 'Confirm phone prompts',
  memberQuestions: 'Answer group members',
  bugReports: 'Bug reports from group',
  uiPreviews: 'UI screenshot previews',
  visualReports: 'Visual reports (PNG)',
}

const clampNumber = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback)

const list = (value: unknown): string[] =>
  text(value)
    .split(/[,;\s]+/)
    .map(item => item.trim())
    .filter(item => item !== '')

/** Digits of a phone number as WhatsApp writes them (no +, spaces or dashes). */
export const digitsOnly = (value: string): string => value.replace(/\D/g, '')

export const readSettings = (options: Readonly<Record<string, unknown>>): Settings => {
  const mode = text(options.notifyMode, 'away')
  return {
    baseUrl: (text(options.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: text(options.apiKey),
    ownerNumbers: text(options.ownerNumbers)
      .split(/[,;]+/)
      .map(canonicalOwner)
      .filter(n => n.length >= 6),
    extraChats: list(options.allowedChats),
    autoCreateGroup: options.autoCreateGroup !== false,
    awayMinutes: clampNumber(options.awayMinutes, 1, 240, 10),
    quietHours: text(options.quietHours, '23-8'),
    interactionOffHours: text(options.interactionOffHours, '23-8'),
    notifyMode: mode === 'always' || mode === 'off' ? mode : 'away',
    digestMinutes: clampNumber(options.digestMinutes, 30, 60, 45),
    maxPerHour: clampNumber(options.maxPerHour, 1, 120, 20),
    pin: text(options.pin),
    remoteApprovals: options.remoteApprovals !== false,
    longTurnMinutes: clampNumber(options.longTurnMinutes, 1, 600, 5),
    budgetSteps: list(options.budgetSteps)
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b),
    briefingTime: text(options.briefingTime, '08:30'),
    eveningTime: text(options.eveningTime, '19:00'),
    memberTriggers: list(options.memberTrigger ?? '?,claude').map(t => t.toLowerCase()),
    memberMode: options.memberMode === 'trigger' ? 'trigger' : 'all',
    memberSeesCost: options.memberSeesCost === true,
    memberRate: clampNumber(options.memberRate, 1, 60, 5),
    memberDailyCap: clampNumber(options.memberDailyCap, 1, 1000, 40),
    shareCodeWithMembers: options.shareCodeWithMembers === true,
    ownerOnlyAlertsInGroup: options.ownerOnlyAlertsInGroup === true,
    maxMessageChars: clampNumber(options.maxMessageChars, 200, 4000, 1500),
    maxFileMb: clampNumber(options.maxFileMb, 1, 16, 5),
    pollSeconds: clampNumber(options.pollSeconds, 3, 120, 6),
    groupScope: options.groupScope === 'session' ? 'session' : 'project',
    qaRate: clampNumber(options.qaRate, 1, 60, 6),
    qaDailyUsd: clampNumber(options.qaDailyUsd, 0, 50, 0.5),
  }
}

/** Chatty or heavy updates start switched off. */
const OFF_BY_DEFAULT: ReadonlySet<WaEventKey> = new Set(['liveStatus', 'visualReports'])

export const defaultPrefs = (settings: Settings): WaPrefs => ({
  paused: false,
  presence: 'auto',
  interaction: 'auto',
  nightUntil: 0,
  events: Object.fromEntries(EVENT_KEYS.map(key => [key, !OFF_BY_DEFAULT.has(key)])) as Record<WaEventKey, boolean>,
  quietHours: settings.quietHours,
  awayMinutes: settings.awayMinutes,
})

/** prefs.json as stored, made whole: unknown keys dropped, missing ones from the defaults. */
export const mergePrefs = (stored: unknown, settings: Settings): WaPrefs => {
  const base = defaultPrefs(settings)
  if (typeof stored !== 'object' || stored === null) return base
  const raw = stored as Partial<Record<keyof WaPrefs, unknown>>
  const events = { ...base.events }
  if (typeof raw.events === 'object' && raw.events !== null) {
    for (const key of EVENT_KEYS) {
      const value = (raw.events as Record<string, unknown>)[key]
      if (typeof value === 'boolean') events[key] = value
    }
  }
  const presence = raw.presence === 'away' || raw.presence === 'here' ? raw.presence : 'auto'
  const interaction = raw.interaction === 'on' || raw.interaction === 'off' || raw.interaction === 'night' ? raw.interaction : 'auto'
  return {
    paused: raw.paused === true,
    presence,
    interaction,
    nightUntil: typeof raw.nightUntil === 'number' ? raw.nightUntil : 0,
    events,
    quietHours: raw.quietHours === 'off' || (typeof raw.quietHours === 'string' && parseHours(raw.quietHours) !== null) ? String(raw.quietHours) : base.quietHours,
    awayMinutes: clampNumber(raw.awayMinutes, 1, 240, base.awayMinutes),
  }
}

/** `23-8` → { from: 23, to: 8 }; empty or malformed → null (no window). */
export const parseHours = (value: string): { from: number; to: number } | null => {
  const match = /^\s*(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?\s*$/.exec(value)
  if (match === null) return null
  const from = Number(match[1])
  const to = Number(match[2])
  if (from > 23 || to > 24 || from === to) return null
  return { from, to: to % 24 }
}

/** Whether `hour` (0-23) falls in the window, which may wrap midnight. */
export const inWindow = (hours: string, hour: number): boolean => {
  const window = parseHours(hours)
  if (window === null) return false
  return window.from < window.to ? hour >= window.from && hour < window.to : hour >= window.from || hour < window.to
}

/** `08:30` → minutes after midnight; malformed or empty → null (off). */
export const parseClock = (value: string): number | null => {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value)
  if (match === null) return null
  const h = Number(match[1])
  const m = Number(match[2])
  return h < 24 && m < 60 ? h * 60 + m : null
}

/** The next time (ms) at which the off-hours window ends, from `now`: when night mode stops. */
export const windowEnd = (hours: string, now: number): number => {
  const window = parseHours(hours) ?? { from: 23, to: 8 }
  const date = new Date(now)
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), window.to, 0, 0, 0).getTime()
  return end > now ? end : end + 24 * 60 * 60 * 1000
}

/** Interaction in force now: whether Claude may start a conversation with the phone. */
export const interactionAllowed = (prefs: WaPrefs, offHours: string, now: number): boolean => {
  switch (prefs.interaction) {
    case 'on':
      return true
    case 'off':
      return false
    case 'night':
      return now >= prefs.nightUntil
    case 'auto':
      return !inWindow(offHours, new Date(now).getHours())
  }
}

export const interactionLabel = (prefs: WaPrefs, offHours: string, now: number): string => {
  const isOn = interactionAllowed(prefs, offHours, now)
  switch (prefs.interaction) {
    case 'on':
      return 'on'
    case 'off':
      return 'off (silent mode)'
    case 'night':
      return isOn ? 'on (night ended)' : `off (night mode until ${new Date(prefs.nightUntil).toTimeString().slice(0, 5)})`
    case 'auto':
      return isOn ? `on (auto, off ${offHours})` : `off (auto, ${offHours})`
  }
}

// ── With mods-hub ──────────────────────────────────────────────────────────────────────────────────

/** The part of mods-hub's global mode the bridge reads (`ModsMode` in types/mods-hub.d.ts). */
export type HubAttention = { presence: 'here' | 'idle' | 'away'; isNight: boolean; canAsk: boolean; interaction: string; quietHours: string }

/** Quiet around the clock: what the hub's Night, while it lasts, means to the bridge's quiet-hours check. */
const ALL_DAY = '0-24'

/**
 * With mods-hub installed its global mode replaces the bridge's own presence, interaction and night, so every
 * channel obeys one switch: away unless the person is here (the hub sends to channels from idle on), questions
 * only while the hub says it may ask, quiet while the hub's Night is on. Pause and the update toggles stay the bridge's.
 */
export const prefsFromHub = (prefs: WaPrefs, mode: HubAttention): WaPrefs => ({
  ...prefs,
  presence: mode.presence === 'here' ? 'here' : 'away',
  interaction: mode.canAsk ? 'on' : 'off',
  nightUntil: 0,
  quietHours: mode.isNight ? ALL_DAY : 'off',
})

/** One line on the hub's mode, where the bridge used to describe its own interaction setting. */
export const hubModeLabel = (mode: HubAttention): string =>
  `${mode.canAsk ? 'on' : 'off'} (mods-hub: ${mode.presence} · interaction ${mode.interaction}${mode.isNight ? ` · night ${mode.quietHours}` : ''})`

/** The link's phase as a mods-hub channel status (the Home tab's Channels list). */
export const channelStatusOf = (phase: WaPhase): 'connected' | 'connecting' | 'disconnected' | 'error' | 'unconfigured' => {
  switch (phase) {
    case 'ready':
      return 'connected'
    case 'starting':
    case 'qr':
      return 'connecting'
    case 'disconnected':
      return 'disconnected'
    case 'unconfigured':
    case 'no-key':
    case 'no-session':
      return 'unconfigured'
    case 'unreachable':
    case 'admin-key':
    case 'error':
      return 'error'
  }
}

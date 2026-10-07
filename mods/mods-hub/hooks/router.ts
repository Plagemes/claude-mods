// The notification router and the global mode: pure decisions, unit-tested in tests/router.test.ts.

import type {
  ModsAudience,
  ModsChannel,
  ModsControlAction,
  ModsControlScope,
  ModsInteraction,
  ModsLevel,
  ModsMode,
  ModsNotifyInput,
  ModsPrefs,
  ModsPresence,
  ModsRoute,
} from '../types'

export const LEVELS: readonly ModsLevel[] = ['info', 'success', 'warning', 'error', 'critical']
export const ROUTES: readonly ModsRoute[] = ['terminal', 'away', 'always', 'off']
export const INTERACTIONS: readonly ModsInteraction[] = ['auto', 'on', 'off']

export const GLYPH: Record<ModsLevel, string> = { info: 'ℹ', success: '✓', warning: '⚠', error: '✗', critical: '‼' }

export const DEFAULT_PREFS: ModsPrefs = {
  interaction: 'auto',
  silentUntil: null,
  isSilent: false,
  isNightOn: true,
  quietHours: '22:00-07:00',
  presence: 'auto',
  routes: { info: 'terminal', success: 'away', warning: 'away', error: 'away', critical: 'always' },
  channels: {},
}

export const levelRank = (level: ModsLevel): number => LEVELS.indexOf(level)

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/** Prefs read from disk (another version, a hand edit) made whole: unknown fields dropped, bad ones defaulted. */
export function sanitizePrefs(raw: unknown): ModsPrefs {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const routes = { ...DEFAULT_PREFS.routes }
  const rawRoutes = (record.routes ?? {}) as Record<string, unknown>
  for (const level of LEVELS) if (isOneOf(ROUTES, rawRoutes[level])) routes[level] = rawRoutes[level]
  const channels: ModsPrefs['channels'] = {}
  for (const [id, value] of Object.entries((record.channels ?? {}) as Record<string, unknown>)) {
    const entry = (value ?? {}) as Record<string, unknown>
    channels[id] = { isEnabled: entry.isEnabled !== false, minLevel: isOneOf(LEVELS, entry.minLevel) ? entry.minLevel : 'info' }
  }
  const quietHours = typeof record.quietHours === 'string' && parseQuietHours(record.quietHours) !== undefined ? record.quietHours : DEFAULT_PREFS.quietHours
  return {
    interaction: isOneOf(INTERACTIONS, record.interaction) ? record.interaction : DEFAULT_PREFS.interaction,
    silentUntil: typeof record.silentUntil === 'number' && Number.isFinite(record.silentUntil) ? record.silentUntil : null,
    isSilent: record.isSilent === true,
    isNightOn: record.isNightOn !== false,
    quietHours,
    presence: isOneOf(['auto', 'away', 'here'] as const, record.presence) ? record.presence : 'auto',
    routes,
    channels,
  }
}

/** `22:00-07:00` → minutes of the day; undefined when it does not parse. */
export function parseQuietHours(text: string): { from: number; to: number } | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (match === null) return undefined
  const [h1, m1, h2, m2] = match.slice(1).map(Number) as [number, number, number, number]
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 }
}

/** Whether a minute of the day falls inside quiet hours (a span may cross midnight). */
export function isQuietAt(quietHours: string, minuteOfDay: number): boolean {
  const span = parseQuietHours(quietHours)
  if (span === undefined || span.from === span.to) return false
  return span.from < span.to ? minuteOfDay >= span.from && minuteOfDay < span.to : minuteOfDay >= span.from || minuteOfDay < span.to
}

export type PresenceClock = { lastActivityAt: number; now: number; idleMs: number; awayMs: number }

/** Where the person is: a manual setting wins until the next activity; otherwise the time since the last one. */
export function presenceOf(override: ModsPrefs['presence'], clock: PresenceClock): ModsPresence {
  if (override === 'away' || override === 'here') return override
  const quiet = clock.now - clock.lastActivityAt
  return quiet >= clock.awayMs ? 'away' : quiet >= clock.idleMs ? 'idle' : 'here'
}

/** The hub's presence settings, in minutes, as the mode reports them. */
export type PresenceMinutes = { idleMinutes: number; awayMinutes: number }
export const DEFAULT_PRESENCE_MINUTES: PresenceMinutes = { idleMinutes: 10, awayMinutes: 30 }

/** The mode every mod reads: prefs, presence and the clock folded together. */
export function deriveMode(prefs: ModsPrefs, presence: ModsPresence, now: number, minuteOfDay: number, minutes: PresenceMinutes = DEFAULT_PRESENCE_MINUTES): ModsMode {
  const isSilent = prefs.isSilent && (prefs.silentUntil === null || now < prefs.silentUntil)
  const isNight = prefs.isNightOn && isQuietAt(prefs.quietHours, minuteOfDay)
  const canAsk = prefs.interaction === 'on' ? !isNight : prefs.interaction === 'auto' ? presence === 'away' && !isNight : false
  return {
    presence,
    isSilent,
    silentUntil: isSilent ? prefs.silentUntil : null,
    isNight,
    isNightOn: prefs.isNightOn,
    quietHours: prefs.quietHours,
    idleMinutes: minutes.idleMinutes,
    awayMinutes: minutes.awayMinutes,
    interaction: prefs.interaction,
    canAsk,
  }
}

export type RouteDecision = { toast: boolean; channels: string[]; held: boolean; reason?: string }

/**
 * Where one notification goes. The route of its level says whether channels are wanted at all
 * (never, while not here, always); silent keeps it off the screen, night holds it for the digest
 * (critical always goes), a question needs Interaction's leave, and each channel has its own
 * switch and lowest level.
 */
export function route(input: Pick<ModsNotifyInput, 'level' | 'audience' | 'kind'>, mode: ModsMode, prefs: ModsPrefs, channels: readonly ModsChannel[]): RouteDecision {
  const level = input.level
  const audience: ModsAudience = input.audience ?? 'me'
  const levelRoute = prefs.routes[level]
  if (levelRoute === 'off') return { toast: false, channels: [], held: false, reason: `routing for ${level} is off` }

  const isCritical = level === 'critical'
  const toast = !mode.isSilent || isCritical
  const reasons: string[] = toast ? [] : ['silent']

  const wantsChannels = audience === 'terminal' ? false : audience === 'team' ? levelRoute !== 'terminal' : levelRoute === 'always' || (levelRoute === 'away' && mode.presence !== 'here')
  if (!wantsChannels) return { toast, channels: [], held: false, ...(reasons.length > 0 ? { reason: reasons.join(', ') } : {}) }

  if (input.kind === 'question' && audience !== 'team' && !mode.canAsk) {
    return { toast, channels: [], held: false, reason: [...reasons, `interaction is ${mode.interaction}`].join(', ') }
  }
  const wanted = audience === 'team' ? 'team' : 'me'
  const targets = channels
    .filter(channel => channel.audience === wanted && channel.status !== 'unconfigured')
    .filter(channel => {
      const setting = prefs.channels[channel.id]
      return setting === undefined || (setting.isEnabled && levelRank(level) >= levelRank(setting.minLevel))
    })
    .map(channel => channel.id)
  if (targets.length === 0) return { toast, channels: [], held: false, reason: [...reasons, 'no channel takes it'].join(', ') }
  if (mode.isNight && !isCritical && audience === 'me') return { toast, channels: [], held: true, reason: [...reasons, 'night'].join(', ') }
  return { toast, channels: targets, held: false, ...(reasons.length > 0 ? { reason: reasons.join(', ') } : {}) }
}

/** The toast line of a notification: `✓ ci-watch: CI passed — main · 3m`. */
export function noticeLine(notice: { level: ModsLevel; source: string; title: string; body?: string }): string {
  const body = notice.body === undefined || notice.body === '' ? '' : ` — ${notice.body}`
  return `${GLYPH[notice.level]} ${notice.source}: ${notice.title}${body}`.slice(0, 300)
}

export type HubCommand =
  | { kind: 'open' }
  | { kind: 'status' }
  | { kind: 'silent'; minutes: number | null }
  | { kind: 'loud' }
  | { kind: 'night'; isOn: boolean; quietHours?: string }
  | { kind: 'away' }
  | { kind: 'back' }
  | { kind: 'interaction'; value: ModsInteraction }
  | { kind: 'route'; level: ModsLevel; value: ModsRoute }
  | { kind: 'tab'; id: string }
  | { kind: 'test'; level: ModsLevel }
  | { kind: 'control'; action: ModsControlAction; scope: ModsControlScope }
  | { kind: 'error'; message: string }

export const HUB_USAGE =
  'Usage: /hub [status | silent [minutes|off] | night [on|off|22:00-07:00] | away | back | interaction auto|on|off | route <level> terminal|away|always|off | tab <id> | test [level] | stop|pause|resume [all]]'

/** `/hub` arguments. */
export function parseHubArgs(args: string): HubCommand {
  const [verb = '', first = '', second = ''] = args.trim().toLowerCase().split(/\s+/)
  switch (verb) {
    case '':
      return { kind: 'open' }
    case 'status':
      return { kind: 'status' }
    case 'silent':
    case 'quiet':
      if (first === 'off') return { kind: 'loud' }
      if (first === '') return { kind: 'silent', minutes: null }
      return /^\d{1,4}$/.test(first) && Number(first) > 0 ? { kind: 'silent', minutes: Number(first) } : { kind: 'error', message: 'silent takes minutes (1-9999) or off.' }
    case 'night':
      if (first === '' || first === 'on') return { kind: 'night', isOn: true }
      if (first === 'off') return { kind: 'night', isOn: false }
      return parseQuietHours(first) === undefined ? { kind: 'error', message: 'night takes on, off or quiet hours like 22:00-07:00.' } : { kind: 'night', isOn: true, quietHours: first }
    case 'away':
      return { kind: 'away' }
    case 'back':
    case 'here':
      return { kind: 'back' }
    case 'interaction':
      return isOneOf(INTERACTIONS, first) ? { kind: 'interaction', value: first } : { kind: 'error', message: 'interaction takes auto, on or off.' }
    case 'route':
      return isOneOf(LEVELS, first) && isOneOf(ROUTES, second)
        ? { kind: 'route', level: first, value: second }
        : { kind: 'error', message: `route takes a level (${LEVELS.join(', ')}) and terminal, away, always or off.` }
    case 'tab':
      return first === '' ? { kind: 'error', message: 'tab takes a tab id (home, or one a mod registered).' } : { kind: 'tab', id: first }
    case 'test':
      return { kind: 'test', level: isOneOf(LEVELS, first) ? first : 'success' }
    case 'stop':
    case 'pause':
    case 'resume':
      if (first !== '' && first !== 'all') return { kind: 'error', message: `${verb} takes nothing (this session) or all (every session).` }
      return { kind: 'control', action: verb, scope: first === 'all' ? 'all' : 'session' }
    default:
      return { kind: 'error', message: HUB_USAGE }
  }
}

/** The next value of a cycling button. */
export const cycle = <T>(list: readonly T[], value: T): T => list[(list.indexOf(value) + 1) % list.length] as T

/** `here`, `idle 12m`, `away`: with the minutes since the last activity once it is not here. */
export function describeMode(mode: ModsMode, now: number): string {
  const parts = [mode.presence === 'here' ? 'here' : mode.presence]
  if (mode.isSilent) parts.push(mode.silentUntil === null ? 'silent' : `silent ${Math.max(1, Math.ceil((mode.silentUntil - now) / 60_000))}m`)
  if (mode.isNight) parts.push(`night (${mode.quietHours})`)
  parts.push(`interaction ${mode.interaction}`)
  return parts.join(' · ')
}

/** Like the error-feed and loop-breaker keys: a failing command with its volatile parts (numbers, paths' tails) folded. */
export const commandSignature = (command: string): string =>
  command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 160)

// Pure logic of mission-control: heartbeats and their staleness, the inbox of commands, the cockpit's cards,
// totals, sorting and filtering, alerts and the /mission arguments. No `$`, no I/O: unit-tested directly.
import type {
  MissionBoard,
  MissionCard,
  MissionCommand,
  MissionCommandKind,
  MissionFilter,
  MissionHeartbeat,
  MissionPriority,
  MissionSort,
  MissionState,
  MissionTotals,
} from '../types'

/** A heartbeat older than this is a session that is gone (crashed, closed without its end hook). */
export const STALE_MS = 30_000
/** An inbox command older than this is never run (a session that was away does not replay old clicks). */
export const COMMAND_TTL_MS = 10 * 60_000
export const ACKED_KEEP = 50
const TASK_CHARS = 100
const TEXT_CHARS = 2_000

export const STATES: readonly MissionState[] = ['idle', 'working', 'waiting-permission', 'waiting-input']
export const PRIORITIES: readonly MissionPriority[] = ['high', 'normal', 'low']
/** The order a card's Priority button steps through. */
export const PRIORITY_CYCLE: readonly MissionPriority[] = ['normal', 'high', 'low']
export const SORTS: readonly MissionSort[] = ['status', 'recent', 'cost', 'project']
export const FILTERS: readonly MissionFilter[] = ['all', 'working', 'waiting', 'idle']
const KINDS: readonly MissionCommandKind[] = ['pause', 'resume', 'stop', 'note', 'priority']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** What a card shows as the session's task: the prompt's first meaningful line, short. */
export const summarizeTask = (text: string): string => {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '' && !part.startsWith('<'))
  return oneLine(line ?? '', TASK_CHARS)
}

export const labelOf = (project: string, id: string): string => `${project || 'session'}#${id.slice(0, 4)}`

export const projectOf = (root: string): string => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root

/** The local calendar day of `now`, `YYYY-MM-DD`: spend resets at local midnight. */
export const dayKey = (now: number): string => {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const isWaiting = (state: MissionState): boolean => state === 'waiting-permission' || state === 'waiting-input'

// ── Heartbeats ──────────────────────────────────────────────────────────────────────────────────────

/** A heartbeat read from disk, or null when the file is not one (another version, a half-written file). */
export function parseHeartbeat(value: unknown): MissionHeartbeat | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string' || value.id === '') return null
  const state = STATES.includes(value.state as MissionState) ? (value.state as MissionState) : 'idle'
  const priority = PRIORITIES.includes(value.priority as MissionPriority) ? (value.priority as MissionPriority) : 'normal'
  const spend = isRecord(value.spend) ? { day: str(value.spend.day), usd: num(value.spend.usd) } : { day: '', usd: 0 }
  const lastError = isRecord(value.lastError) ? { text: str(value.lastError.text), at: num(value.lastError.at) } : null
  const project = str(value.project)
  return {
    v: 1,
    id: value.id,
    label: str(value.label) || labelOf(project, value.id),
    project,
    root: str(value.root),
    cwd: str(value.cwd),
    branch: str(value.branch),
    model: str(value.model),
    surface: str(value.surface),
    state,
    stateSince: num(value.stateSince),
    task: str(value.task),
    turnStartedAt: typeof value.turnStartedAt === 'number' ? value.turnStartedAt : null,
    startedAt: num(value.startedAt),
    updatedAt: num(value.updatedAt),
    turns: num(value.turns),
    tokens: num(value.tokens),
    usd: num(value.usd),
    isUsdEstimate: value.isUsdEstimate === true,
    spend,
    subagents: num(value.subagents),
    lastError,
    blocked: typeof value.blocked === 'string' && value.blocked !== '' ? value.blocked : null,
    paused: value.paused === true,
    priority,
    acked: Array.isArray(value.acked) ? value.acked.filter((id): id is string => typeof id === 'string').slice(-ACKED_KEEP) : [],
    ended: value.ended === true,
  }
}

/** Whether a heartbeat stands for a session that is running now. */
export const isLive = (beat: MissionHeartbeat, now: number): boolean => !beat.ended && now - beat.updatedAt <= STALE_MS

// ── The inbox ───────────────────────────────────────────────────────────────────────────────────────

export function parseCommand(value: unknown): MissionCommand | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || typeof value.at !== 'number') return null
  if (!KINDS.includes(value.kind as MissionCommandKind)) return null
  const from = isRecord(value.from) ? { session: str(value.from.session), label: str(value.from.label) } : { session: '', label: '' }
  const kind = value.kind as MissionCommandKind
  if (kind === 'note' && (typeof value.text !== 'string' || value.text.trim() === '')) return null
  if (kind === 'priority' && !PRIORITIES.includes(value.priority as MissionPriority)) return null
  return {
    id: value.id,
    at: value.at,
    kind,
    from,
    ...(typeof value.text === 'string' ? { text: value.text.slice(0, TEXT_CHARS) } : {}),
    ...(kind === 'priority' ? { priority: value.priority as MissionPriority } : {}),
  }
}

/** The commands of an inbox file (JSON lines), the unreadable lines skipped. */
export function parseInbox(text: string): MissionCommand[] {
  const commands: MissionCommand[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const command = parseCommand(JSON.parse(line))
      if (command !== null) commands.push(command)
    } catch {
      // A line cut by a concurrent write: skipped, the rest still counts.
    }
  }
  return commands
}

/** The commands still to run, oldest first: not handled yet and not older than the TTL. */
export const pendingCommands = (commands: readonly MissionCommand[], acked: readonly string[], now: number): MissionCommand[] =>
  commands.filter(command => !acked.includes(command.id) && now - command.at <= COMMAND_TTL_MS && command.at <= now + STALE_MS).sort((a, b) => a.at - b.at)

/** The inbox file after appending `command`: entries handled or expired are dropped on the way. */
export function appendCommand(existing: string, command: MissionCommand, acked: readonly string[], now: number): string {
  const kept = parseInbox(existing).filter(old => !acked.includes(old.id) && now - old.at <= COMMAND_TTL_MS)
  return [...kept, command].map(entry => JSON.stringify(entry)).join('\n') + '\n'
}

export const remember = (acked: readonly string[], id: string): string[] => [...acked.filter(one => one !== id), id].slice(-ACKED_KEEP)

// ── The cockpit ─────────────────────────────────────────────────────────────────────────────────────

/** A session mods-hub knows (its sessions.json) that writes no heartbeat of its own. */
export type HubSession = { id: string; project: string; lastSeen: number; usd: number }

export function parseHubSessions(value: unknown, now: number, staleMs: number): HubSession[] {
  if (!isRecord(value)) return []
  const sessions: HubSession[] = []
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.lastSeen !== 'number' || now - entry.lastSeen > staleMs) continue
    sessions.push({ id, project: str(entry.project) || projectOf(str(entry.cwd)), lastSeen: entry.lastSeen, usd: num(entry.usd) })
  }
  return sessions
}

export function cardOf(beat: MissionHeartbeat, me: string, now: number): MissionCard {
  const elapsedMs = beat.state === 'working' && beat.turnStartedAt !== null ? now - beat.turnStartedAt : isWaiting(beat.state) ? now - beat.stateSince : 0
  return {
    id: beat.id,
    label: beat.label,
    project: beat.project,
    branch: beat.branch,
    state: beat.state,
    task: beat.task,
    elapsedMs: Math.max(0, elapsedMs),
    usd: beat.usd,
    isUsdEstimate: beat.isUsdEstimate,
    tokens: beat.tokens,
    subagents: beat.subagents,
    model: beat.model,
    priority: beat.priority,
    paused: beat.paused,
    blocked: beat.blocked ?? (beat.paused ? 'paused from Mission Control' : null),
    lastError: beat.lastError?.text ?? null,
    isMe: beat.id === me,
    isHubOnly: false,
    updatedAt: beat.updatedAt,
  }
}

const hubCard = (session: HubSession): MissionCard => ({
  id: session.id,
  label: labelOf(session.project, session.id),
  project: session.project,
  branch: '',
  state: 'idle',
  task: '',
  elapsedMs: 0,
  usd: session.usd,
  isUsdEstimate: true,
  tokens: 0,
  subagents: 0,
  model: '',
  priority: 'normal',
  paused: false,
  blocked: null,
  lastError: null,
  isMe: false,
  isHubOnly: true,
  updatedAt: session.lastSeen,
})

const STATUS_RANK: Record<MissionState, number> = { 'waiting-permission': 0, 'waiting-input': 1, working: 2, idle: 3 }
const PRIORITY_RANK: Record<MissionPriority, number> = { high: 0, normal: 1, low: 2 }

export function sortCards(cards: readonly MissionCard[], sort: MissionSort): MissionCard[] {
  const byLabel = (a: MissionCard, b: MissionCard) => a.label.localeCompare(b.label)
  const compare: Record<MissionSort, (a: MissionCard, b: MissionCard) => number> = {
    status: (a, b) => Number(a.isHubOnly) - Number(b.isHubOnly) || STATUS_RANK[a.state] - STATUS_RANK[b.state] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.elapsedMs - a.elapsedMs || byLabel(a, b),
    recent: (a, b) => b.updatedAt - a.updatedAt || byLabel(a, b),
    cost: (a, b) => b.usd - a.usd || byLabel(a, b),
    project: (a, b) => a.project.localeCompare(b.project) || byLabel(a, b),
  }
  return [...cards].sort(compare[sort])
}

export function filterCards(cards: readonly MissionCard[], filter: MissionFilter): MissionCard[] {
  switch (filter) {
    case 'all':
      return [...cards]
    case 'working':
      return cards.filter(card => card.state === 'working')
    case 'waiting':
      return cards.filter(card => isWaiting(card.state) || card.paused)
    case 'idle':
      return cards.filter(card => card.state === 'idle' && !card.paused)
  }
}

/**
 * The cockpit: one card per live session (and per session only mods-hub knows), the totals bar over every
 * live one, and today's spend over every heartbeat written today, ended sessions included.
 */
export function buildBoard(input: {
  beats: readonly MissionHeartbeat[]
  hub: readonly HubSession[]
  me: string
  now: number
  sort: MissionSort
  filter: MissionFilter
  alertMs: number
}): MissionBoard {
  const { beats, me, now } = input
  const today = dayKey(now)
  const live = beats.filter(beat => isLive(beat, now))
  const known = new Set(beats.map(beat => beat.id))
  const cards = [...live.map(beat => cardOf(beat, me, now)), ...input.hub.filter(session => !known.has(session.id) && session.id !== me).map(hubCard)]
  const todays = beats.filter(beat => beat.spend.day === today)
  const totals: MissionTotals = {
    sessions: cards.length,
    working: live.filter(beat => beat.state === 'working').length,
    waiting: live.filter(beat => isWaiting(beat.state)).length,
    paused: live.filter(beat => beat.paused).length,
    spendToday: todays.reduce((sum, beat) => sum + beat.spend.usd, 0),
    isEstimate: todays.some(beat => beat.isUsdEstimate),
    longWaits: live.filter(beat => isWaiting(beat.state) && now - beat.stateSince >= input.alertMs).length,
  }
  return { cards: sortCards(filterCards(cards, input.filter), input.sort), totals, at: now }
}

/** Live sessions other than `me` that have waited on the person for `alertMs` or more, not alerted yet (by episode). */
export function waitsToAlert(beats: readonly MissionHeartbeat[], me: string, now: number, alertMs: number, alerted: ReadonlySet<string>): MissionHeartbeat[] {
  return beats.filter(beat => beat.id !== me && isLive(beat, now) && isWaiting(beat.state) && now - beat.stateSince >= alertMs && !alerted.has(episodeOf(beat)))
}

/** One wait of one session: a new wait (another stateSince) alerts again. */
export const episodeOf = (beat: Pick<MissionHeartbeat, 'id' | 'stateSince'>): string => `${beat.id}@${beat.stateSince}`

/** The session a name points at: an exact label, an id prefix, or a project with one live session. */
export function resolveTarget<T extends { id: string; label: string; project: string }>(sessions: readonly T[], who: string): T | string {
  const name = who.trim().replace(/^#/, '').toLowerCase()
  if (name === '') return 'Name a session: its label (shop#a1b2), the start of its id, or its project.'
  const exact = sessions.find(session => session.label.toLowerCase() === name)
  if (exact !== undefined) return exact
  const byId = sessions.filter(session => session.id.toLowerCase().startsWith(name) || session.label.toLowerCase().endsWith(`#${name}`))
  if (byId.length === 1 && byId[0] !== undefined) return byId[0]
  const byProject = sessions.filter(session => session.project.toLowerCase() === name)
  if (byProject.length === 1 && byProject[0] !== undefined) return byProject[0]
  const matches = byId.length > 1 ? byId : byProject
  if (matches.length > 1) return `"${who}" matches ${matches.map(session => session.label).join(', ')}: use the label.`
  return `No live session "${who}". Sessions: ${sessions.map(session => session.label).join(', ') || 'none'}.`
}

// ── /mission ────────────────────────────────────────────────────────────────────────────────────────

export type MissionArgs =
  | { kind: 'open' }
  | { kind: 'status' }
  | { kind: 'close' }
  | { kind: 'command'; command: 'pause' | 'resume' | 'stop'; who: string }
  | { kind: 'note'; who: string; text: string }
  | { kind: 'priority'; who: string; priority: MissionPriority }
  | { kind: 'error'; message: string }

export const MISSION_USAGE =
  'Usage: /mission [status | pause <session> | resume <session> | stop <session> | note <session> <text> | priority <session> high|normal|low | close]'

export function parseMissionArgs(args: string): MissionArgs {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [verb = '', who = '', ...rest] = words
  switch (verb.toLowerCase()) {
    case '':
    case 'open':
      return { kind: 'open' }
    case 'status':
    case 'list':
      return { kind: 'status' }
    case 'close':
      return { kind: 'close' }
    case 'pause':
    case 'resume':
    case 'stop':
      return who === '' ? { kind: 'error', message: `/mission ${verb} needs a session.` } : { kind: 'command', command: verb.toLowerCase() as 'pause' | 'resume' | 'stop', who }
    case 'note': {
      const text = args.trim().replace(/^note\s+\S+\s*/i, '')
      return who === '' || text === '' ? { kind: 'error', message: '/mission note needs a session and the text.' } : { kind: 'note', who, text }
    }
    case 'priority': {
      const level = (rest[0] ?? '').toLowerCase() as MissionPriority
      return PRIORITIES.includes(level) && who !== '' ? { kind: 'priority', who, priority: level } : { kind: 'error', message: '/mission priority needs a session and high, normal or low.' }
    }
    default:
      return { kind: 'error', message: `Unknown "${verb}".` }
  }
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export const formatUsd = (usd: number, isEstimate = false): string => `${isEstimate ? '~' : ''}$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)

export const STATE_LOOK: Record<MissionState, { glyph: string; color: string; word: string }> = {
  working: { glyph: '●', color: 'claude', word: 'working' },
  'waiting-permission': { glyph: '◆', color: 'warning', word: 'needs approval' },
  'waiting-input': { glyph: '◆', color: 'warning', word: 'needs an answer' },
  idle: { glyph: '○', color: 'inactive', word: 'idle' },
}

export const describeTotals = (totals: MissionTotals): string =>
  [
    `${totals.sessions} session${totals.sessions === 1 ? '' : 's'}`,
    `${totals.working} working`,
    `${totals.waiting} waiting`,
    ...(totals.paused > 0 ? [`${totals.paused} paused`] : []),
    `${formatUsd(totals.spendToday, totals.isEstimate)} today`,
  ].join(' · ')

/** One line per card, for /mission status and the no-pane surfaces. */
export const describeCard = (card: MissionCard): string => {
  if (card.isHubOnly) return `○ ${card.label} · seen by mods-hub · ${formatUsd(card.usd, true)}`
  const look = STATE_LOOK[card.state]
  const elapsed = card.elapsedMs > 0 ? ` ${formatDuration(card.elapsedMs)}` : ''
  return [
    `${look.glyph} ${card.label}${card.branch === '' ? '' : ` (${card.branch})`} · ${card.paused ? 'paused · ' : ''}${look.word}${elapsed}`,
    formatUsd(card.usd, card.isUsdEstimate),
    ...(card.priority === 'normal' ? [] : [`priority ${card.priority}`]),
    ...(card.task === '' ? [] : [card.task]),
    ...(card.blocked === null ? [] : [`⚠ ${card.blocked}`]),
  ].join(' · ')
}

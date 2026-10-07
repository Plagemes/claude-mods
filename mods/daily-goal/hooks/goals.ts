import type { DailyGoalEntry, DailyGoalQuestion } from '../types'

export const HISTORY_DAYS = 14
/** How far back an unanswered goal is still asked about. */
export const ASK_BACK_DAYS = 7
const KEPT_ENTRIES = 60
const MAX_GOAL_CHARS = 200
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STATUS_GLYPH: Record<DailyGoalEntry['status'], string> = { done: '✓', missed: '✗', open: '?' }

/** What `/daily-goal` was asked. */
export type Request =
  | { kind: 'show' | 'done' | 'clear' | 'history' }
  | { kind: 'set'; text: string }
  | { kind: 'usage'; reason: string }

const pad = (value: number): string => String(value).padStart(2, '0')
const toDate = (day: string): Date => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}
const format = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** The local calendar date of `ms`, `YYYY-MM-DD`. */
export const localDate = (ms: number): string => format(new Date(ms))

/** The calendar date `days` before `day`. */
export function daysBefore(day: string, days: number): string {
  const date = toDate(day)
  return format(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days))
}

/** `Wed 07 Oct`. */
export function dayLabel(day: string): string {
  const date = toDate(day)
  return `${DAY_NAMES[date.getDay()] ?? ''} ${pad(date.getDate())} ${MONTH_NAMES[date.getMonth()] ?? ''}`
}

export function parseRequest(args: string): Request {
  const text = args.trim().replace(/\s+/g, ' ')
  const word = text.toLowerCase()
  if (word === '' || word === 'show') return { kind: 'show' }
  if (word === 'done' || word === 'clear' || word === 'history') return { kind: word }
  if (text.length > MAX_GOAL_CHARS) return { kind: 'usage', reason: `Keep the goal under ${MAX_GOAL_CHARS} characters.` }

  return { kind: 'set', text: text.replace(/^["“](.*)["”]$/, '$1') }
}

/** The well-formed entries the store held, oldest first. */
export function readEntries(value: unknown): DailyGoalEntry[] {
  const list = typeof value === 'object' && value !== null && 'entries' in value ? (value as { entries: unknown }).entries : undefined
  if (!Array.isArray(list)) return []

  return list.flatMap(item => {
    const entry = item as Partial<DailyGoalEntry> | null
    const isValid = typeof entry?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && typeof entry.text === 'string' &&
      typeof entry.setAt === 'number' && (entry.status === 'open' || entry.status === 'done' || entry.status === 'missed')
    return isValid ? [entry as DailyGoalEntry] : []
  }).sort((a, b) => a.date.localeCompare(b.date))
}

export const entryFor = (entries: readonly DailyGoalEntry[], day: string): DailyGoalEntry | undefined =>
  entries.find(entry => entry.date === day)

/** Sets the goal for `day`; a goal already set that day is replaced and opened again. */
export function setGoal(entries: readonly DailyGoalEntry[], day: string, text: string, now: number): DailyGoalEntry[] {
  const rest = entries.filter(entry => entry.date !== day)
  return [...rest, { date: day, text, setAt: now, status: 'open' as const }].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEPT_ENTRIES)
}

/** Marks the goal of `day` done or missed. */
export function closeGoal(entries: readonly DailyGoalEntry[], day: string, status: 'done' | 'missed', now: number): DailyGoalEntry[] {
  return entries.map(entry => (entry.date === day ? { date: entry.date, text: entry.text, setAt: entry.setAt, status, closedAt: now } : entry))
}

/** Notes that today's goal was asked about and is not reached yet: tomorrow asks again. */
export function markAsked(entries: readonly DailyGoalEntry[], day: string): DailyGoalEntry[] {
  return entries.map(entry => (entry.date === day ? { ...entry, isAsked: true } : entry))
}

export const clearGoal = (entries: readonly DailyGoalEntry[], day: string): DailyGoalEntry[] =>
  entries.filter(entry => entry.date !== day)

/** Whether the goal was set before `hour` o'clock on `day` (a goal set on another day counts as set before). */
const wasSetBefore = (entry: DailyGoalEntry, day: string, hour: number): boolean =>
  localDate(entry.setAt) !== day || new Date(entry.setAt).getHours() < hour

/**
 * What the band should ask now: first a goal from an earlier day (at most a
 * week back) left open, then today's once it is `askAfterHour` or later (and only when it was set before that hour; a goal set later is asked about the next day).
 */
export function questionFor(entries: readonly DailyGoalEntry[], today: string, hour: number, askAfterHour: number): DailyGoalQuestion | null {
  const oldest = daysBefore(today, ASK_BACK_DAYS)
  const earlier = entries.filter(entry => entry.date < today && entry.date >= oldest && entry.status === 'open').at(-1)
  if (earlier !== undefined) return { date: earlier.date, text: earlier.text, isToday: false }
  const current = entryFor(entries, today)
  // A goal set after `askAfterHour` is not asked about the minute it is set: it waits for tomorrow, like any earlier goal.
  if (current?.status === 'open' && current.isAsked !== true && hour >= askAfterHour && wasSetBefore(current, today, askAfterHour)) return { date: today, text: current.text, isToday: true }

  return null
}

/** Consecutive days with a goal reached, ending today or yesterday. */
export function streakOf(entries: readonly DailyGoalEntry[], today: string): number {
  const done = new Set(entries.filter(entry => entry.status === 'done').map(entry => entry.date))
  let day = done.has(today) ? today : daysBefore(today, 1)
  let streak = 0
  while (done.has(day)) {
    streak += 1
    day = daysBefore(day, 1)
  }
  return streak
}

/** The last `HISTORY_DAYS` days, newest first: ✓ reached, ✗ missed, ? unanswered, · no goal. */
export function historyText(entries: readonly DailyGoalEntry[], today: string): string {
  const days = Array.from({ length: HISTORY_DAYS }, (_, index) => daysBefore(today, index))
  const shown = days.map(day => entryFor(entries, day))
  const set = shown.filter((entry): entry is DailyGoalEntry => entry !== undefined)
  const reached = set.filter(entry => entry.status === 'done').length
  const streak = streakOf(entries, today)
  const lines = days.map((day, index) => {
    const entry = shown[index]
    if (entry === undefined) return `· ${dayLabel(day)}  (no goal)`
    const glyph = entry.status === 'open' && day === today ? '◦' : STATUS_GLYPH[entry.status]
    return `${glyph} ${dayLabel(day)}  ${entry.text}`
  })
  const summary = set.length === 0
    ? 'no goals set yet'
    : `${reached} of ${set.length} reached${streak > 1 ? ` · ${streak}-day streak` : ''}`

  return [`🎯 Goals, last ${HISTORY_DAYS} days: ${summary}`, ...lines].join('\n')
}

/** The system prompt note for an open goal. */
export const goalSection = (text: string): string =>
  `The user's goal for today in this project: "${text}". Keep it in mind when choosing what to work on and what to suggest next; mention it only when it is relevant.`

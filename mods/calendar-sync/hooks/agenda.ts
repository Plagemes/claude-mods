/**
 * From occurrences to what the person sees and what the hub is told: busy / out-of-office / free, the agenda of a
 * day, free slots inside working hours, a suggestion for a long job. Pure; every function takes `now` and the zone.
 */
import type { CalendarDay as DayView, CalendarKind as Kind, CalendarRow as Row, CalendarSlot as Slot, CalendarStatus as Status, CalendarView as CalView } from '../types'
import type { Occurrence } from './ics'
import { DAY_MS, MINUTE_MS, addDays, atTime, dateKey, epochToWall, startOfDay, timeText, weekdayOf } from './zones'

export type Hm = { h: number; mi: number }

export type CalSettings = {
  /** The person's zone: where all-day dates, floating times and the working hours live. */
  zone: string
  workStart: Hm
  workEnd: Hm
  /** Days of the week free slots are offered on (0 = Sunday). */
  workDays: readonly number[]
  minSlotMinutes: number
  offPattern: OffWords
  myEmail: string
}

/**
 * Words that make a long or all-day event "I am not here": English and Italian first, the usual European ones after.
 * A short timed event ("Holiday party planning", 1 h) needs a stronger phrase, or the person's own word.
 */
const OFF_WORDS = [
  'vacation',
  'holiday',
  'holidays',
  'time off',
  'day off',
  'days off',
  'pto',
  'annual leave',
  'sick',
  'sick leave',
  'ferie',
  'in ferie',
  'permesso',
  'malattia',
  'assente',
  'riposo',
  'urlaub',
  'krank',
  'congé',
  'conge',
  'vacances',
  'vacaciones',
  'baja',
]
const STRONG_WORDS = ['out of office', 'ooo', 'fuori ufficio', 'out-of-office']
/** A timed event at least this long is judged by all the words, a shorter one by the strong ones. */
const LONG_EVENT_MS = 4 * 60 * MINUTE_MS

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const wholeWords = (words: readonly string[]): RegExp =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${[...new Set(words)].map(escapeRegExp).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'iu')

export type OffWords = { all: RegExp; strong: RegExp }

/** The default words plus the person's own (comma separated), as whole-word patterns. */
export function offPatternOf(extra: string): OffWords {
  const own = extra.split(',').map(word => word.trim().toLowerCase()).filter(word => word !== '')
  return { all: wholeWords([...STRONG_WORDS, ...OFF_WORDS, ...own]), strong: wholeWords([...STRONG_WORDS, ...own]) }
}

const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** `mon-fri`, `mon,tue,thu`, `1-5` (0 = Sunday) as weekday numbers; Monday to Friday when it does not parse. */
export function parseWorkDays(text: string): number[] {
  const index = (word: string): number => {
    const trimmed = word.trim().toLowerCase()
    return /^\d$/.test(trimmed) ? Number(trimmed) % 7 : DAY_CODES.indexOf(trimmed.slice(0, 3))
  }
  const days = new Set<number>()
  for (const part of text.split(',')) {
    const [from, to] = part.split('-')
    const a = index(from ?? '')
    const b = to === undefined ? a : index(to)
    if (a < 0 || b < 0) continue
    for (let day = a; ; day = (day + 1) % 7) {
      days.add(day)
      if (day === b) break
    }
  }
  return days.size === 0 ? [1, 2, 3, 4, 5] : [...days].sort((x, y) => x - y)
}

/** `09:00` into hours and minutes; the fallback when it does not parse. */
export function parseHm(text: string, fallback: Hm): Hm {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (match === null) return fallback
  const h = Number(match[1])
  const mi = Number(match[2])
  return h <= 23 && mi <= 59 ? { h, mi } : fallback
}

const isMultiDay = (occurrence: Occurrence): boolean => occurrence.end - occurrence.start >= DAY_MS - MINUTE_MS

/** What an occurrence means for presence. All-day entries are information (birthdays, holidays) unless they say "away". */
export function classify(occurrence: Occurrence, settings: Pick<CalSettings, 'offPattern'>): Kind {
  if (occurrence.isOof) return 'off'
  const isLong = occurrence.isAllDay || occurrence.end - occurrence.start >= LONG_EVENT_MS
  if ((isLong ? settings.offPattern.all : settings.offPattern.strong).test(occurrence.summary)) return 'off'
  if (occurrence.isFree || occurrence.isAllDay || isMultiDay(occurrence)) return 'free'
  return 'busy'
}

export type Span = { start: number; end: number; title: string }

const BUSY_GAP_MS = 5 * MINUTE_MS
const OFF_GAP_MS = MINUTE_MS

/** Occurrences of one kind as spans, overlapping or nearly touching ones merged (back-to-back meetings are one block). */
export function spansOf(occurrences: readonly Occurrence[], kind: Kind, settings: Pick<CalSettings, 'offPattern'>): Span[] {
  const gap = kind === 'off' ? OFF_GAP_MS : BUSY_GAP_MS
  const spans: Span[] = []
  const ordered = occurrences.filter(occurrence => classify(occurrence, settings) === kind).sort((a, b) => a.start - b.start)
  for (const occurrence of ordered) {
    const end = Math.max(occurrence.end, occurrence.start + MINUTE_MS)
    const last = spans[spans.length - 1]
    if (last !== undefined && occurrence.start <= last.end + gap) last.end = Math.max(last.end, end)
    else spans.push({ start: occurrence.start, end, title: occurrence.summary })
  }
  return spans
}

/** Whether the person is in a meeting, out of office or free at `now`; off wins over busy. */
export function statusAt(occurrences: readonly Occurrence[], now: number, settings: Pick<CalSettings, 'offPattern'>): Status {
  const off = spansOf(occurrences, 'off', settings)
  const busy = spansOf(occurrences, 'busy', settings)
  const insideOff = off.find(span => span.start <= now && now < span.end)
  const insideBusy = busy.find(span => span.start <= now && now < span.end)
  const upcoming = [...off, ...busy].filter(span => span.start > now).sort((a, b) => a.start - b.start)[0]
  const next = { nextAt: upcoming?.start ?? null, nextTitle: upcoming?.title ?? '' }
  if (insideOff !== undefined) return { kind: 'off', until: insideOff.end, title: insideOff.title, ...next }
  if (insideBusy !== undefined) return { kind: 'busy', until: insideBusy.end, title: insideBusy.title, ...next }
  return { kind: 'free', until: null, title: '', ...next }
}

/** The free stretches of the working hours of one day (`dayStart` is its midnight), none before `from`. */
export function freeSlots(occurrences: readonly Occurrence[], dayStart: number, settings: CalSettings, from: number = dayStart): Slot[] {
  if (!settings.workDays.includes(weekdayOf(epochToWall(dayStart, settings.zone)))) return []
  const open = Math.max(atTime(dayStart, settings.workStart, settings.zone), from)
  const close = atTime(dayStart, settings.workEnd, settings.zone)
  if (close <= open) return []
  const blocked = [...spansOf(occurrences, 'off', settings), ...spansOf(occurrences, 'busy', settings)].sort((a, b) => a.start - b.start)
  const slots: Slot[] = []
  let cursor = open
  for (const span of blocked) {
    if (span.end <= cursor) continue
    if (span.start >= close) break
    if (span.start > cursor) slots.push({ start: cursor, end: Math.min(span.start, close) })
    cursor = Math.max(cursor, span.end)
    if (cursor >= close) break
  }
  if (cursor < close) slots.push({ start: cursor, end: close })
  return slots.filter(slot => slot.end - slot.start >= settings.minSlotMinutes * MINUTE_MS)
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Wed 7 Oct`. */
export function dayLabel(dayStart: number, zone: string): string {
  const wall = epochToWall(dayStart, zone)
  return `${WEEKDAY_NAMES[weekdayOf(wall)] ?? ''} ${wall.d} ${MONTH_NAMES[wall.m - 1] ?? ''}`
}

/** `1h 30m`, `45m`, `2h`. */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** `14:00–16:30`. */
export const slotText = (slot: Slot, zone: string): string => `${timeText(slot.start, zone)}–${timeText(slot.end, zone)}`

/** The agenda and free slots of the day starting at `dayStart`. */
export function dayView(occurrences: readonly Occurrence[], dayStart: number, now: number, settings: CalSettings): DayView {
  const dayEnd = addDays(dayStart, 1, settings.zone)
  const inDay = occurrences.filter(occurrence => occurrence.start < dayEnd && Math.max(occurrence.end, occurrence.start + 1) > dayStart)
  const rows: Row[] = inDay
    .map(occurrence => {
      const kind = classify(occurrence, settings)
      const isAllDay = occurrence.isAllDay || isMultiDay(occurrence)
      return {
        sort: isAllDay ? -1 : occurrence.start,
        row: {
          time: isAllDay ? 'all day' : `${timeText(occurrence.start, settings.zone)}–${timeText(occurrence.end, settings.zone)}`,
          title: occurrence.summary === '' ? '(no title)' : occurrence.summary,
          kind,
          isNow: occurrence.start <= now && now < Math.max(occurrence.end, occurrence.start + 1),
          isPast: occurrence.end <= now && !(occurrence.start === occurrence.end && occurrence.start >= now),
          location: occurrence.location ?? '',
        } satisfies Row,
      }
    })
    .sort((a, b) => a.sort - b.sort)
    .map(entry => entry.row)
  const isToday = dayStart <= now && now < dayEnd
  return {
    date: dateKey(epochToWall(dayStart, settings.zone)),
    label: dayLabel(dayStart, settings.zone),
    rows,
    slots: freeSlots(inDay, dayStart, settings, isToday ? now : dayStart),
    isToday,
  }
}

export type Suggestion = { slot: Slot; dayOffset: number; text: string }

/** Where a job of `minutes` fits: the first free slot that long today (from now), else the next days. */
export function suggestSlot(occurrences: readonly Occurrence[], now: number, minutes: number, settings: CalSettings, days = 7): Suggestion | undefined {
  const today = startOfDay(now, settings.zone)
  for (let offset = 0; offset < days; offset += 1) {
    const dayStart = addDays(today, offset, settings.zone)
    const dayEnd = addDays(dayStart, 1, settings.zone)
    const inDay = occurrences.filter(occurrence => occurrence.start < dayEnd && occurrence.end > dayStart)
    const slots = freeSlots(inDay, dayStart, { ...settings, minSlotMinutes: 1 }, offset === 0 ? now : dayStart)
    const fit = slots.find(slot => slot.end - slot.start >= minutes * MINUTE_MS)
    if (fit !== undefined) {
      const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `on ${dayLabel(dayStart, settings.zone)}`
      return { slot: fit, dayOffset: offset, text: `You're free ${slotText(fit, settings.zone)} ${when} (${durationText(fit.end - fit.start)})` }
    }
  }
  return undefined
}

/** The longest free slot left today, for a one-line "you're free" suggestion. */
export function bestSlotToday(occurrences: readonly Occurrence[], now: number, settings: CalSettings): Slot | undefined {
  const today = dayView(occurrences, startOfDay(now, settings.zone), now, settings)
  return today.slots.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0]
}

export const EMPTY_STATUS: Status = { kind: 'free', until: null, title: '', nextAt: null, nextTitle: '' }

export const EMPTY_VIEW: CalView = { phase: 'unconfigured', message: '', fetchedAt: 0, zone: 'UTC', status: EMPTY_STATUS, days: [], freeLine: '' }

/** Today and the days after it (two by default), ready to draw. `occurrences` should cover them. */
export function buildView(occurrences: readonly Occurrence[], now: number, settings: CalSettings, meta: Pick<CalView, 'phase' | 'message' | 'fetchedAt'>, dayCount = 2): CalView {
  const today = startOfDay(now, settings.zone)
  const best = bestSlotToday(occurrences, now, settings)
  return {
    ...meta,
    zone: settings.zone,
    status: statusAt(occurrences, now, settings),
    days: Array.from({ length: dayCount }, (_unused, offset) => dayView(occurrences, addDays(today, offset, settings.zone), now, settings)),
    freeLine: best === undefined ? '' : `You're free ${slotText(best, settings.zone)} today (${durationText(best.end - best.start)})`,
  }
}

/** The status line text: what is happening and when it changes. */
export function statusLine(status: Status, now: number, zone: string): string {
  if (status.kind === 'off') return `Out of office${status.until === null ? '' : ` until ${untilText(status.until, now, zone)}`}`
  if (status.kind === 'busy') return `In a meeting until ${timeText(status.until ?? now, zone)}`
  if (status.nextAt !== null && status.nextAt - now <= 60 * MINUTE_MS) return `Next in ${durationText(status.nextAt - now)}: ${status.nextTitle || 'busy'}`
  return ''
}

/** `15:00` today, `Mon 12 Oct` for a later day. */
export function untilText(at: number, now: number, zone: string): string {
  const sameDay = startOfDay(at, zone) === startOfDay(now, zone)
  return sameDay ? timeText(at, zone) : dayLabel(startOfDay(at, zone), zone)
}

const KIND_MARK: Record<Kind, string> = { busy: '●', off: '✈', free: '○' }

/** The agenda of days as plain text (command output, and the pane's fallback). */
export function agendaText(view: CalView, options: { limitDays?: number } = {}): string {
  const lines: string[] = []
  if (view.phase === 'unconfigured') return 'No calendar yet. Put your private iCal (ICS) address in the calendar-sync settings (Google: Settings > calendar > Secret address in iCal format; Outlook: Publish calendar; Apple: Public calendar link).'
  if (view.phase === 'error' && view.days.length === 0) return `Could not read the calendar: ${view.message}`
  for (const [index, day] of view.days.slice(0, options.limitDays ?? view.days.length).entries()) {
    lines.push(`${index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : day.label}${index < 2 ? ` · ${day.label}` : ''}`)
    if (day.rows.length === 0) lines.push('  nothing scheduled')
    for (const row of day.rows) lines.push(`  ${KIND_MARK[row.kind]} ${row.time.padEnd(11)} ${row.title}${row.location === '' ? '' : ` · ${row.location}`}`)
    if (day.slots.length > 0) lines.push(`  free: ${day.slots.map(slot => `${slotText(slot, view.zone)} (${durationText(slot.end - slot.start)})`).join(', ')}`)
  }
  return lines.join('\n')
}

/** `2h`, `90m`, `1.5h`, `2` (hours up to 12, else minutes) as minutes; undefined when it is not a duration. */
export function parseMinutes(text: string): number | undefined {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?\s*$/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1]?.replace(',', '.'))
  const unit = (match[2] ?? '').toLowerCase()
  const minutes = unit.startsWith('h') ? value * 60 : unit.startsWith('m') ? value : value <= 12 ? value * 60 : value
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 ? Math.round(minutes) : undefined
}

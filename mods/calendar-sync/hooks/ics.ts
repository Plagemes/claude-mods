/**
 * iCalendar (RFC 5545) reading: VEVENT, with the recurrence rules calendars actually send (DAILY, WEEKLY with BYDAY,
 * MONTHLY, YEARLY; INTERVAL, UNTIL, COUNT, EXDATE, RECURRENCE-ID overrides), all-day events and time zones.
 * Pure: a text in, events out; `expand` turns events into the occurrences of a time window.
 */
import { DAY_MS, addDays, epochToWall, fixedZone, isKnownZone, resolveZone, wallToEpoch, weekdayOf } from './zones'
import type { Wall } from './zones'

export type Rule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count?: number
  /** Last instant an occurrence may start (inclusive). */
  until?: number
  /** Weekdays (0 = Sunday), with the ordinal of MONTHLY/YEARLY rules (`1MO`, `-1FR`); 0 = every one. */
  byDay: { day: number; nth: number }[]
  byMonthDay: number[]
  byMonth: number[]
  /** Week start, 0 = Sunday. */
  weekStart: number
}

/** One calendar entry as parsed, instants in epoch ms. A series is one entry with a `rule`. */
export type IcsEvent = {
  uid: string
  summary: string
  location?: string
  start: number
  end: number
  isAllDay: boolean
  /** The zone its wall clock lives in (recurrence is computed there, so a daily 09:00 stays 09:00 through DST). */
  zone: string
  rule?: Rule
  /** Starts of the excluded instances. */
  exdates: number[]
  /** Set on an override: the start the instance had before it was moved or edited. */
  recurrenceId?: number
  isCancelled: boolean
  /** TRANSP:TRANSPARENT or busy status FREE: it does not make you busy. */
  isFree: boolean
  /** Busy status OOF: out of office. */
  isOof: boolean
  /** Lower-cased addresses of attendees who declined. */
  declined: string[]
}

export type IcsParse = { events: IcsEvent[]; skipped: number }

export type Occurrence = Omit<IcsEvent, 'rule' | 'exdates' | 'recurrenceId' | 'zone'> & { zone: string }

type Line = { name: string; params: Record<string, string>; value: string }

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const MAX_CANDIDATES = 6_000

/** Joins folded lines (CRLF followed by a space or tab) and splits the text into lines. */
export function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

/** `NAME;PARAM=a;PARAM2="b;c":value`: the first colon outside quotes ends the name and parameters. */
export function parseLine(raw: string): Line | undefined {
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon <= 0) return undefined
  const head: string[] = []
  let current = ''
  inQuotes = false
  for (const char of raw.slice(0, colon)) {
    if (char === '"') inQuotes = !inQuotes
    if (char === ';' && !inQuotes) {
      head.push(current)
      current = ''
    } else current += char
  }
  head.push(current)
  const params: Record<string, string> = {}
  for (const part of head.slice(1)) {
    const eq = part.indexOf('=')
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: (head[0] ?? '').toUpperCase(), params, value: raw.slice(colon + 1) }
}

/** Undoes the backslash escapes of a TEXT value. */
export const unescapeText = (value: string): string =>
  value.replace(/\\([nN,;\\])/g, (_all, char: string) => (char === 'n' || char === 'N' ? '\n' : char))

type DateValue = { wall: Wall; isUtc: boolean; isDate: boolean }

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/

/** `20261007`, `20261007T090000`, `20261007T090000Z`. */
export function parseDateValue(value: string): DateValue | undefined {
  const match = DATE_TIME.exec(value.trim())
  if (match === null) return undefined
  const [, y, m, d, h, mi, s, z] = match
  const wall: Wall = { y: Number(y), m: Number(m), d: Number(d), h: Number(h ?? 0), mi: Number(mi ?? 0), s: Number(s ?? 0) }
  if (wall.m < 1 || wall.m > 12 || wall.d < 1 || wall.d > 31 || wall.h > 23 || wall.mi > 59 || wall.s > 60) return undefined
  return { wall, isUtc: z === 'Z', isDate: h === undefined }
}

/** `PT1H30M`, `P1D`, `P2W`, `-PT15M` in ms. */
export function parseDuration(value: string): number | undefined {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (match === null) return undefined
  const [, sign, w, d, h, m, s] = match
  const ms = (Number(w ?? 0) * 7 + Number(d ?? 0)) * DAY_MS + Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000
  return sign === '-' ? -ms : ms
}

type Resolver = { local: string; zones: Map<string, string> }

/** The zone a date property lives in, or the local one for a floating time. */
function zoneOfProperty(line: Line, value: DateValue, resolver: Resolver): string {
  if (value.isUtc) return 'UTC'
  const tzid = line.params.TZID
  if (tzid === undefined) return resolver.local
  return resolver.zones.get(tzid) ?? resolveZone(tzid) ?? resolver.local
}

/** An instant for a date property; an all-day date is midnight in the local zone. */
function instantOf(line: Line, resolver: Resolver): { epoch: number; zone: string; isDate: boolean } | undefined {
  const value = parseDateValue(line.value)
  if (value === undefined) return undefined
  const zone = value.isDate ? resolver.local : zoneOfProperty(line, value, resolver)
  return { epoch: wallToEpoch(value.wall, zone), zone, isDate: value.isDate }
}

/** Zones named by VTIMEZONE blocks that `Intl` does not know: a fixed offset from the block's latest TZOFFSETTO. */
function readVtimezones(lines: string[], zones: Map<string, string>): void {
  let tzid: string | undefined
  let offset: string | undefined
  let isInside = false
  for (const raw of lines) {
    const line = parseLine(raw)
    if (line === undefined) continue
    if (line.name === 'BEGIN' && line.value === 'VTIMEZONE') {
      isInside = true
      tzid = undefined
      offset = undefined
    } else if (line.name === 'END' && line.value === 'VTIMEZONE') {
      isInside = false
      if (tzid !== undefined && !isKnownZone(tzid) && resolveZone(tzid) === undefined && offset !== undefined) {
        const match = /^([+-])(\d{2})(\d{2})/.exec(offset)
        if (match !== null) zones.set(tzid, fixedZone((match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))))
      }
    } else if (isInside && line.name === 'TZID') tzid = line.value
    else if (isInside && line.name === 'TZOFFSETTO') offset = line.value
  }
}

/** RRULE text into a rule; undefined for the frequencies this does not expand (HOURLY, MINUTELY, SECONDLY). */
export function parseRule(text: string, zone: string): Rule | undefined {
  const parts: Record<string, string> = {}
  for (const piece of text.split(';')) {
    const eq = piece.indexOf('=')
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1)
  }
  const freq = parts.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return undefined
  const rule: Rule = {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    byDay: [],
    byMonthDay: (parts.BYMONTHDAY ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31),
    byMonth: (parts.BYMONTH ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 12),
    weekStart: Math.max(0, WEEKDAYS.indexOf(parts.WKST ?? 'MO')),
  }
  for (const item of (parts.BYDAY ?? '').split(',')) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item.trim().toUpperCase())
    if (match !== null) rule.byDay.push({ day: WEEKDAYS.indexOf(match[2] ?? 'MO'), nth: Number(match[1] ?? 0) })
  }
  if (parts.COUNT !== undefined && Number(parts.COUNT) > 0) rule.count = Math.floor(Number(parts.COUNT))
  if (parts.UNTIL !== undefined) {
    const until = parseDateValue(parts.UNTIL)
    if (until !== undefined) {
      // A date-only or floating UNTIL covers the whole day it names, in the series' zone.
      rule.until = until.isUtc ? wallToEpoch(until.wall, 'UTC') : wallToEpoch(until.isDate ? { ...until.wall, h: 23, mi: 59, s: 59 } : until.wall, zone)
    }
  }
  return rule
}

type Block = { name: string; lines: Line[] }

/** The VEVENT blocks of a calendar as property lists. */
function eventBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let current: Block | undefined
  let depth = 0
  for (const raw of lines) {
    const line = parseLine(raw)
    if (line === undefined) continue
    if (line.name === 'BEGIN' && line.value === 'VEVENT') {
      current = { name: 'VEVENT', lines: [] }
      depth = 0
    } else if (current !== undefined && line.name === 'BEGIN') depth += 1
    else if (current !== undefined && line.name === 'END' && line.value === 'VEVENT' && depth === 0) {
      blocks.push(current)
      current = undefined
    } else if (current !== undefined && line.name === 'END') depth -= 1
    else if (current !== undefined && depth === 0) current.lines.push(line)
  }
  return blocks
}

const first = (lines: Line[], name: string): Line | undefined => lines.find(line => line.name === name)

function eventOf(block: Block, resolver: Resolver): IcsEvent | undefined {
  const { lines } = block
  const startLine = first(lines, 'DTSTART')
  if (startLine === undefined) return undefined
  const start = instantOf(startLine, resolver)
  if (start === undefined) return undefined
  const endLine = first(lines, 'DTEND')
  const end = endLine === undefined ? undefined : instantOf(endLine, resolver)
  const durationLine = first(lines, 'DURATION')
  const duration = durationLine === undefined ? undefined : parseDuration(durationLine.value)
  let endsAt: number
  if (end !== undefined) endsAt = end.epoch
  else if (duration !== undefined) endsAt = start.epoch + duration
  else endsAt = start.isDate ? wallToEpoch(addToWall(epochToWall(start.epoch, start.zone), 1), start.zone) : start.epoch
  if (endsAt < start.epoch) endsAt = start.epoch

  const busy = (first(lines, 'X-MICROSOFT-CDO-BUSYSTATUS')?.value ?? '').toUpperCase()
  const transparency = (first(lines, 'TRANSP')?.value ?? '').toUpperCase()
  const status = (first(lines, 'STATUS')?.value ?? '').toUpperCase()
  const rruleLine = first(lines, 'RRULE')
  const rule = rruleLine === undefined ? undefined : parseRule(rruleLine.value, start.zone)
  const exdates: number[] = []
  for (const line of lines.filter(one => one.name === 'EXDATE')) {
    for (const piece of line.value.split(',')) {
      const value = instantOf({ ...line, value: piece }, resolver)
      if (value !== undefined) exdates.push(value.epoch)
    }
  }
  const recurrenceLine = first(lines, 'RECURRENCE-ID')
  const recurrence = recurrenceLine === undefined ? undefined : instantOf(recurrenceLine, resolver)
  const location = first(lines, 'LOCATION')?.value
  const declined = lines
    .filter(line => line.name === 'ATTENDEE' && (line.params.PARTSTAT ?? '').toUpperCase() === 'DECLINED')
    .map(line => line.value.replace(/^mailto:/i, '').trim().toLowerCase())

  return {
    uid: first(lines, 'UID')?.value ?? `${startLine.value}-${first(lines, 'SUMMARY')?.value ?? ''}`,
    summary: unescapeText(first(lines, 'SUMMARY')?.value ?? '').trim(),
    ...(location === undefined || location === '' ? {} : { location: unescapeText(location).trim() }),
    start: start.epoch,
    end: endsAt,
    isAllDay: start.isDate,
    zone: start.zone,
    ...(rule === undefined ? {} : { rule }),
    exdates,
    ...(recurrence === undefined ? {} : { recurrenceId: recurrence.epoch }),
    isCancelled: status === 'CANCELLED',
    isFree: transparency === 'TRANSPARENT' || busy === 'FREE',
    isOof: busy === 'OOF',
    declined,
  }
}

const addToWall = (wall: Wall, days: number): Wall => {
  const moved = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + days))
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate(), h: wall.h, mi: wall.mi, s: wall.s }
}

/**
 * Reads the VEVENTs of an ICS text. `localZone` is where floating times and all-day dates live (the person's zone).
 * An entry that does not parse is skipped and counted, never fatal.
 */
export function parseIcs(text: string, localZone: string): IcsParse {
  const lines = unfold(text)
  const zones = new Map<string, string>()
  readVtimezones(lines, zones)
  const resolver: Resolver = { local: localZone, zones }
  const events: IcsEvent[] = []
  let skipped = 0
  for (const block of eventBlocks(lines)) {
    let event: IcsEvent | undefined
    try {
      event = eventOf(block, resolver)
    } catch {
      event = undefined
    }
    if (event === undefined) skipped += 1
    else events.push(event)
  }
  return { events, skipped }
}

// ── Recurrence ───────────────────────────────────────────────────────────────────────────────────

const MAX_PERIODS = 6_000

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The dates (as {y,m,d}) a rule produces in one month for the given by-rules. */
function monthDates(rule: Rule, y: number, m: number, anchor: Wall): number[] {
  const length = daysInMonth(y, m)
  const days = new Set<number>()
  if (rule.byMonthDay.length > 0) {
    for (const value of rule.byMonthDay) {
      const day = value > 0 ? value : length + value + 1
      if (day >= 1 && day <= length) days.add(day)
    }
    if (rule.byDay.length > 0) {
      const wanted = new Set(rule.byDay.map(item => item.day))
      for (const day of [...days]) if (!wanted.has(weekdayOf({ y, m, d: day }))) days.delete(day)
    }
  } else if (rule.byDay.length > 0) {
    for (const { day: weekday, nth } of rule.byDay) {
      const matching: number[] = []
      for (let d = 1; d <= length; d += 1) if (weekdayOf({ y, m, d }) === weekday) matching.push(d)
      if (nth === 0) matching.forEach(d => days.add(d))
      else {
        const picked = nth > 0 ? matching[nth - 1] : matching[matching.length + nth]
        if (picked !== undefined) days.add(picked)
      }
    }
  } else if (anchor.d <= length) days.add(anchor.d)
  return [...days].sort((a, b) => a - b)
}

/** The wall dates (at the series' time of day) a rule produces, in order, starting from DTSTART's date. */
function* walls(rule: Rule, anchor: Wall, startK: number): Generator<Wall> {
  const at = (y: number, m: number, d: number): Wall => ({ y, m, d, h: anchor.h, mi: anchor.mi, s: anchor.s })
  if (rule.freq === 'DAILY') {
    for (let k = startK; k < startK + MAX_PERIODS; k += 1) {
      const date = new Date(Date.UTC(anchor.y, anchor.m - 1, anchor.d + k * rule.interval))
      const wall = at(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
      if (rule.byDay.length === 0 || rule.byDay.some(item => item.day === weekdayOf(wall))) yield wall
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = (rule.byDay.length > 0 ? rule.byDay.map(item => item.day) : [weekdayOf(anchor)]).slice().sort((a, b) => ((a - rule.weekStart + 7) % 7) - ((b - rule.weekStart + 7) % 7))
    const offsetToWeekStart = (weekdayOf(anchor) - rule.weekStart + 7) % 7
    for (let k = startK; k < startK + MAX_PERIODS; k += 1) {
      for (const day of days) {
        const delta = -offsetToWeekStart + k * rule.interval * 7 + ((day - rule.weekStart + 7) % 7)
        const date = new Date(Date.UTC(anchor.y, anchor.m - 1, anchor.d + delta))
        yield at(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
      }
    }
  } else if (rule.freq === 'MONTHLY') {
    for (let k = 0; k < MAX_PERIODS; k += 1) {
      const month = new Date(Date.UTC(anchor.y, anchor.m - 1 + k * rule.interval, 1))
      const y = month.getUTCFullYear()
      const m = month.getUTCMonth() + 1
      for (const d of monthDates(rule, y, m, anchor)) yield at(y, m, d)
    }
  } else {
    const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [anchor.m]
    for (let k = 0; k < 500; k += 1) {
      const y = anchor.y + k * rule.interval
      for (const m of months) for (const d of monthDates(rule, y, m, anchor)) yield at(y, m, d)
    }
  }
}

const instanceOf = (event: IcsEvent, start: number): Occurrence => {
  const { rule: _rule, exdates: _exdates, recurrenceId: _recurrenceId, ...rest } = event
  // An all-day instance ends at a midnight, whatever a daylight-saving change did to the 24 hours between.
  const end = event.isAllDay ? addDays(start, Math.max(1, Math.round((event.end - event.start) / DAY_MS)), event.zone) : start + (event.end - event.start)
  return { ...rest, start, end }
}

/** Every start of a series before `to` and not before `from`, in order. COUNT is honoured by walking from DTSTART. */
function seriesStarts(event: IcsEvent, rule: Rule, from: number, to: number): number[] {
  const anchor = epochToWall(event.start, event.zone)
  const anchorKey = anchor.y * 10_000 + anchor.m * 100 + anchor.d
  // Daily and weekly series without COUNT can jump close to the window instead of walking from DTSTART.
  const period = rule.freq === 'DAILY' ? rule.interval : rule.freq === 'WEEKLY' ? rule.interval * 7 : 0
  const startK = period > 0 && rule.count === undefined ? Math.max(0, Math.floor((from - event.start) / DAY_MS / period) - 2) : 0
  const found: number[] = []
  let produced = 0
  let candidates = 0
  for (const wall of walls(rule, anchor, startK)) {
    candidates += 1
    if (candidates > MAX_CANDIDATES) break
    // Weekly and monthly rules can yield dates before DTSTART in their first period: they are not instances.
    if (wall.y * 10_000 + wall.m * 100 + wall.d < anchorKey) continue
    const start = wallToEpoch(wall, event.zone)
    if (rule.until !== undefined && start > rule.until) break
    if (start >= to) break
    produced += 1
    if (rule.count !== undefined && produced > rule.count) break
    if (start >= from) found.push(start)
  }
  return found
}

/**
 * The occurrences overlapping [from, to), start-ordered: single events as they are, series expanded, overridden or
 * excluded instances dropped, cancelled entries and instances the person declined (`myEmail`) left out.
 */
export function expand(events: readonly IcsEvent[], from: number, to: number, options: { myEmail?: string } = {}): Occurrence[] {
  const me = (options.myEmail ?? '').trim().toLowerCase()
  const overrides = new Map<string, Set<number>>()
  for (const event of events) {
    if (event.recurrenceId === undefined) continue
    const set = overrides.get(event.uid) ?? new Set<number>()
    set.add(event.recurrenceId)
    overrides.set(event.uid, set)
  }
  const found: Occurrence[] = []
  for (const event of events) {
    if (event.isCancelled) continue
    if (me !== '' && event.declined.includes(me)) continue
    const length = event.end - event.start
    const overlaps = (start: number): boolean => (length === 0 ? start >= from && start < to : start < to && start + length > from)
    if (event.rule === undefined || event.recurrenceId !== undefined) {
      if (overlaps(event.start)) found.push(instanceOf(event, event.start))
      continue
    }
    const replaced = overrides.get(event.uid)
    for (const start of seriesStarts(event, event.rule, from - length, to)) {
      if (event.exdates.includes(start) || replaced?.has(start) === true) continue
      if (overlaps(start)) found.push(instanceOf(event, start))
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end)
}

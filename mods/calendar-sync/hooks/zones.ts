/**
 * Time zones without a library: wall-clock fields to an instant and back through `Intl`, the Windows zone names
 * Outlook writes, and a fixed-offset fallback for a VTIMEZONE `Intl` has never heard of.
 * Pure; every function takes the zone it works in.
 */

export type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number }

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** Outlook / Exchange write Windows zone names in TZID; this maps the common ones to IANA. */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc': 'UTC',
  'utc-11': 'Etc/GMT+11',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'central standard time': 'America/Chicago',
  'central america standard time': 'America/Guatemala',
  'canada central standard time': 'America/Regina',
  'central standard time (mexico)': 'America/Mexico_City',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'sa pacific standard time': 'America/Bogota',
  'sa eastern standard time': 'America/Cayenne',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kiev',
  'turkey standard time': 'Europe/Istanbul',
  'russian standard time': 'Europe/Moscow',
  'israel standard time': 'Asia/Jerusalem',
  'egypt standard time': 'Africa/Cairo',
  'south africa standard time': 'Africa/Johannesburg',
  'w. central africa standard time': 'Africa/Lagos',
  'e. africa standard time': 'Africa/Nairobi',
  'arab standard time': 'Asia/Riyadh',
  'arabian standard time': 'Asia/Dubai',
  'iran standard time': 'Asia/Tehran',
  'india standard time': 'Asia/Kolkata',
  'pakistan standard time': 'Asia/Karachi',
  'bangladesh standard time': 'Asia/Dhaka',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland',
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone)
  if (cached !== undefined) return cached
  let made: Intl.DateTimeFormat | null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    made = null
  }
  formatters.set(zone, made)
  return made
}

/** The zone of this machine, as `Intl` knows it ('UTC' when it cannot say). */
export function systemZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A fixed UTC offset written as a zone: `fixed:+120` is UTC+02:00. */
export const fixedZone = (offsetMinutes: number): string => `fixed:${offsetMinutes >= 0 ? '+' : '-'}${Math.abs(offsetMinutes)}`

const FIXED = /^fixed:([+-])(\d+)$/

function fixedOffsetMs(zone: string): number | undefined {
  const match = FIXED.exec(zone)
  return match === null ? undefined : (match[1] === '-' ? -1 : 1) * Number(match[2]) * MINUTE_MS
}

/** Whether a zone name can be used as it is: a fixed offset or something `Intl` accepts. */
export const isKnownZone = (zone: string): boolean => FIXED.test(zone) || zone === 'UTC' || formatterFor(zone) !== null

/**
 * An iCalendar TZID as a usable zone: IANA as written, a Windows name, an Olson path
 * (`/mozilla.org/20050126_1/Europe/Rome`), or undefined when nothing matches.
 */
export function resolveZone(tzid: string): string | undefined {
  const name = tzid.trim().replace(/^"|"$/g, '')
  if (name === '') return undefined
  if (isKnownZone(name)) return name
  const windows = WINDOWS_ZONES[name.toLowerCase()]
  if (windows !== undefined && isKnownZone(windows)) return windows
  const parts = name.split('/').filter(part => part !== '')
  for (const take of [3, 2, 1]) {
    if (parts.length < take) continue
    const tail = parts.slice(-take).join('/')
    if (tail !== name && isKnownZone(tail)) return tail
  }
  return undefined
}

/** Offset of `zone` from UTC at an instant, in ms (positive east of Greenwich). */
export function zoneOffsetMs(zone: string, at: number): number {
  const fixed = fixedOffsetMs(zone)
  if (fixed !== undefined) return fixed
  if (zone === 'UTC') return 0
  const formatter = formatterFor(zone)
  if (formatter === null) return 0
  const whole = Math.floor(at / 1000) * 1000
  const fields: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(whole))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(fields.year ?? 1970, (fields.month ?? 1) - 1, fields.day ?? 1, (fields.hour ?? 0) % 24, fields.minute ?? 0, fields.second ?? 0)
  return asUtc - whole
}

/**
 * The instant a wall clock shows in `zone`, as RFC 5545 reads local times: a time the clock skips (spring forward)
 * is read with the offset before the gap, so it lands just after it (02:30 → 03:30); a time shown twice (fall back)
 * is its first occurrence. East and west of Greenwich alike.
 */
export function wallToEpoch(wall: Wall, zone: string): number {
  const guess = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s)
  const before = zoneOffsetMs(zone, guess - DAY_MS)
  const after = zoneOffsetMs(zone, guess + DAY_MS)
  const fits = (offset: number): boolean => zoneOffsetMs(zone, guess - offset) === offset
  const candidates = [before, after].filter(fits).map(offset => guess - offset)
  if (candidates.length > 0) return Math.min(...candidates)
  // Neither offset of the day fits (another transition within it): the offset at the guess itself, else before the gap.
  const near = zoneOffsetMs(zone, guess)
  return fits(near) ? guess - near : guess - before
}

/** The wall clock `zone` shows at an instant. */
export function epochToWall(epoch: number, zone: string): Wall {
  const shifted = new Date(epoch + zoneOffsetMs(zone, epoch))
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    s: shifted.getUTCSeconds(),
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of a wall clock. */
export const dateKey = (wall: Wall): string => `${wall.y}-${pad(wall.m)}-${pad(wall.d)}`

/** `HH:MM` of an instant in `zone`. */
export function timeText(epoch: number, zone: string): string {
  const wall = epochToWall(epoch, zone)
  return `${pad(wall.h)}:${pad(wall.mi)}`
}

/** Midnight at the start of the day (in `zone`) holding `epoch`. */
export function startOfDay(epoch: number, zone: string): number {
  const wall = epochToWall(epoch, zone)
  return wallToEpoch({ ...wall, h: 0, mi: 0, s: 0 }, zone)
}

/** Midnight `days` calendar days after the day holding `epoch` (DST-safe: it moves the date, not 24 h). */
export function addDays(epoch: number, days: number, zone: string): number {
  const wall = epochToWall(epoch, zone)
  const moved = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + days))
  return wallToEpoch({ y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate(), h: 0, mi: 0, s: 0 }, zone)
}

/** Day of the week of a wall date: 0 = Sunday. */
export const weekdayOf = (wall: Pick<Wall, 'y' | 'm' | 'd'>): number => new Date(Date.UTC(wall.y, wall.m - 1, wall.d)).getUTCDay()

/** The instant at `HH:MM` on the day holding `epoch`, in `zone`. */
export function atTime(epoch: number, hhmm: { h: number; mi: number }, zone: string): number {
  const wall = epochToWall(epoch, zone)
  return wallToEpoch({ ...wall, h: hhmm.h, mi: hhmm.mi, s: 0 }, zone)
}

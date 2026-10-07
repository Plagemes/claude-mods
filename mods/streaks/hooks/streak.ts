const DAY_MS = 86_400_000
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const LABEL = '      '
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A calendar day as a whole number (days since 1970-01-01), so a day before or after is plain arithmetic. */
export type DayNumber = number

export type Run = { length: number; end: DayNumber }

export const dayNumber = (year: number, monthIndex: number, day: number): DayNumber => Math.floor(Date.UTC(year, monthIndex, day) / DAY_MS)

/** `2026-10-07`. */
export const isoOf = (day: DayNumber): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

export const parseIso = (iso: string): DayNumber | undefined => {
  const match = ISO_DAY.exec(iso)
  return match === null ? undefined : dayNumber(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** The calendar day a moment falls on by the person's own clock. */
export const localDay = (ms: number): DayNumber => {
  const date = new Date(ms)
  return dayNumber(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * The streak that is alive: the run of consecutive active days ending today, or ending yesterday when today has no prompt yet
 * (it is still yours to extend). 0 when neither day was active.
 */
export const currentStreak = (active: ReadonlySet<DayNumber>, today: DayNumber): number => {
  const end = active.has(today) ? today : active.has(today - 1) ? today - 1 : undefined
  if (end === undefined) return 0
  let length = 0
  while (active.has(end - length)) length += 1
  return length
}

/** The longest run of consecutive active days among `active`, and the day it ended. */
export const longestStreak = (active: ReadonlySet<DayNumber>): Run => {
  let best: Run = { length: 0, end: 0 }
  let length = 0
  let previous: DayNumber | undefined
  for (const day of [...active].sort((a, b) => a - b)) {
    length = previous !== undefined && day === previous + 1 ? length + 1 : 1
    previous = day
    if (length > best.length) best = { length, end: day }
  }
  return best
}

/** `1 day`, `12 days`. */
export const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`

/** The milestone lengths from a setting like `7, 30,100`: whole numbers above 1, ascending, no repeats. */
export const parseMilestones = (setting: string): number[] => [
  ...new Set(
    setting
      .split(',')
      .map(part => Number.parseInt(part.trim(), 10))
      .filter(length => Number.isInteger(length) && length > 1),
  ),
].sort((a, b) => a - b)

/**
 * The last `span` days as weeks, Monday first: `●` an active day, `·` a quiet one, today in brackets. Days outside
 * the span are blank, and each row is labelled with the date of its Monday.
 */
export const calendar = (active: ReadonlySet<DayNumber>, today: DayNumber, span: number): string[] => {
  const first = today - (span - 1)
  const weekday = (day: DayNumber): number => (((day + 3) % 7) + 7) % 7 // 0 is Monday: 1970-01-01 was a Thursday
  const rows = [`${LABEL}${WEEKDAYS.map(letter => ` ${letter} `).join('')}`.trimEnd()]
  for (let monday = first - weekday(first); monday <= today; monday += 7) {
    const date = new Date(monday * DAY_MS)
    const label = `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}`
    const cells = Array.from({ length: 7 }, (_, i) => {
      const day = monday + i
      if (day < first || day > today) return '   '
      const mark = active.has(day) ? '●' : '·'
      return day === today ? `[${mark}]` : ` ${mark} `
    })
    rows.push(`${label}${cells.join('')}`.trimEnd())
  }
  return rows
}

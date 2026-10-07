/** What one ISO week holds: edits per language and commands per tool. */
export type Week = { lang: Record<string, number>; tool: Record<string, number> }

export const DAY_MS = 86_400_000
export const WEEKS_SHOWN = 8
export const BAR_WIDTH = 20

export const emptyWeek = (): Week => ({ lang: {}, tool: {} })

/** The ISO 8601 week (Monday first, week 1 holds the first Thursday) of a moment in local time, as `2026-W41`. */
export const isoWeekKey = (ms: number): string => {
  const local = new Date(ms)
  const date = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const week = Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The week keys of the last `count` weeks, oldest first, the one holding `now` last. */
export const recentWeeks = (now: number, count: number): string[] => {
  const keys: string[] = []
  for (let back = count - 1; back >= 0; back -= 1) keys.push(isoWeekKey(now - back * 7 * DAY_MS))
  return [...new Set(keys)]
}

const asCounts = (value: unknown): Record<string, number> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n > 0))
    : {}

/** A stored week, keeping only sane counts: the store is a file other versions may have written. */
export const asWeek = (value: unknown): Week => {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { lang: asCounts(record.lang), tool: asCounts(record.tool) }
}

const addCounts = (into: Record<string, number>, from: Readonly<Record<string, number>>): void => {
  for (const [name, n] of Object.entries(from)) into[name] = (into[name] ?? 0) + n
}

export const mergeWeeks = (weeks: readonly Week[]): Week => {
  const total = emptyWeek()
  for (const week of weeks) {
    addCounts(total.lang, week.lang)
    addCounts(total.tool, week.tool)
  }
  return total
}

/** Entries by count, biggest first, ties in name order. */
export const ranked = (counts: Readonly<Record<string, number>>): [string, number][] =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

const sum = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((a, b) => a + b, 0)

/** Rows of `name  ████░░  n`, the bars scaled to the biggest count shown. */
export const bars = (counts: Readonly<Record<string, number>>, top: number): string[] => {
  const rows = ranked(counts).slice(0, top)
  const biggest = rows[0]?.[1] ?? 0
  const width = Math.max(0, ...rows.map(([name]) => name.length))
  return rows.map(([name, n]) => {
    const cells = Math.max(1, Math.round((n / biggest) * BAR_WIDTH))
    return `  ${name.padEnd(width)}  ${'█'.repeat(cells).padEnd(BAR_WIDTH)}  ${n}`
  })
}

const listOf = (title: string, counts: Readonly<Record<string, number>>, top: number): string[] =>
  Object.keys(counts).length === 0 ? [] : [title, ...bars(counts, top), '']

const names = (counts: Readonly<Record<string, number>>, limit: number): string =>
  ranked(counts).slice(0, limit).map(([name]) => name).join(', ') || '-'

/** The text of /my-skills: this week with bars, the last weeks together, then a line per week. */
export const report = (keys: readonly string[], weeks: ReadonlyMap<string, Week>, top: number): string => {
  const current = keys.at(-1) ?? ''
  const all = keys.map(key => weeks.get(key) ?? emptyWeek())
  const now = all.at(-1) ?? emptyWeek()
  const total = mergeWeeks(all)
  if (Object.keys(total.lang).length === 0 && Object.keys(total.tool).length === 0) {
    return 'Nothing tracked yet. Edit a file or run a command with Claude and it shows up here.'
  }
  const thisWeek = Object.keys(now.lang).length === 0 && Object.keys(now.tool).length === 0
    ? ['Nothing yet this week.', '']
    : [...listOf('Languages (edits)', now.lang, top), ...listOf('Tools (commands)', now.tool, top)]
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  const rows = keys.map((key, index) => {
    const week = all[index] ?? emptyWeek()
    return { key, week, edits: plural(sum(week.lang), 'edit'), commands: plural(sum(week.tool), 'command') }
  })
  const editsWidth = Math.max(...rows.map(row => row.edits.length))
  const commandsWidth = Math.max(...rows.map(row => row.commands.length))
  const perWeek = rows.map(({ key, week, edits, commands }) =>
    sum(week.lang) + sum(week.tool) === 0
      ? `  ${key}  -`
      : `  ${key}  ${edits.padEnd(editsWidth)} · ${commands.padEnd(commandsWidth)} · ${names(week.lang, 3)} / ${names(week.tool, 3)}`,
  )
  return [
    '```',
    `This week (${current})`,
    '',
    ...thisWeek,
    `Last ${keys.length} weeks (${keys[0]} to ${current})`,
    '',
    ...listOf('Languages (edits)', total.lang, top),
    ...listOf('Tools (commands)', total.tool, top),
    'By week',
    ...perWeek,
    '```',
  ].join('\n')
}

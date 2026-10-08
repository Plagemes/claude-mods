import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Activity } from '../types'
import { paneFailure } from './shared/render-safe'

const PANE = 'activity-heatmap'
const COMMAND = 'heatmap'
const STORE_KEY = 'activity'
const DAYS = 7
const HOURS = 24
const SLOTS = DAYS * HOURS
const LABEL_COLUMNS = 4
const TOTAL_COLUMNS = 7
const MAX_CELL_COLUMNS = 3
const HOUR_TICK = 3

/** Prompts a person sent: typed, from a remote client, or through the desktop app's SDK host. */
const COUNTED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Raster's color for "the terminal's default". */
const DEFAULT_COLOR = 0x01000000

/** Five levels, each a glyph and a color, so the map reads in color and in monochrome alike. */
const LEVELS = [
  { glyph: '·', rgb: 0x6b7280 },
  { glyph: '░', rgb: 0x3b82f6 },
  { glyph: '▒', rgb: 0x22c55e },
  { glyph: '▓', rgb: 0xeab308 },
  { glyph: '█', rgb: 0xf97316 },
] as const

const RESET_CONFIRM = 'Reset'

const activity = atom({ plugin: 'activity-heatmap', key: 'activity' } as const, { counts: [], since: 0 })

const settings = { weekStartsMonday: true }

const emptyActivity = (): Activity => ({ counts: new Array<number>(SLOTS).fill(0), since: 0 })

/** What the store holds, or an empty map when it holds nothing usable. */
const normalize = (stored: unknown): Activity => {
  if (typeof stored !== 'object' || stored === null) return emptyActivity()
  const { counts, since } = stored as Partial<Record<keyof Activity, unknown>>
  const isValid =
    Array.isArray(counts) &&
    counts.length === SLOTS &&
    counts.every(count => typeof count === 'number' && Number.isFinite(count) && count >= 0)
  return isValid
    ? { counts: counts.map(count => Math.floor(Number(count))), since: typeof since === 'number' ? since : 0 }
    : emptyActivity()
}

const levelOf = (count: number, max: number): number =>
  count <= 0 || max <= 0 ? 0 : Math.min(LEVELS.length - 1, Math.ceil((count / max) * (LEVELS.length - 1)))

const css = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const shortDate = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''} ${date.getFullYear()}`
}

const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

/** The weekdays top to bottom, as indices into DAY_SHORT. */
const dayOrder = (): number[] =>
  Array.from({ length: DAYS }, (_, row) => (settings.weekStartsMonday ? (row + 1) % DAYS : row))

const countAt = (data: Activity, day: number, hour: number): number => data.counts[day * HOURS + hour] ?? 0

/** Packs Raster cells: little-endian u32 triplets `[codePoint, foreground, background]`, base64. */
const packCells = (cells: readonly (readonly [string, number])[]): string => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(([glyph, rgb], index) => {
    words[index * 3] = glyph.codePointAt(0) ?? 0x20
    words[index * 3 + 1] = rgb
    words[index * 3 + 2] = DEFAULT_COLOR
  })
  let binary = ''
  for (const byte of new Uint8Array(words.buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

type Summary = {
  total: number
  max: number
  peakSlot?: { day: number; hour: number; count: number }
  peakDay?: { day: number; count: number }
  peakHour?: { hour: number; count: number }
}

const summarize = (data: Activity): Summary => {
  const total = data.counts.reduce((sum, count) => sum + count, 0)
  const max = Math.max(0, ...data.counts)
  if (total === 0) return { total, max }
  const peakIndex = data.counts.indexOf(max)
  const dayTotals = Array.from({ length: DAYS }, (_, day) =>
    Array.from({ length: HOURS }, (__, hour) => countAt(data, day, hour)).reduce((a, b) => a + b, 0),
  )
  const hourTotals = Array.from({ length: HOURS }, (_, hour) =>
    Array.from({ length: DAYS }, (__, day) => countAt(data, day, hour)).reduce((a, b) => a + b, 0),
  )
  const peakDay = dayTotals.indexOf(Math.max(...dayTotals))
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals))
  return {
    total,
    max,
    peakSlot: { day: Math.floor(peakIndex / HOURS), hour: peakIndex % HOURS, count: max },
    peakDay: { day: peakDay, count: dayTotals[peakDay] ?? 0 },
    peakHour: { hour: peakHour, count: hourTotals[peakHour] ?? 0 },
  }
}

const dayTotal = (data: Activity, day: number): number =>
  Array.from({ length: HOURS }, (_, hour) => countAt(data, day, hour)).reduce((a, b) => a + b, 0)

/** The hour axis over the grid: a label every HOUR_TICK hours, each hour `cell` columns wide. */
const hourAxis = (cell: number): string => {
  let axis = ''
  for (let hour = 0; hour < HOURS; hour += 1) {
    if (axis.length > hour * cell) continue
    axis = axis.padEnd(hour * cell)
    if (hour % HOUR_TICK === 0) axis += String(hour)
  }
  return axis.padEnd(HOURS * cell)
}

async function load($: EngineInterface): Promise<Activity> {
  const stored = normalize(await $.store.get(STORE_KEY))
  await update($, activity, () => stored)
  return stored
}

/** Counts one prompt at `at`; the store is the record, so concurrent sessions add up. */
async function record($: EngineInterface, at: number): Promise<void> {
  const stored = normalize(await $.store.get(STORE_KEY))
  const date = new Date(at)
  const slot = date.getDay() * HOURS + date.getHours()
  const counts = stored.counts.map((count, index) => (index === slot ? count + 1 : count))
  const next: Activity = { counts, since: stored.since > 0 ? stored.since : at }
  await $.store.set(STORE_KEY, next)
  await update($, activity, () => next)
}

export const register: Register = (on, options) => {
  settings.weekStartsMonday = options.weekStart !== 'sunday'

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: COMMAND,
      description: 'Show when you use Claude Code: a heat map of prompts by weekday and hour',
      argumentHint: '[reset]',
    })
    try {
      await load($)
    } catch (error) {
      $.ui.log(`activity-heatmap: could not read its history: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined || !COUNTED_ORIGINS.has(e.origin.kind)) return entered
    try {
      await record($, await $.clock.now())
    } catch (error) {
      $.ui.log(`activity-heatmap: could not count a prompt: ${String(error)}`, { to: 'debug' })
    }
    return entered
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      const answer = await $.ui
        .ask('Erase every prompt the heat map has counted?', [RESET_CONFIRM, 'Cancel'])
        .catch(() => undefined)
      if (answer !== RESET_CONFIRM) return { text: 'Nothing was erased.' }
      await $.store.delete(STORE_KEY)
      await update($, activity, emptyActivity)
      return { text: 'History erased.' }
    }
    const data = await load($)
    const { total, peakSlot } = summarize(data)
    const opened = await $.ui.open({ id: PANE, title: 'Activity' })
    const line =
      peakSlot === undefined
        ? 'No prompts counted yet; the map fills in as you work.'
        : `${grouped(total)} prompts, busiest at ${DAY_SHORT[peakSlot.day]} ${hourLabel(peakSlot.hour)}.`
    return { text: opened.isPlaced ? line : `${line} The pane waits for room (${opened.reason}).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = normalize(await read($, activity))
    const summary = summarize(data)
    const days = dayOrder()
    const room = e.props.bodyColumns - LABEL_COLUMNS - TOTAL_COLUMNS
    const cell = Math.max(1, Math.min(MAX_CELL_COLUMNS, Math.floor(room / HOURS)))
    const gridColumns = HOURS * cell
    const levelOfCount = (count: number) => LEVELS[levelOf(count, summary.max)] ?? LEVELS[0]

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Activity by weekday and hour</Text>
        <Text dimColor>
          {summary.total === 0 ? 'no prompts yet' : `${grouped(summary.total)} prompts since ${shortDate(data.since)}`}
        </Text>
      </Box>
    )

    const labels = (
      <Box flexDirection="column" width={LABEL_COLUMNS}>
        {days.map(day => (
          <Text dimColor>{DAY_SHORT[day]}</Text>
        ))}
      </Box>
    )

    const totals = (
      <Box flexDirection="column" width={TOTAL_COLUMNS} alignItems="flex-end">
        {days.map(day => (
          <Text dimColor>{grouped(dayTotal(data, day))}</Text>
        ))}
      </Box>
    )

    let grid: RenderElement
    let legendSwatches: RenderElement
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const cells = days.flatMap(day =>
        Array.from({ length: HOURS }, (_, hour) => {
          const level = levelOfCount(countAt(data, day, hour))
          return Array.from({ length: cell }, () => [level.glyph, level.rgb] as const)
        }).flat(),
      )
      grid = <Raster key="grid" columns={gridColumns} rows={DAYS} cells={packCells(cells)} />
      legendSwatches = (
        <Raster
          key="legend"
          columns={LEVELS.length * 2}
          rows={1}
          cells={packCells(LEVELS.flatMap(level => [[level.glyph, level.rgb] as const, [' ', DEFAULT_COLOR] as const]))}
        />
      )
    } else {
      grid = (
        <Box key="grid" flexDirection="column" width={gridColumns}>
          {days.map(day => (
            <Text>
              {Array.from({ length: HOURS }, (_, hour) => {
                const level = levelOfCount(countAt(data, day, hour))
                return <Text color={css(level.rgb)}>{level.glyph.repeat(cell)}</Text>
              })}
            </Text>
          ))}
        </Box>
      )
      legendSwatches = (
        <Text>
          {LEVELS.map(level => (
            <Text color={css(level.rgb)}>{`${level.glyph} `}</Text>
          ))}
        </Text>
      )
    }

    const facts =
      summary.peakSlot === undefined || summary.peakDay === undefined || summary.peakHour === undefined
        ? ['Every prompt you send is counted here, by weekday and hour.']
        : [
            `Busiest slot  ${DAY_SHORT[summary.peakSlot.day]} ${hourLabel(summary.peakSlot.hour)} (${grouped(summary.peakSlot.count)})`,
            `Busiest day   ${DAY_LONG[summary.peakDay.day]} (${grouped(summary.peakDay.count)})`,
            `Busiest hour  ${hourLabel(summary.peakHour.hour)} (${grouped(summary.peakHour.count)})`,
          ]

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`${' '.repeat(LABEL_COLUMNS)}${hourAxis(cell)}`}</Text>
          <Box flexDirection="row">
            {labels}
            {grid}
            {totals}
          </Box>
        </Box>
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Text dimColor>{`${' '.repeat(LABEL_COLUMNS - 1)}less`}</Text>
          {legendSwatches}
          <Text dimColor>more · peak {grouped(summary.max)} in one hour</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {facts.map(fact => (
            <Text>{fact}</Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Button key="close" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'activity-heatmap', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DailySpendDay, DailySpendSnapshot } from '../types'
import { dayKey, lastDays, shortDate, weekStart, weekdayDate } from './calendar'
import { barChartCells } from './chart'
import { costOf } from './pricing'

const NAME = 'daily-spend'
const PANE = 'daily-spend'
const DAY_PREFIX = 'day:'
const ALERTED_KEY = 'alertedOn'
const CHART_DAYS = 14
const RETAIN_DAYS = 120
const CHART_ROWS = 5
const CHART_GAP = 1
const TOP_PROJECTS = 5
const BAR_CELLS = 12
const TOAST_MS = 8000
const BAR_COLOR = 0x5b8def
const TODAY_COLOR = 0xd97757
const OVER_COLOR = 0xe5534b

const snapshot = atom({ plugin: 'daily-spend', key: 'snapshot' } as const, null)

const dollars = (n: number): string => `$${n.toFixed(2)}`

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

const dayTotal = (day: DailySpendDay | undefined): number => sum(Object.values(day ?? {}))

const projectName = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root

const bar = (value: number, max: number): string => '█'.repeat(max > 0 ? Math.max(1, Math.round((value / max) * BAR_CELLS)) : 0)

/** A stored day, keeping only finite amounts: the store is a file other versions may have written. */
const asDay = (value: unknown): DailySpendDay =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, usd]) => typeof usd === 'number' && Number.isFinite(usd)))
    : {}

type Summary = {
  dates: Date[]
  totals: number[]
  today: number
  week: number
  fortnight: number
  projects: [string, number][]
}

const summarize = (shot: DailySpendSnapshot): Summary => {
  const dates = lastDays(shot.asOf, CHART_DAYS)
  const keys = dates.map(dayKey)
  const totals = keys.map(key => dayTotal(shot.days[key]))
  const weekFrom = dayKey(weekStart(shot.asOf))
  const byProject = new Map<string, number>()

  for (const key of keys) {
    for (const [root, usd] of Object.entries(shot.days[key] ?? {})) byProject.set(root, (byProject.get(root) ?? 0) + usd)
  }

  return {
    dates,
    totals,
    today: totals.at(-1) ?? 0,
    week: sum(totals.filter((_, i) => (keys[i] ?? '') >= weekFrom)),
    fortnight: sum(totals),
    projects: [...byProject].sort((a, b) => b[1] - a[1]).slice(0, TOP_PROJECTS),
  }
}

/** Reads the last fortnight from the store into the snapshot the pane draws. */
async function loadSnapshot($: EngineInterface): Promise<DailySpendSnapshot> {
  const asOf = await $.clock.now()
  const keys = lastDays(asOf, CHART_DAYS).map(dayKey)
  const stored = await Promise.all(keys.map(key => $.store.get(DAY_PREFIX + key)))
  const shot = { asOf, days: Object.fromEntries(keys.map((key, i) => [key, asDay(stored[i])])) }
  await update($, snapshot, () => shot)

  return shot
}

/** Adds one turn's cost to today's figure for the session's project; toasts once a day past the limit. */
async function addSpend($: EngineInterface, usd: number, dailyLimit: number): Promise<void> {
  const now = await $.clock.now()
  const day = dayKey(new Date(now))
  const project = await $.session.root()
  const before = asDay(await $.store.get(DAY_PREFIX + day))
  const after = { ...before, [project]: (before[project] ?? 0) + usd }

  await $.store.set(DAY_PREFIX + day, after)
  await update($, snapshot, shot => (shot === null ? null : { asOf: now, days: { ...shot.days, [day]: after } }))

  const today = dayTotal(after)
  if (dailyLimit > 0 && today > dailyLimit && (await $.store.get(ALERTED_KEY)) !== day) {
    await $.store.set(ALERTED_KEY, day)
    $.ui.toast(`Today's spend ${dollars(today)} passed your ${dollars(dailyLimit)} daily limit.`, { timeoutMs: TOAST_MS })
  }
}

/** Drops the days older than the retention window. */
async function pruneOldDays($: EngineInterface): Promise<void> {
  const oldest = dayKey(lastDays(await $.clock.now(), RETAIN_DAYS)[0] ?? new Date(0))
  const stale = (await $.store.keys()).filter(key => key.startsWith(DAY_PREFIX) && key.slice(DAY_PREFIX.length) < oldest)
  await Promise.all(stale.map(key => $.store.delete(key)))
}

export const register: Register = (on, options: PluginOptions) => {
  const dailyLimit = typeof options.dailyLimit === 'number' && options.dailyLimit > 0 ? options.dailyLimit : 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend',
      description: 'Open the spend pane: today, this week, the last 14 days and top projects',
    })

    try {
      await pruneOldDays($)
    } catch (error) {
      $.ui.log(`${NAME}: could not prune old days: ${String(error)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage

    if (usage !== undefined) {
      try {
        await addSpend($, costOf(usage), dailyLimit)
      } catch (error) {
        $.ui.log(`${NAME}: could not record this turn: ${String(error)}`, { to: 'debug' })
      }
    }

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    const { today, week } = summarize(await loadSnapshot($))
    const opened = await $.ui.open({ id: PANE, title: 'Spend' })
    const line = `Today ${dollars(today)} · this week ${dollars(week)}`

    return { text: opened.isPlaced ? line : `${line} (the pane waits for a wider terminal)` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shot = await read($, snapshot)

    if (shot === null) return <Text dimColor>Run /spend to load the figures.</Text>

    const { dates, totals, today, week, fortnight, projects } = summarize(shot)
    const isOverToday = dailyLimit > 0 && today > dailyLimit
    const peak = Math.max(...totals)
    const peakDate = dates[totals.indexOf(peak)]
    const colorOf = (usd: number, i: number): number =>
      dailyLimit > 0 && usd > dailyLimit ? OVER_COLOR : i === totals.length - 1 ? TODAY_COLOR : BAR_COLOR

    const chart = () => {
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const { cells, columns } = barChartCells(
          totals.map((value, i) => ({ value, color: colorOf(value, i) })),
          CHART_ROWS,
          CHART_GAP,
        )
        const first = shortDate(dates[0] ?? new Date(shot.asOf))

        return (
          <Box flexDirection="column">
            <Raster key="chart" columns={columns} rows={CHART_ROWS} cells={cells} />
            <Text dimColor>{`${first}${' '.repeat(Math.max(1, columns - first.length - 5))}today`}</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {dates.map((date, i) => {
            const usd = totals[i] ?? 0
            return (
              <Box key={`day-${i}`} gap={1}>
                <Text dimColor>{weekdayDate(date).padEnd(6)}</Text>
                <Text color={i === totals.length - 1 ? 'claude' : usd > dailyLimit && dailyLimit > 0 ? 'error' : 'suggestion'}>
                  {bar(usd, peak) || '·'}
                </Text>
                <Text dimColor>{usd > 0 ? dollars(usd) : ''}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold>Today</Text>
            <Text bold color={isOverToday ? 'error' : undefined}>
              {dollars(today)}
            </Text>
            {dailyLimit > 0 && <Text dimColor>{`of ${dollars(dailyLimit)} limit`}</Text>}
          </Box>
          <Box gap={1}>
            <Text>This week</Text>
            <Text>{dollars(week)}</Text>
            <Text dimColor>{`since ${shortDate(weekStart(shot.asOf))}`}</Text>
          </Box>
          <Box gap={1}>
            <Text>14 days</Text>
            <Text>{dollars(fortnight)}</Text>
            <Text dimColor>{`${dollars(fortnight / CHART_DAYS)}/day`}</Text>
          </Box>
        </Box>
        <Box flexDirection="column">
          <Text bold>Last 14 days</Text>
          {chart()}
          {peak > 0 && peakDate !== undefined && <Text dimColor>{`peak ${dollars(peak)} on ${weekdayDate(peakDate)}`}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Top projects</Text>
          {projects.length === 0 && <Text dimColor>Nothing spent in the last 14 days.</Text>}
          {projects.map(([root, usd]) => (
            <Box key={root} gap={1}>
              <Text wrap="truncate-end">{projectName(root)}</Text>
              <Text color="suggestion">{bar(usd, projects[0]?.[1] ?? usd)}</Text>
              <Text dimColor>{dollars(usd)}</Text>
            </Box>
          ))}
        </Box>
        <Box gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void loadSnapshot($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

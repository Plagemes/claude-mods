import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput } from 'claude-code'

import type { DailySpendDay, DailySpendSnapshot } from '../types'
import { dayKey, lastDays, shortDate, weekStart, weekdayDate } from './calendar'
import { barChartCells } from './chart'
import { costOf } from './shared/prices'

const NAME = 'daily-spend'
const PANE = 'daily-spend'
/** The hub's shared panel, and this mod's tab in it (order 90: Cost, per the platform's tab order). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'cost', title: 'Cost', order: 90, command: 'spend' } as const
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
  await shareToday($, day, today, dailyLimit)
  if (dailyLimit > 0 && today > dailyLimit && (await $.store.get(ALERTED_KEY)) !== day) {
    await $.store.set(ALERTED_KEY, day)
    await alertLimit($, today, dailyLimit)
  }
}

/**
 * Past the daily limit: `budget.threshold` on the hub's bus and a warning through its notifications (your
 * channels while you are away); without the hub, this mod's own toast.
 */
async function alertLimit($: EngineInterface, today: number, dailyLimit: number): Promise<void> {
  const text = `Today's spend ${dollars(today)} passed your ${dollars(dailyLimit)} daily limit.`
  await hubPublish($, {
    topic: 'budget.threshold',
    data: { kind: 'usd', scope: 'day', used: today, limit: dailyLimit, percent: Math.round((today / dailyLimit) * 100) },
    scope: 'global',
  })
  try {
    await $.mods.notify({ level: 'warning', title: text, body: 'Across all sessions today. /spend shows where it went.', topic: 'budget.threshold' })
  } catch {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  }
}

/** The fact `daily-spend.today` on the hub's blackboard (what every session spent today); nothing without the hub. */
async function shareToday($: EngineInterface, day: string, today: number, dailyLimit: number): Promise<void> {
  try {
    await $.mods.share({ name: 'today', value: { date: day, usd: Math.round(today * 10_000) / 10_000, limit: dailyLimit > 0 ? dailyLimit : null } })
  } catch {
    // No hub: /spend tells it.
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, the Cost tab in its panel, and the figures that tab draws. */
async function greetHub($: EngineInterface, dailyLimit: number): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['budget.threshold'], consumes: [] }, TAB)
  const shot = await loadSnapshot($)
  await shareToday($, dayKey(new Date(shot.asOf)), summarize(shot).today, dailyLimit)
}

/** `/spend`: the Cost tab of the hub's panel when the hub is installed, this mod's own pane otherwise. */
async function openSpend($: EngineInterface): Promise<string> {
  const { today, week } = summarize(await loadSnapshot($))
  const line = `Today ${dollars(today)} · this week ${dollars(week)}`
  if (await hubShowTab($, TAB.id)) return line
  const opened = await $.ui.open({ id: PANE, title: 'Spend' })

  return opened.isPlaced ? line : `${line} (the pane waits for a wider terminal)`
}

/** Drops the days older than the retention window. */
async function pruneOldDays($: EngineInterface): Promise<void> {
  const oldest = dayKey(lastDays(await $.clock.now(), RETAIN_DAYS)[0] ?? new Date(0))
  const stale = (await $.store.keys()).filter(key => key.startsWith(DAY_PREFIX) && key.slice(DAY_PREFIX.length) < oldest)
  await Promise.all(stale.map(key => $.store.delete(key)))
}

/** The spend view: this mod's own pane, or its tab in the hub's panel (`isTab`, no Close button). */
async function drawSpend($: EngineInterface, e: RenderInput<'Pane'>, dailyLimit: number, isTab: boolean): Promise<RenderElement> {
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
        {isTab ? null : <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
    </Box>
  )
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
    await greetHub($, dailyLimit)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage

    if (usage !== undefined) {
      try {
        await addSpend($, costOf(usage, usage.model).usd, dailyLimit)
      } catch (error) {
        $.ui.log(`${NAME}: could not record this turn: ${String(error)}`, { to: 'debug' })
      }
    }

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => ({ text: await openSpend($) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawSpend($, e, dailyLimit, false))

  // The Cost tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawSpend($, e, dailyLimit, true)}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:3ade61508f36: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts

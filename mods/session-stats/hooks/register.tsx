import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, ToolCallInput } from 'claude-code'

import type { SessionStatsData, SessionStatsHub } from '../types'
import { EMPTY_STATS, bar, compact, fit, formatCost, formatDuration, toolLabel, topTools } from './format'
import { EMPTY_HUB, describeRun, foldEvents, toolsPerTurn } from './hubstats'
import { hubTabBelow, paneFailure } from './shared/render-safe'

const PANE = 'session-stats'
/** The hub's shared panel, and this mod's tab in it (order 290: among the later tabs, after Notes). */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'stats', title: 'Stats', order: 290, command: 'session-stats' } as const
/** mods-hub publishes `cost.update` and `turn.finished` from a timer just after the turn ends; wait for it. */
const HUB_SETTLE_MS = 250
const DESCRIPTION = 'Show a dashboard of this session: turns, tools, tokens, cost, time and files'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOP_TOOLS = 5
const NAME_WIDTH = 16
const MIN_TILE_WIDTH = 20
const MAX_TILE_WIDTH = 30
const TILES_PER_ROW = 3

const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, EMPTY_STATS)
const hubStats = atom({ plugin: 'session-stats', key: 'hub' } as const, EMPTY_HUB)

/** What this load knows about the hub: it is installed, and the stamp of the newest event of its bus already counted. */
type Hub = { isHubbed: boolean; seenAt: number }

type Tile = { title: string; value: string; details: string[] }

export const register: Register = on => {
  const hub: Hub = { isHubbed: false, seenAt: 0 }

  on('session.start', async ($, e, next) => {
    // Claude Code 2.1 ships /stats as an alias of its own /usage and refuses the name;
    // /session-stats always registers, and /stats is claimed wherever it is free.
    await $.command.register({ name: 'stats', description: DESCRIPTION }).catch(() => undefined)
    await $.command.register({ name: 'session-stats', description: DESCRIPTION }).catch(() => undefined)
    // The hub hello and the first figures wait until session.start has returned (afterStart): with every mod
    // installed, waiting on them here ran this hook past its 10 s budget.
    afterStart($, 'session-stats', async () => {
      await greetHub($, hub)
      await takeSnapshot($, hub)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, stats, () => EMPTY_STATS)
      await update($, hubStats, () => EMPTY_HUB)
      hub.seenAt = await $.clock.now()
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined) await update($, stats, value => ({ ...value, prompts: value.prompts + 1 }))
    return entered
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const tool = String(e.tool)
    const isFailed = ran.isError === true
    const edited = isFailed || !EDIT_TOOLS.has(tool) ? undefined : editedPath(e)
    await update($, stats, value => ({
      ...value,
      tools: { ...value.tools, [tool]: (value.tools[tool] ?? 0) + 1 },
      toolErrors: value.toolErrors + (isFailed ? 1 : 0),
      filesEdited:
        edited === undefined || value.filesEdited.includes(edited) ? value.filesEdited : [...value.filesEdited, edited],
    }))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = e.usage ?? done.usage
    const isMain = e.agentId === undefined
    await update($, stats, value => ({
      ...value,
      turns: value.turns + (isMain ? 1 : 0),
      busyMs: value.busyMs + (isMain ? e.durationMs : 0),
      tokens:
        usage === undefined
          ? value.tokens
          : {
              input: value.tokens.input + usage.input_tokens,
              output: value.tokens.output + usage.output_tokens,
              cacheRead: value.tokens.cacheRead + usage.cache_read_input_tokens,
              cacheWrite: value.tokens.cacheWrite + usage.cache_creation_input_tokens,
            },
    }))
    if (isMain) {
      await takeSnapshot($, hub)
      if (hub.isHubbed) $.clock.after(HUB_SETTLE_MS, () => void pullHub($, hub))
    }
    return done
  })

  // `/session-stats`: the Stats tab of the hub's panel when the hub is installed, this mod's own pane otherwise.
  on('command.run', { command: ['stats', 'session-stats'] }, async $ => {
    await takeSnapshot($, hub)
    if (!(await hubShowTab($, TAB.id))) await $.ui.open({ id: PANE, title: 'Session stats' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawStats($, e, hub)).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'session-stats', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )

  // The Stats tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {hubTabBelow(await next(e))}
        {await drawStats($, e, hub)}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'session-stats', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** The dashboard: this mod's own pane, or the Stats tab of the hub's panel (the same tiles). */
async function drawStats($: EngineInterface, e: RenderInput<'Pane'>, hub: Hub): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const current = await read($, stats)
  const bus = await read($, hubStats)
  const columns = e.props.bodyColumns
  const tileWidth = Math.max(MIN_TILE_WIDTH, Math.min(MAX_TILE_WIDTH, Math.floor((columns - TILES_PER_ROW + 1) / TILES_PER_ROW)))
  const top = topTools(current.tools, TOP_TOOLS)
  const most = top[0]?.[1] ?? 0
  const barWidth = Math.max(8, columns - NAME_WIDTH - 10)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {tilesOf(current, hub.isHubbed ? bus : undefined).map(tile => (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={tileWidth}>
            <Text dimColor>{tile.title}</Text>
            <Text bold>{tile.value}</Text>
            {tile.details.map(detail => (
              <Text dimColor wrap="truncate-end">
                {detail}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Top tools</Text>
        {top.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {top.map(([tool, count]) => (
          <Box flexDirection="row" gap={1}>
            <Text>{fit(toolLabel(tool), NAME_WIDTH)}</Text>
            <Text color="claude">{bar(count, most, barWidth)}</Text>
            <Text dimColor>{count}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void takeSnapshot($, hub)} />
      </Box>
    </Box>
  )
}

/** The dashboard's tiles, in reading order. */
/** With the hub (`bus` given) the dashboard adds a Tests tile, the average tools per turn, and the hub's priced cost where the engine keeps no ledger. */
const tilesOf = (current: SessionStatsData, bus?: SessionStatsHub): Tile[] => {
  const calls = Object.values(current.tools).reduce((sum, count) => sum + count, 0)
  const { input, output, cacheRead, cacheWrite } = current.tokens
  const wallMs = current.startedAt === null || current.takenAt === null ? 0 : current.takenAt - current.startedAt
  const lastEdited = current.filesEdited.at(-1)
  const costUsd = current.costUsd ?? bus?.sessionUsd ?? null
  const perTurn = bus === undefined ? undefined : toolsPerTurn(bus)
  const tiles: Tile[] = [
    {
      title: 'Turns',
      value: String(current.turns),
      details: [`${current.prompts} ${current.prompts === 1 ? 'prompt' : 'prompts'}`, ...(perTurn === undefined ? [] : [perTurn])],
    },
    {
      title: 'Tool calls',
      value: String(calls),
      details: [current.toolErrors === 0 ? 'none failed' : `${current.toolErrors} failed`],
    },
    {
      title: 'Tokens',
      value: compact(input + output + cacheRead + cacheWrite),
      details: [`in ${compact(input)} · out ${compact(output)}`, `cache ${compact(cacheRead)} read · ${compact(cacheWrite)} new`],
    },
    {
      title: 'Cost',
      value: `${current.costUsd === null && bus?.isEstimate === true ? '~' : ''}${formatCost(costUsd)}`,
      details: [
        current.costUsd === null && costUsd !== null ? "as the hub prices it" : 'as /usage counts it',
        ...(bus?.turnUsd == null ? [] : [`last turn ${formatCost(bus.turnUsd)}`]),
      ],
    },
    { title: 'Wall time', value: formatDuration(wallMs), details: [`${formatDuration(current.busyMs)} in turns`] },
    {
      title: 'Files edited',
      value: String(current.filesEdited.length),
      details: [lastEdited === undefined ? 'none yet' : `last ${lastEdited.slice(lastEdited.lastIndexOf('/') + 1)}`],
    },
  ]
  if (bus !== undefined) {
    tiles.push({
      title: 'Tests',
      value: bus.runs === 0 ? '—' : `${bus.runs} ${bus.runs === 1 ? 'run' : 'runs'}`,
      details: bus.lastRun === null ? ['none yet'] : [`last ${describeRun(bus.lastRun)}`, bus.failedRuns === 0 ? 'none failed' : `${bus.failedRuns} not passing`],
    })
  }
  return tiles
}

/** Takes the figures only the engine has (cost, the session's start) and the time they were taken. */
const takeSnapshot = async ($: EngineInterface, hub: Hub): Promise<void> => {
  const usage = await $.session.usage().catch(() => undefined)
  const now = await $.clock.now()
  await update($, stats, value => ({
    ...value,
    costUsd: usage?.cost?.usd ?? value.costUsd,
    startedAt: usage?.startedAt ?? value.startedAt ?? now,
    takenAt: now,
  }))
  await pullHub($, hub)
}

/** Counts what the hub's bus carried since the last look: test runs, finished turns and their tools, the priced cost. */
async function pullHub($: EngineInterface, hub: Hub): Promise<void> {
  if (!hub.isHubbed) return
  try {
    const events = await $.mods.recent({ since: hub.seenAt })
    if (events.length === 0) return
    hub.seenAt = Math.max(hub.seenAt, ...events.map(event => event.at))
    await update($, hubStats, total => foldEvents(total, events))
  } catch {
    // The hub went away: the figures it added stay as they were.
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

/** With mods-hub installed: hello (this mod reads `cost.update`, `test.result` and `turn.finished`) and the Stats tab in its panel. */
async function greetHub($: EngineInterface, hub: Hub): Promise<void> {
  if ((await hubMode($)) === undefined) return
  hub.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['cost.update', 'test.result', 'turn.finished'] }, TAB)
}

const editedPath = (e: ToolCallInput): string | undefined => {
  const input: Readonly<Record<string, unknown>> = e
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' && path !== '' ? path : undefined
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
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

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts

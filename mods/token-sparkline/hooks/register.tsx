import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, TurnUsage } from 'claude-code'

import { formatUsd } from './shared/prices'

const COMMAND = 'sparkline'
const MAX_POINTS = 40
const HIDDEN_KEY = 'isHidden'
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
/** Raster colors: the bars, the newest bar, and the terminal's default background. */
const BAR_RGB = 0xd97757
const LAST_RGB = 0xfbbf24
const DEFAULT_COLOR = 0x01000000
/** Columns the band keeps for its label, figures and Hide button before it gives the rest to the line. */
const MIN_SPARK_COLUMNS = 8

type Metric = 'total' | 'input' | 'output'

const METRIC_LABEL: Record<Metric, string> = {
  total: 'tokens/turn',
  input: 'input/turn',
  output: 'output/turn',
}

const points = atom({ plugin: 'token-sparkline', key: 'points' } as const, [])
const isHidden = atom({ plugin: 'token-sparkline', key: 'isHidden' } as const, false)

const settings: { metric: Metric } = { metric: 'total' }

const tokensOf = (usage: TurnUsage, metric: Metric): number => {
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return metric === 'input' ? input : metric === 'output' ? usage.output_tokens : input + usage.output_tokens
}

const compact = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k`
      : String(Math.round(tokens))

const barOf = (value: number, max: number): string =>
  BARS[max <= 0 ? 0 : Math.max(0, Math.min(BARS.length - 1, Math.ceil((value / max) * BARS.length) - 1))] ?? '▁'

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

/** What the last turn cost as the hub priced it (`cost.update`), `~$0.42` when it was a guess; undefined without a hub or before a turn. Read while drawing, so the band redraws when it changes. */
async function hubTurnCost($: EngineInterface): Promise<string | undefined> {
  const { value: event } = await $.state.get({ plugin: 'mods-hub', key: 'latest', id: 'cost.update' })
  const data: unknown = event?.data
  const { turnUsd, isEstimate } = typeof data === 'object' && data !== null ? (data as { turnUsd?: unknown; isEstimate?: unknown }) : {}
  return typeof turnUsd === 'number' && Number.isFinite(turnUsd) ? formatUsd(turnUsd, isEstimate === true) : undefined
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

/** With mods-hub installed: hello (this mod reads `cost.update`, to put the turn's cost beside its tokens). */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['cost.update'] })
}

async function setHidden($: EngineInterface, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden)
  try {
    await $.store.set(HIDDEN_KEY, hidden)
  } catch (error) {
    $.ui.log(`token-sparkline: could not remember the band's visibility: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  settings.metric = options.metric === 'input' || options.metric === 'output' ? options.metric : 'total'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the tokens-per-turn sparkline above the prompt',
      argumentHint: '[show|hide|reset]',
    })
    try {
      const wasHidden = (await $.store.get(HIDDEN_KEY)) === true
      await update($, isHidden, () => wasHidden)
    } catch (error) {
      $.ui.log(`token-sparkline: could not read its settings: ${String(error)}`, { to: 'debug' })
    }
    await greetHub($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage !== undefined) {
      const tokens = tokensOf(e.usage, settings.metric)
      if (tokens > 0) await update($, points, list => [...list, tokens].slice(-MAX_POINTS))
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'reset') {
      await update($, points, () => [])
      return { text: 'Cleared.' }
    }
    const hide = arg === 'hide' ? true : arg === 'show' ? false : !(await read($, isHidden))
    await setHidden($, hide)
    return { text: hide ? 'Hidden. /sparkline brings it back.' : 'Shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, points)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const last = list.at(-1) ?? 0
    const max = Math.max(...list)
    const average = list.reduce((sum, value) => sum + value, 0) / list.length
    const label = `${METRIC_LABEL[settings.metric]} `
    const cost = await hubTurnCost($)
    const figures = ` last ${compact(last)} · avg ${compact(average)} · max ${compact(max)}${cost === undefined ? '' : ` · ${cost}`} `
    const hide = 'Hide'
    const room = e.props.bodyColumns - label.length - hide.length
    const showsFigures = room - figures.length >= MIN_SPARK_COLUMNS
    const sparkColumns = Math.max(1, Math.min(list.length, showsFigures ? room - figures.length : room - 1))
    const shown = list.slice(-sparkColumns)

    let spark: RenderElement
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const cells = shown.map((value, index) => [barOf(value, max), index === shown.length - 1 ? LAST_RGB : BAR_RGB] as const)
      spark = <Raster key="spark" columns={shown.length} rows={1} cells={packCells(cells)} />
    } else {
      spark = (
        <Box key="spark">
          <Text color="claude">{shown.map(value => barOf(value, max)).join('')}</Text>
        </Box>
      )
    }

    const band = (
      <Box key="token-sparkline" flexDirection="row">
        <Text dimColor>{label}</Text>
        {spark}
        <Text dimColor>{showsFigures ? figures : ' '}</Text>
        <Button key="hide" plain dimColor onPress={() => void setHidden($, true)}>
          {hide}
        </Button>
      </Box>
    )
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts

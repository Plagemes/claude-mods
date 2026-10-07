import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { ContextGaugeFill } from '../types'

const fill = atom({ plugin: 'context-gauge', key: 'fill' } as const, null)
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)

const BAR_CELLS = 20
const DEFAULT_WARN_AT = 60
const DEFAULT_ALERT_AT = 75
/** A `context.pressure` older than this says nothing about the window now (a compaction may have followed it). */
const PRESSURE_FRESH_MS = 10 * 60_000

const toFill = ({ percent, tokens, window }: SessionContextUsage): ContextGaugeFill | null =>
  percent === undefined || tokens === undefined ? null : { percent, tokens, window }

const compactNumber = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * The fill from the hub's last `context.pressure` (it crossed 70, 85 or 95 %), for a gauge that has no reading yet
 * (the mod was reloaded mid-session); undefined without a hub or when the event is old.
 */
async function hubFill($: EngineInterface): Promise<ContextGaugeFill | null> {
  try {
    const event = await $.mods.latest({ topic: 'context.pressure' })
    const data: unknown = event?.data
    if (event === null || typeof data !== 'object' || data === null || (await $.clock.now()) - event.at > PRESSURE_FRESH_MS) return null
    const { percent, tokens, window } = data as { percent?: unknown; tokens?: unknown; window?: unknown }
    return typeof percent === 'number' && typeof tokens === 'number' && typeof window === 'number' && window > 0 ? { percent, tokens, window } : null
  } catch {
    return null
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

/** With mods-hub installed: hello (this mod reads `context.pressure`), and a first reading from it when the engine has none. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['context.pressure'] })
  if ((await read($, fill)) !== null) return
  const seeded = await hubFill($)
  if (seeded !== null) await update($, fill, () => seeded)
}

export const register: Register = (on, options) => {
  const warnAt = asNumber(options.warnAt, DEFAULT_WARN_AT)
  const alertAt = asNumber(options.alertAt, DEFAULT_ALERT_AT)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-gauge',
      description: 'Show or hide the context-window gauge above the prompt',
    })

    try {
      const { context } = await $.session.usage()
      await update($, fill, () => toFill(context))
    } catch {
      // The gauge simply stays hidden until the first measurement arrives.
    }
    await greetHub($)

    return next(e)
  })

  on('command.run', { command: 'context-gauge' }, async $ => {
    const willHide = !(await read($, isHidden))
    await update($, isHidden, () => willHide)

    return { text: willHide ? 'Context gauge hidden.' : 'Context gauge shown.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, fill, () => toFill(e.context))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, fill, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const gauge = await read($, fill)

    if (e.props.hasSurvey || gauge === null || (await read($, isHidden))) {
      return next(e)
    }

    // The band holds one tree: what the plugins beneath draw goes under the gauge, so their bands still show.
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const percent = Math.min(100, Math.max(0, Math.round(gauge.percent)))
    const filled = Math.round((percent / 100) * BAR_CELLS)
    const needsCompact = percent > alertAt
    const color = needsCompact ? 'error' : percent >= warnAt ? 'warning' : 'success'

    return (
      <Box flexDirection="column">
        <Box key="gauge">
          <Text dimColor>context </Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
          <Text color={color}>{` ${percent}%`}</Text>
          <Text dimColor>{` ${compactNumber(gauge.tokens)}/${compactNumber(gauge.window)}`}</Text>
          {needsCompact && <Text color={color}>{'  /compact'}</Text>}
          <Text> </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
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

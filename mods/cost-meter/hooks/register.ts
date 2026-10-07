import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { costOf, formatTokens, formatUsd, pricesWith, type PriceTable } from './shared/prices'
import type { Spend } from '../types'

const EMPTY: Spend = { usd: 0, tokens: 0, turns: 0, hasUnpricedModel: false }
const spend = atom({ plugin: 'cost-meter', key: 'spend' } as const, EMPTY)

/** `$0.42 · 128k tok`, or `~$0.42 · 128k tok` when some turn was priced as a guess. */
const formatSpend = (total: Spend, showTokens: boolean): string => {
  const dollars = formatUsd(total.usd, total.hasUnpricedModel)
  return showTokens ? `${dollars} · ${formatTokens(total.tokens)} tok` : dollars
}

async function showSpend($: EngineInterface, showTokens: boolean): Promise<void> {
  $.ui.status(formatSpend(await read($, spend), showTokens))
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

/**
 * Says hello to mods-hub when it is installed. cost-meter trades nothing on the bus: the hub's own
 * `cost.update` prices the main conversation with the same vendored table, and cost-meter also counts
 * subagent turns and the person's price overrides, so it keeps its own total rather than reading the hub's.
 */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

export const register: Register = (on, options) => {
  const prices: PriceTable = pricesWith(String(options.pricing ?? ''))
  const showTokens = options.showTokens !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cost-reset', description: 'Reset the cost-meter counters to zero' })
    await showSpend($, showTokens)
    await greetHub($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const { usage } = e
    if (usage !== undefined) {
      const cost = costOf(usage, usage.model, prices)
      await update($, spend, total => ({
        usd: total.usd + cost.usd,
        tokens: total.tokens + cost.tokens,
        turns: total.turns + 1,
        hasUnpricedModel: total.hasUnpricedModel || !cost.isKnownModel,
      }))
      await showSpend($, showTokens)
    }
    return next(e)
  })

  on('command.run', { command: 'cost-reset' }, async $ => {
    const before = formatSpend(await read($, spend), showTokens)
    await update($, spend, () => EMPTY)
    await showSpend($, showTokens)
    return { text: `Counters reset (they read ${before}).` }
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

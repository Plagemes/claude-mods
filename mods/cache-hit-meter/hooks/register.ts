import { atom, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, TurnUsage } from 'claude-code'

import type { CacheHitMeterStats } from '../types'
import { formatUsd, priceOf } from './shared/prices'

const EMPTY: CacheHitMeterStats = { read: 0, total: 0, turns: 0, lastPercent: null, hasWarned: false, savedUsd: 0 }
const stats = atom({ plugin: 'cache-hit-meter', key: 'stats' } as const, EMPTY)

const DEFAULT_WARN_BELOW = 30
const DEFAULT_AFTER_TURNS = 5
const PER_MILLION = 1_000_000

/** What this load knows about the hub: it is installed, and the session's spend as its `cost.update` last said. */
type Memo = { isHubbed: boolean }

const inputTokens = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

const percentOf = (read: number, total: number): number => Math.round((read / total) * 100)

/** What reading these tokens from the cache cost less than paying the input rate for them. */
const savedBy = (usage: TurnUsage): number => {
  const { price } = priceOf(usage.model)
  return (usage.cache_read_input_tokens * (price.input - price.cacheRead)) / PER_MILLION
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const statusLine = ({ read, total, turns, lastPercent }: CacheHitMeterStats): string =>
  turns > 1 && lastPercent !== null
    ? `cache ${percentOf(read, total)}% · last ${lastPercent}%`
    : `cache ${percentOf(read, total)}%`

/** The session's spend as the hub last priced it (its `cost.update`), or undefined when there is no hub or no turn yet. */
async function hubSessionUsd($: EngineInterface): Promise<number | undefined> {
  try {
    const data: unknown = (await $.mods.latest({ topic: 'cost.update' }))?.data
    const usd = typeof data === 'object' && data !== null ? (data as { sessionUsd?: unknown }).sessionUsd : undefined
    return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined
  } catch {
    return undefined
  }
}

/** `cache 80% · saved $1.20 (26% off)`: with the hub, the status line also says what the cache saved, against the hub's session spend. */
async function showStatus($: EngineInterface, memo: Memo, session: CacheHitMeterStats): Promise<void> {
  const line = statusLine(session)
  if (!memo.isHubbed || session.savedUsd <= 0) return $.ui.status(line)
  const spent = await hubSessionUsd($)
  const share = spent === undefined ? '' : ` (${percentOf(session.savedUsd, session.savedUsd + spent)}% off)`
  $.ui.status(`${line} · saved ${formatUsd(session.savedUsd)}${share}`)
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

/** With mods-hub installed: hello (this mod reads `cost.update`) and the saved-money figure in the status line. */
async function greetHub($: EngineInterface, memo: Memo): Promise<void> {
  if ((await hubMode($)) === undefined) return
  memo.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['cost.update'] })
}

export const register: Register = (on, options) => {
  const warnBelow = asNumber(options.warnBelow, DEFAULT_WARN_BELOW)
  const afterTurns = asNumber(options.afterTurns, DEFAULT_AFTER_TURNS)
  const memo: Memo = { isHubbed: false }

  on('session.start', async ($, e, next) => {
    afterStart($, 'cache-hit-meter', () => greetHub($, memo))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const { usage } = e
    const total = usage === undefined ? 0 : inputTokens(usage)

    // Subagents run on their own context; only the main conversation is measured.
    if (usage !== undefined && total > 0 && e.agentId === undefined) {
      const session = await update($, stats, previous => ({
        ...previous,
        read: previous.read + usage.cache_read_input_tokens,
        total: previous.total + total,
        turns: previous.turns + 1,
        lastPercent: percentOf(usage.cache_read_input_tokens, total),
        savedUsd: previous.savedUsd + savedBy(usage),
      }))
      await showStatus($, memo, session)

      const sessionPercent = percentOf(session.read, session.total)
      if (!session.hasWarned && session.turns >= afterTurns && sessionPercent < warnBelow) {
        await update($, stats, previous => ({ ...previous, hasWarned: true }))
        await hubNotify($, { level: 'info', title: `Only ${sessionPercent}% of input came from the prompt cache (${session.turns} turns)` })
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, stats, () => EMPTY)
      $.ui.status(undefined)
    }

    return next(e)
  })
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

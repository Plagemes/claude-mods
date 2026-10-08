import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TurnTimerStats } from '../types'

const EMPTY: TurnTimerStats = { count: 0, totalMs: 0, lastMs: 0 }
const stats = atom({ plugin: 'turn-timer', key: 'stats' } as const, EMPTY)

const DEFAULT_THRESHOLD_SECONDS = 120
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
/** mods-hub publishes `turn.finished` from a timer just after the turn ends; wait for it. */
const HUB_SETTLE_MS = 250

const pad = (n: number): string => String(n).padStart(2, '0')

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)

  if (minutes === 0) {
    return `${seconds}s`
  }

  const rest = seconds % SECONDS_PER_MINUTE
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)

  return hours === 0
    ? `${minutes}m ${pad(rest)}s`
    : `${hours}h ${pad(minutes % MINUTES_PER_HOUR)}m`
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** The tool-call count of the turn that took `durationMs`, from the hub's `turn.finished`; undefined when there is no hub or no such event. */
async function toolsOf($: EngineInterface, durationMs: number): Promise<number | undefined> {
  try {
    const data: unknown = (await $.mods.latest({ topic: 'turn.finished' }))?.data
    const finished = typeof data === 'object' && data !== null ? (data as { durationMs?: unknown; tools?: unknown }) : {}
    return finished.durationMs === durationMs && typeof finished.tools === 'number' ? finished.tools : undefined
  } catch {
    return undefined
  }
}

/** `That turn took 2m 05s`, with the tool-call count when mods-hub knows it; sent as an info notice (a toast without the hub). */
async function announce($: EngineInterface, durationMs: number, isHubbed: boolean): Promise<void> {
  const tools = isHubbed ? await toolsOf($, durationMs) : undefined
  await hubNotify($, {
    level: 'info',
    title: `That turn took ${formatDuration(durationMs)}`,
    ...(tools === undefined ? {} : { body: `${tools} tool call${tools === 1 ? '' : 's'}` }),
  })
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

export const register: Register = (on, options) => {
  const thresholdMs = asNumber(options.thresholdSeconds, DEFAULT_THRESHOLD_SECONDS) * 1000
  let isHubbed = false

  // With mods-hub installed: hello (this mod reads `turn.finished`).
  on('session.start', async ($, e, next) => {
    // Waits until session.start has returned (afterStart): with every mod installed, waiting on the hub here ran
    // session.start past its 10 s budget.
    afterStart($, 'turn-timer', async () => {
      if ((await hubMode($)) !== undefined) isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['turn.finished'] })
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Subagent turns and interrupted turns would skew the average.
    if (e.agentId === undefined && !e.isAborted) {
      const { count, totalMs, lastMs } = await update($, stats, previous => ({
        count: previous.count + 1,
        totalMs: previous.totalMs + e.durationMs,
        lastMs: e.durationMs,
      }))
      $.ui.status(`last ${formatDuration(lastMs)} · avg ${formatDuration(totalMs / count)}`)

      if (thresholdMs > 0 && e.durationMs > thresholdMs) {
        const { durationMs } = e
        if (isHubbed) $.clock.after(HUB_SETTLE_MS, () => void announce($, durationMs, true))
        else await announce($, durationMs, false)
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

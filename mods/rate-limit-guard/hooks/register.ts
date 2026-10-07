import type { EngineInterface, Register } from 'claude-code'

import { externalHosts, loopOfFetches } from './requests'
import { redactSummary } from './shared/secrets'

const MOD = 'rate-limit-guard'

const DEFAULT_MAX_CALLS = 20
const DEFAULT_WINDOW_SEC = 60
const TOAST_MS = 8_000

/** The recent requests to one host, and until when it is paused. */
type HostLog = { hits: number[]; pausedUntil: number }

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

const counts = (hosts: readonly string[]): Map<string, number> => {
  const result = new Map<string, number>()
  for (const host of hosts) result.set(host, (result.get(host) ?? 0) + 1)
  return result
}

const HOW_TO_GO_ON = 'Wait for the pause to end, get what you need in fewer requests (pagination, a bulk endpoint, one script with a delay between calls), or reuse results you already have.'

const loopWarning = (iterations: number | undefined, maxCalls: number, windowSec: number): string =>
  `${MOD}: this command fetches in a loop${iterations === undefined ? '' : ` (about ${iterations} rounds)`} with nothing slowing it down, so every round is a separate request. ` +
  `External hosts are limited to ${maxCalls} calls per ${windowSec} s here. Add a sleep between rounds, respect Retry-After, or use a bulk endpoint.`

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, rule: string, reason: string, command: string): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool: 'Bash', reason: `${rule}: ${reason}`, severity: 'low', command: redactSummary(command) } })
}

export const register: Register = (on, options) => {
  const maxCalls = Math.floor(positive(options.maxCalls, DEFAULT_MAX_CALLS))
  const windowMs = positive(options.windowSec, DEFAULT_WINDOW_SEC) * 1000
  const logs = new Map<string, HostLog>()

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const wanted = counts(externalHosts(e.command))
    const loop = loopOfFetches(e.command)
    if (wanted.size === 0 && loop === undefined) return next(e)

    const now = await $.clock.now()
    for (const [host, log] of logs) if (log.pausedUntil <= now && log.hits.every(hit => hit <= now - windowMs)) logs.delete(host)

    // Judge every host first, so a refused command records nothing against the others.
    for (const [host, wantedNow] of wanted) {
      const log = logs.get(host) ?? { hits: [], pausedUntil: 0 }
      if (log.pausedUntil > now) {
        const seconds = Math.ceil((log.pausedUntil - now) / 1000)
        await reportBlock($, 'paused', `requests to ${host} are paused for ${seconds} more s`, e.command)
        return { deny: `${MOD}: requests to ${host} are paused for ${seconds} more s (the limit of ${maxCalls} per ${windowMs / 1000} s was reached). ${HOW_TO_GO_ON}` }
      }
      const recent = log.hits.filter(hit => hit > now - windowMs)
      if (recent.length + wantedNow > maxCalls) {
        logs.set(host, { hits: [], pausedUntil: now + windowMs })
        await reportBlock($, 'limit-reached', `${recent.length} requests to ${host} in the last ${windowMs / 1000} s, limit ${maxCalls}`, e.command)
        const note = `paused requests to ${host} for ${windowMs / 1000} s (${recent.length} in the last ${windowMs / 1000} s)`
        await hubNotify($, { level: 'warning', title: note, topic: 'risk.blocked' }, { timeoutMs: TOAST_MS })
        return { deny: `${MOD}: ${recent.length} requests to ${host} in the last ${windowMs / 1000} s, and the limit is ${maxCalls}. Requests to ${host} are paused for ${windowMs / 1000} s. ${HOW_TO_GO_ON}` }
      }
    }
    for (const [host, wantedNow] of wanted) {
      const log = logs.get(host) ?? { hits: [], pausedUntil: 0 }
      logs.set(host, { hits: [...log.hits.filter(hit => hit > now - windowMs), ...Array<number>(wantedNow).fill(now)], pausedUntil: 0 })
    }

    const ran = await next(e)
    if (loop === undefined || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), loopWarning(loop.iterations, maxCalls, windowMs / 1000)] }
  }).catch(($, e, next) => next(e))
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

import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

const DEFAULT_MAX = 3
const POLL_MS = 3000
/** Statuses that occupy a slot; an `idle` teammate is only waiting for a message. */
const BUSY: ReadonlySet<AgentInfo['status']> = new Set(['pending', 'running', 'waiting'])

type Cap = {
  max: number
  /** Agent calls that passed the cap and have not shown up in `$.agent.list()` yet. */
  reserved: Set<string>
  poll?: Timer
}

const cap: Cap = { max: DEFAULT_MAX, reserved: new Set() }

/** Agents the engine lists as busy, leaving out `finished` (an agent whose last turn just ended). */
async function listedBusy($: EngineInterface, finished?: string): Promise<number> {
  try {
    return (await $.agent.list()).filter(agent => BUSY.has(agent.status) && agent.id !== finished).length
  } catch {
    return 0
  }
}

/** Keeps `agents n/max` in the status line while any agent runs, and polls to notice the ones that end quietly. */
async function showStatus($: EngineInterface, finished?: string): Promise<void> {
  const busy = (await listedBusy($, finished)) + cap.reserved.size
  $.ui.status(busy > 0 ? `agents ${busy}/${cap.max}` : undefined)
  if (busy === 0) {
    cap.poll?.cancel()
    cap.poll = undefined
  } else if (cap.poll === undefined) {
    cap.poll = $.clock.every(POLL_MS, () => void showStatus($))
  }
}

// ── mods-hub: smart-router's parallel limit, refusals on the bus ────────────────────────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: ['smart-router.policy'] })
}

/**
 * The cap now: the configured maximum, or smart-router's `maxParallel` (the fact `smart-router.policy` on mods-hub)
 * when that is lower, so a Saver profile's limit holds here too. A policy never raises the cap.
 */
async function capNow($: EngineInterface): Promise<number> {
  try {
    const fact = await $.mods.read({ key: 'smart-router.policy' })
    const parallel = (fact?.value as { maxParallel?: unknown } | undefined)?.maxParallel
    return typeof parallel === 'number' && Number.isFinite(parallel) && parallel >= 1 ? Math.min(cap.max, Math.floor(parallel)) : cap.max
  } catch {
    return cap.max
  }
}

/** A refused subagent on the hub's bus (guardian, audit-trail); the refusal never waits on it. */
async function publishRefusal($: EngineInterface, tool: string, max: number): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: 'subagent-cap', tool, reason: `${max} of ${max} subagents already running`, severity: 'low' } })
}

const refusal = (max: number): string =>
  `subagent-cap: ${max} of ${max} subagents are already running. Wait for one to finish before starting another, ` +
  'or do the work yourself. The user can raise the limit in the mod settings.'

export const register: Register = (on, options) => {
  const max = Math.floor(Number(options.max))
  cap.max = Number.isFinite(max) && max >= 1 ? max : DEFAULT_MAX

  on('session.start', async ($, e, next) => {
    afterStart($, 'subagent-cap', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: /^(?:Agent|Task)$/ }, async ($, e, next) => {
    const limit = await capNow($)
    // Read the list first, then compare and reserve with no await between: parallel calls cannot share a slot.
    const busy = await listedBusy($)
    if (busy + cap.reserved.size >= limit) {
      $.ui.toast(`held back a subagent: ${limit}/${limit} already running`)
      await publishRefusal($, String(e.tool), limit)
      return { deny: refusal(limit) }
    }
    cap.reserved.add(e.tool_use_id)
    try {
      return await next(e)
    } finally {
      cap.reserved.delete(e.tool_use_id)
      await showStatus($)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    cap.reserved.delete(e.tool_use_id)
    await showStatus($)
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await showStatus($, e.agentId)
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

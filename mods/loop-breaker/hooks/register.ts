import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

const DEFAULT_LIMIT = 3
/** mods-hub reports a failing Bash command itself at its third failure; this mod reports the rest. */
const HUB_REPEATS = 3
const TOAST_MS = 8000
const MAX_SHOWN = 80
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Input fields that identify a call but say nothing about what it does. */
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', '_host'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** Consecutive failures per call, per loop; a person's next prompt and anything that changes the project clear them. */
const failures = new Map<string, number>()

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** What makes two calls "the same": the agent, the tool and its input (a shell command with its spacing normalized). */
const keyOf = (e: Readonly<Record<string, unknown>>): string => {
  const input = Object.entries(e).filter(([name]) => !ENVELOPE.has(name))
  const body = e.tool === 'Bash' ? squash(String(e.command)) : JSON.stringify(input)
  return `${String(e.agentId ?? 'main')}\u0000${String(e.tool)}\u0000${body}`
}

const summary = (e: Readonly<Record<string, unknown>>): string => {
  const text = e.tool === 'Bash' ? squash(String(e.command)) : `${String(e.tool)} ${String(e.file_path ?? e.notebook_path ?? '')}`.trim()
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

const advice = (what: string, limit: number): string =>
  `This exact call (${what}) has now failed ${limit} times in a row. Stop repeating it. Step back, read the error it printed, ` +
  'work out why it fails, and try a different approach: another command, another way to the same result, or ask the user.'

// ── mods-hub: loops on the bus, the stop as a notice ────────────────────────────────────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['error.repeated'], consumes: [] })
}

/**
 * A stopped loop: on the hub's bus as `error.repeated` (error-feed, lessons-learned, issue-drafter, guardian),
 * except a Bash command the hub's own sensor already reported at its third failure; and a `warning` notice
 * (a toast without the hub).
 */
async function reportLoop($: EngineInterface, tool: string, what: string, limit: number): Promise<void> {
  const title = `stopped a loop: "${what}" failed ${limit} times in a row`
  if ((await hubMode($)) === undefined) {
    $.ui.toast(title, { timeoutMs: TOAST_MS })
    return
  }
  await hubNotify($, { level: 'warning', title, topic: 'error.repeated' })
  if (tool === 'Bash' && limit >= HUB_REPEATS) return
  await hubPublish($, { topic: 'error.repeated', data: { signature: tool === 'Bash' ? `Bash ${what}` : what, count: limit, tool, ...(tool === 'Bash' ? { command: what } : {}) } })
}

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.limit))
  const limit = Number.isFinite(asked) && asked >= 2 ? asked : DEFAULT_LIMIT

  on('session.start', async ($, e, next) => {
    afterStart($, 'loop-breaker', () => greetHub($))
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) failures.clear()
    return next(e)
  })

  on('tool.call', { tool: /^(?:Bash|Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const key = keyOf(e)
    if ((failures.get(key) ?? 0) >= limit) {
      return { deny: `loop-breaker: refused. ${advice(summary(e), limit)}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const count = (failures.get(key) ?? 0) + 1
      failures.set(key, count)
      if (count < limit) return ran
      await reportLoop($, String(e.tool), summary(e), limit)
      return { ...ran, context: [...(ran.context ?? []), `loop-breaker: ${advice(summary(e), limit)}`] }
    }

    // A successful edit, or a command that is not read-only, may have changed what the failing call depends on.
    if (e.tool !== 'Bash' || ran.isReadOnly !== true) failures.clear()
    return ran
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

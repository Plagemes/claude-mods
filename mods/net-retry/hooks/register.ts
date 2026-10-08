import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { backoffMs, isRetryable, transientError } from './commands'

const DEFAULT_RETRIES = 2
const MAX_RETRIES = 5
const DEFAULT_BACKOFF_SECONDS = 2
/** What a hook keeps in hand when it waits: the time to put its note together and return before its budget is gone. */
const SAFETY_MARGIN_MS = 2000
const MAX_REASON_LENGTH = 50

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** What a failed command's output blames the failure on, when that is a temporary network error. */
const networkReason = (ran: ToolCallResult): string | undefined => {
  if (ran.deny !== undefined || ran.isError !== true) return undefined
  const reason = transientError(ran.text ?? '')
  return reason === undefined || reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`
}

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed (this mod trades nothing on the bus). */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

export const register: Register = (on, options) => {
  const maxRetries = Math.min(MAX_RETRIES, Math.max(0, Math.round(numberOr(options.retries, DEFAULT_RETRIES))))
  const firstWaitMs = Math.max(100, numberOr(options.backoffSeconds, DEFAULT_BACKOFF_SECONDS) * 1000)

  on('session.start', async ($, e, next) => {
    afterStart($, 'net-retry', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let ran = await next(e)
    if (maxRetries === 0 || e.run_in_background === true || !isRetryable(e.command)) return ran

    const retries: string[] = []
    while (retries.length < maxRetries) {
      const reason = networkReason(ran)
      const waitMs = backoffMs(retries.length + 1, firstWaitMs)
      // Waits count against the hook's budget: with less left than the wait and the margin, stop rather than be cut off.
      if (reason === undefined || next.signal.aborted || next.budget.remainingMs < waitMs + SAFETY_MARGIN_MS) break

      retries.push(`${reason}, waited ${seconds(waitMs)}`)
      $.ui.toast(`network error (${reason}); retrying in ${seconds(waitMs)} (${retries.length}/${maxRetries})`, { timeoutMs: waitMs })
      await $.clock.sleep(waitMs, { signal: next.signal })
      ran = await next(e)
    }

    if (retries.length === 0 || ran.deny !== undefined) return ran
    const outcome = ran.isError === true ? 'it still failed' : 'it worked'
    const note = `net-retry: this command hit a temporary network error and was run again ${retries.length} time${retries.length === 1 ? '' : 's'} (${retries.join('; ')}); ${outcome} on the last try.`
    return { ...ran, context: [...(ran.context ?? []), note] }
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

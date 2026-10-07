import type { EngineInterface, Register } from 'claude-code'

import { isTestCommand, summarizeRun } from './shared/test-runners'

const BUZZ_SOUND = { asset: 'assets/buzz.wav' } as const
const DEFAULT_COOLDOWN_SECONDS = 10
/** mods-hub publishes `test.result` and `error.repeated` from a timer just after the tool returns; wait for it. */
const HUB_SETTLE_MS = 250

// A runner that printed failures but still exited 0 (e.g. `npm test || true`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

/** What this load remembers: the last buzz, and the last `error.repeated` event that was answered. */
type Buzzer = { cooldownMs: number; isTestsOnly: boolean; lastBuzzAt: number; lastRepeatedId: string | undefined }
/** What the hook saw of one Bash call. */
type Call = { command: string; since: number; isTestRun: boolean; hasFailed: boolean }

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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['test.result', 'error.repeated'] })
}

/** The hub's event of `topic` made while this Bash call ran, when it was about this command. */
async function hubEventFor($: EngineInterface, topic: string, call: Call): Promise<{ id: string; data: Record<string, unknown> } | undefined> {
  try {
    const event = await $.mods.latest({ topic })
    const data: unknown = event?.data
    if (event === null || event.at < call.since || typeof data !== 'object' || data === null) return undefined
    const { command } = data as { command?: unknown }
    // The hub keeps the first 200 characters of the command; a run it did not see (test-watch's own) names another one.
    return typeof command === 'string' && call.command.startsWith(command) ? { id: event.id, data: data as Record<string, unknown> } : undefined
  } catch {
    return undefined
  }
}

/** Buzzes, once per cooldown; `isUrgent` (the hub says the same command keeps failing) does not wait for the cooldown. */
async function buzz($: EngineInterface, buzzer: Buzzer, isUrgent: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!isUrgent && now - buzzer.lastBuzzAt < buzzer.cooldownMs) return
  buzzer.lastBuzzAt = now
  // Not awaited: the call resolves when the clip ends, and the tool result must not wait for it. The hub holds it at night and while Silent.
  $.audio.play(BUZZ_SOUND).catch(() => undefined)
}

/**
 * Decides whether a finished Bash call earns a buzz. With mods-hub the verdict of a test run is the hub's
 * `test.result` (and a command that keeps failing is its `error.repeated`); without it, the output is read here.
 */
async function judge($: EngineInterface, buzzer: Buzzer, call: Call, isHubbed: boolean): Promise<void> {
  const run = isHubbed && call.isTestRun ? await hubEventFor($, 'test.result', call) : undefined
  const hasFailed = run === undefined ? call.hasFailed : run.data.outcome !== 'passed'
  if (!hasFailed || (buzzer.isTestsOnly && !call.isTestRun)) return

  const repeated = isHubbed ? await hubEventFor($, 'error.repeated', call) : undefined
  const isNewRepeat = repeated !== undefined && repeated.id !== buzzer.lastRepeatedId
  if (isNewRepeat) buzzer.lastRepeatedId = repeated.id
  await buzz($, buzzer, isNewRepeat)
}

export const register: Register = (on, options) => {
  const buzzer: Buzzer = {
    cooldownMs: (typeof options.cooldownSeconds === 'number' ? options.cooldownSeconds : DEFAULT_COOLDOWN_SECONDS) * 1000,
    isTestsOnly: options.onlyTests === true,
    lastBuzzAt: Number.NEGATIVE_INFINITY,
    lastRepeatedId: undefined,
  }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const since = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const text = ran.text ?? ''
    const isTestRun = isTestCommand(e.command)
    const isError = ran.isError === true
    const hasFailed = isError || (isTestRun && (FAILURE_REPORT.test(text) || summarizeRun(e.command, text, false).outcome !== 'passed'))
    const call: Call = { command: e.command, since, isTestRun, hasFailed }

    if ((await hubMode($)) === undefined) {
      await judge($, buzzer, call, false)
    } else {
      $.clock.after(HUB_SETTLE_MS, () => void judge($, buzzer, call, true))
    }
    return ran
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

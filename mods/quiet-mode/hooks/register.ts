import { atom, read, update } from 'claude-code'
import type { EngineInterface, Origin, Register, Timer } from 'claude-code'

import type { QuietState } from '../types'
import { formatMinutes, muteVerdict, parseQuietArgs } from './args'
import type { QuietCommand } from './args'

const quiet = atom({ plugin: 'quiet-mode', key: 'quiet' } as const, { isOn: false, until: null } satisfies QuietState)

/** The one timer that keeps the status line honest and ends a timed quiet period; it lives only while quiet mode is on. */
type Timers = { tick: Timer | undefined }

const OFF: QuietState = { isOn: false, until: null }
const TICK_MS = 30_000
const MINUTE_MS = 60_000

const statusText = (state: QuietState, now: number): string => (state.until === null ? '🔕 quiet' : `🔕 quiet ${formatMinutes(state.until - now)}`)

/** Stores the state, and sets the status line and the timer that go with it. */
const setQuiet = async ($: EngineInterface, timers: Timers, state: QuietState): Promise<void> => {
  await update($, quiet, () => state)
  timers.tick?.cancel()
  timers.tick = undefined
  if (!state.isOn) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(statusText(state, await $.clock.now()))
  if (state.until !== null) {
    timers.tick = $.clock.every(TICK_MS, () => {
      void tick($, timers)
    })
  }
}

/** Ends quiet mode because its time ran out. */
const finish = async ($: EngineInterface, timers: Timers): Promise<void> => {
  await setQuiet($, timers, OFF)
  $.ui.toast('quiet mode is over; toasts and sounds are back')
}

const tick = async ($: EngineInterface, timers: Timers): Promise<void> => {
  const state = await read($, quiet)
  const now = await $.clock.now()
  if (state.isOn && state.until !== null && now >= state.until) await finish($, timers)
  else if (state.isOn) $.ui.status(statusText(state, now))
}

/** Whether a call on `$` from `origin` is swallowed (see `muteVerdict`). */
const isMuting = async ($: EngineInterface, timers: Timers, origin: Origin): Promise<boolean> => {
  const verdict = muteVerdict(origin, $.plugin.name, await read($, quiet), await $.clock.now())
  if (verdict === 'expired') await finish($, timers)
  return verdict === 'mute'
}

// ── With mods-hub installed, /quiet is an alias of the hub's Silent mode ─────────────────────────────

type HubMode = NonNullable<Awaited<ReturnType<typeof hubMode>>>

const hubStatusText = (mode: HubMode, now: number): string =>
  mode.silentUntil === null ? '🔕 quiet' : `🔕 quiet ${formatMinutes(mode.silentUntil - now)}`

/** The status line follows the hub's Silent (set here, by /hub, or in another session) until it ends. */
const showHubSilent = async ($: EngineInterface, timers: Timers, mode: HubMode): Promise<void> => {
  timers.tick?.cancel()
  timers.tick = undefined
  if (!mode.isSilent) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(hubStatusText(mode, await $.clock.now()))
  timers.tick = $.clock.every(TICK_MS, () => {
    void hubTick($, timers)
  })
}

const hubTick = async ($: EngineInterface, timers: Timers): Promise<void> => {
  const mode = await hubMode($)
  if (mode === undefined || !mode.isSilent) {
    // The hub says when Silent is over; this only clears the line.
    timers.tick?.cancel()
    timers.tick = undefined
    $.ui.status(undefined)
  } else {
    $.ui.status(hubStatusText(mode, await $.clock.now()))
  }
}

/**
 * `/quiet` when mods-hub is installed: it switches the hub's Silent (every session; the hub holds the toasts
 * and sounds of every mod in its panel's Recent list). Undefined when there is no hub.
 */
const runOnHub = async ($: EngineInterface, timers: Timers, command: Exclude<QuietCommand, { kind: 'error' }>): Promise<string | undefined> => {
  const mode = await hubMode($)
  if (mode === undefined) return undefined
  // Muting is the hub's job now: this mod's own switch stays off so nothing is muted twice.
  if ((await read($, quiet)).isOn) await update($, quiet, () => OFF)
  const now = await $.clock.now()

  if (command.kind === 'status') {
    if (!mode.isSilent) return "Quiet mode (mods-hub's Silent) is off."
    return mode.silentUntil === null
      ? "Quiet mode (mods-hub's Silent) is on until you switch it off."
      : `Quiet mode (mods-hub's Silent) is on, ${formatMinutes(mode.silentUntil - now)} left.`
  }
  if (command.kind === 'off' || (command.kind === 'toggle' && mode.isSilent)) {
    await showHubSilent($, timers, await $.mods.setMode({ silentMinutes: null }))
    return mode.isSilent ? 'Quiet mode is off in every session: toasts and sounds from your mods are back.' : 'Quiet mode was already off.'
  }

  // With no minutes, Silent has no end: it lasts until /quiet (or /hub silent off) switches it off.
  const minutes = command.kind === 'on' ? command.minutes : null
  await showHubSilent($, timers, await $.mods.setMode(minutes === null ? { isSilent: true } : { silentMinutes: minutes }))
  const length = minutes === null ? 'until you run /quiet again' : `for ${formatMinutes(minutes * MINUTE_MS)}`
  return `Quiet mode is on ${length}, in every session (mods-hub's Silent): toasts and sounds from your mods wait in the Claude Mods panel.`
}

const runQuiet = async ($: EngineInterface, timers: Timers, args: string): Promise<string> => {
  const command = parseQuietArgs(args)
  if (command.kind === 'error') return command.message
  try {
    const onHub = await runOnHub($, timers, command)
    if (onHub !== undefined) return onHub
  } catch {
    // The hub refused the change: quiet mode works on its own, as without the hub.
  }

  const state = await read($, quiet)
  const now = await $.clock.now()
  const isOn = state.isOn && (state.until === null || now < state.until)

  if (command.kind === 'status') {
    if (!isOn) return 'Quiet mode is off.'
    return state.until === null ? 'Quiet mode is on until you switch it off.' : `Quiet mode is on, ${formatMinutes(state.until - now)} left.`
  }
  if (command.kind === 'off' || (command.kind === 'toggle' && isOn)) {
    await setQuiet($, timers, OFF)
    return isOn ? 'Quiet mode is off: toasts and sounds from your mods are back.' : 'Quiet mode was already off.'
  }

  const minutes = command.kind === 'on' ? command.minutes : null
  await setQuiet($, timers, { isOn: true, until: minutes === null ? null : now + minutes * MINUTE_MS })
  const length = minutes === null ? 'until you run /quiet again' : `for ${formatMinutes(minutes * MINUTE_MS)}`
  return `Quiet mode is on ${length}: toasts and sounds from your other mods are muted.`
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello, and the status line shows a Silent already on (from another session or /hub). */
const greetHub = async ($: EngineInterface, timers: Timers): Promise<void> => {
  const mode = await hubMode($)
  if (mode === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
  await showHubSilent($, timers, mode)
}

export const register: Register = on => {
  const timers: Timers = { tick: undefined }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'quiet',
      description: 'Mutes the toasts and sounds of your mods while you focus; with minutes it switches itself off.',
      argumentHint: '[minutes | off | status]',
    })
    afterStart($, 'quiet-mode', () => greetHub($, timers))
    return next(e)
  })

  on('command.run', { command: 'quiet' }, async ($, e) => ({ text: await runQuiet($, timers, e.args) }))

  on('ui.toast', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: undefined } : next(e)))

  on('audio.play', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: undefined } : next(e)))

  on('audio.speak', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: { via: 'system' as const } } : next(e)))
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
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

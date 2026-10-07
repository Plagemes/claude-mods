import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FocusTimer } from '../types'

const NAME = 'focus-timer'
const STORE_KEY = 'timer'
const BELL = 'assets/bell.wav'
const TICK_MS = 1_000
const MINUTE_MS = 60_000
const MAX_MINUTES = 240
/** A timer that ran out this recently, while no session was there to see it, still announces its end. */
const LATE_GRACE_MS = 2 * MINUTE_MS
const TOAST_MS = 10_000
const ROUNDS_PER_LONG_BREAK = 4
/** Claude Code ships `/focus` (its focus view), so the timer answers to `/pomodoro`. */
const USAGE = 'Usage: /pomodoro [minutes] · /pomodoro break [minutes] · /pomodoro status · /pomodoro stop'

const timer = atom({ plugin: 'focus-timer', key: 'timer' } as const, null)
const completed = atom({ plugin: 'focus-timer', key: 'completed' } as const, 0)

type Settings = { focusMinutes: number; breakMinutes: number; longBreakMinutes: number; sound: boolean }

/** The interval redrawing the status line. Module scope: a reloaded module starts without one. */
let ticker: Timer | undefined

const minutesOption = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_MINUTES ? value : fallback

const clockText = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1_000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const timeOfDay = (ms: number): string => {
  const date = new Date(ms)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const statusText = (running: FocusTimer, left: number): string =>
  running.phase === 'focus' ? `🍅 ${clockText(left)}` : `☕ ${clockText(left)} break`

const isTimer = (value: unknown): value is FocusTimer =>
  typeof value === 'object' &&
  value !== null &&
  'phase' in value &&
  (value.phase === 'focus' || value.phase === 'break') &&
  'endsAt' in value &&
  typeof value.endsAt === 'number' &&
  'minutes' in value &&
  typeof value.minutes === 'number' &&
  'round' in value &&
  typeof value.round === 'number'

/** Keeps the timer for this session and, by its end time, for the next one. */
async function save($: EngineInterface, value: FocusTimer | null): Promise<void> {
  await update($, timer, () => value)

  if (value === null) await $.store.delete(STORE_KEY)
  else await $.store.set(STORE_KEY, value)
}

// ── mods-hub: focus on the bus, Silent during a focus round, notices that reach you when away ───────

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
  await hubHello($, { version: await ownVersion($), publishes: ['focus.started', 'focus.ended'], consumes: ['session.away'] })
}

/**
 * A focus round starting, with the hub: `focus.started` (calendar-sync reads it), and Silent for the round's
 * minutes in every session unless it is on already, so other mods' toasts and sounds wait for the break.
 */
async function beginFocus($: EngineInterface, started: FocusTimer): Promise<FocusTimer> {
  const mode = await hubMode($)
  if (mode === undefined) return started
  await hubPublish($, { topic: 'focus.started', data: { minutes: started.minutes } })
  if (mode.isSilent) return started
  try {
    await $.mods.setMode({ silentMinutes: started.minutes })
    return { ...started, isSilencing: true }
  } catch {
    return started
  }
}

/** A focus round ending (run out, stopped or replaced): Silent off again if the round turned it on, and `focus.ended`. */
async function endFocus($: EngineInterface, ended: FocusTimer, isCompleted: boolean, now: number): Promise<void> {
  if (ended.phase !== 'focus') return
  if (ended.isSilencing === true) {
    try {
      await $.mods.setMode({ silentMinutes: null })
    } catch {
      // The hub is gone; its Silent ends by itself.
    }
  }
  const startedAt = ended.endsAt - ended.minutes * MINUTE_MS
  const minutes = isCompleted ? ended.minutes : Math.max(0, Math.round((now - startedAt) / MINUTE_MS))
  await hubPublish($, { topic: 'focus.ended', data: { minutes, isCompleted } })
}

/**
 * The end of a phase. Without the hub, a toast as always; with it, a notice: in the terminal while you are
 * at the keyboard, and on your channels too while the hub says you are away (`session.away`).
 */
async function announce($: EngineInterface, title: string): Promise<void> {
  const mode = await hubMode($)
  if (mode === undefined) {
    $.ui.toast(title, { timeoutMs: TOAST_MS })
    return
  }
  await hubNotify($, { level: mode.presence === 'away' ? 'success' : 'info', title, topic: 'focus.ended' })
}

function ensureTicking($: EngineInterface, settings: Settings): void {
  ticker ??= $.clock.every(TICK_MS, () => void tick($, settings))
}

/** Ends a phase: a focus round rolls into its break, a break ends the cycle. */
async function finish($: EngineInterface, ended: FocusTimer, now: number, settings: Settings): Promise<void> {
  await endFocus($, ended, true, now)
  if (ended.phase === 'focus') {
    const done = await update($, completed, n => n + 1)
    const isLong = done % ROUNDS_PER_LONG_BREAK === 0
    const minutes = isLong ? settings.longBreakMinutes : settings.breakMinutes

    if (minutes > 0) {
      const rest: FocusTimer = { phase: 'break', endsAt: now + minutes * MINUTE_MS, minutes, round: ended.round }
      await save($, rest)
      $.ui.status(statusText(rest, rest.endsAt - now))
      await announce($, `🍅 Round ${ended.round} done: take a ${isLong ? 'long ' : ''}${minutes}-minute break.`)
    } else {
      await save($, null)
      $.ui.status(undefined)
      await announce($, `🍅 Round ${ended.round} done. /pomodoro starts the next one.`)
    }
  } else {
    await save($, null)
    $.ui.status(undefined)
    await announce($, `☕ Break over. /pomodoro starts round ${ended.round + 1}.`)
  }

  if (settings.sound) await $.audio.play({ asset: BELL }).catch(() => undefined)
}

async function tick($: EngineInterface, settings: Settings): Promise<void> {
  const running = await read($, timer)

  if (running === null) {
    ticker?.cancel()
    ticker = undefined
    return
  }

  const now = await $.clock.now()

  if (running.endsAt > now) $.ui.status(statusText(running, running.endsAt - now))
  else await finish($, running, now, settings)
}

async function start($: EngineInterface, phase: FocusTimer['phase'], minutes: number, settings: Settings): Promise<string> {
  const now = await $.clock.now()
  const round = (await read($, completed)) + 1
  const replaced = await read($, timer)
  if (replaced !== null) await endFocus($, replaced, false, now)
  const planned: FocusTimer = { phase, endsAt: now + minutes * MINUTE_MS, minutes, round }
  const started = phase === 'focus' ? await beginFocus($, planned) : planned

  await save($, started)
  $.ui.status(statusText(started, started.endsAt - now))
  ensureTicking($, settings)

  return phase === 'focus'
    ? `🍅 Focus round ${round}: ${minutes} min, until ${timeOfDay(started.endsAt)}.`
    : `☕ Break: ${minutes} min, until ${timeOfDay(started.endsAt)}.`
}

async function describe($: EngineInterface): Promise<string> {
  const running = await read($, timer)
  const done = await read($, completed)
  const rounds = `${done} round${done === 1 ? '' : 's'} done this session`

  if (running === null) return `No timer running · ${rounds}.`

  const left = clockText(running.endsAt - (await $.clock.now()))

  return running.phase === 'focus'
    ? `🍅 Focus round ${running.round}: ${left} left · ${rounds}.`
    : `☕ Break: ${left} left · ${rounds}.`
}

/** Picks up a timer a previous session or module left running. */
async function restore($: EngineInterface, settings: Settings): Promise<void> {
  const stored = await $.store.get(STORE_KEY)
  if (!isTimer(stored)) return

  if (stored.endsAt + LATE_GRACE_MS < (await $.clock.now())) {
    await $.store.delete(STORE_KEY)
    return
  }

  await update($, timer, () => stored)
  ensureTicking($, settings)
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = {
    focusMinutes: minutesOption(options.focusMinutes, 25) || 25,
    breakMinutes: minutesOption(options.breakMinutes, 5),
    longBreakMinutes: minutesOption(options.longBreakMinutes, 15),
    sound: options.sound !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pomodoro',
      description: 'Pomodoro timer in the status line: /pomodoro [minutes], /pomodoro stop, /pomodoro status',
      argumentHint: '[minutes | break [minutes] | status | stop]',
      immediate: true,
    })
    await greetHub($)

    try {
      await restore($, settings)
    } catch (error) {
      $.ui.log(`${NAME}: could not restore the timer: ${String(error)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('command.run', { command: 'pomodoro' }, async ($, e) => {
    const [verb = '', amount] = e.args.trim().toLowerCase().split(/\s+/)
    if ((await read($, timer)) !== null) ensureTicking($, settings)

    if (verb === 'stop') {
      const running = await read($, timer)
      const wasRunning = running !== null
      if (running !== null) await endFocus($, running, false, await $.clock.now())
      await save($, null)
      $.ui.status(undefined)
      return { text: wasRunning ? 'Stopped.' : 'No timer running.' }
    }

    if (verb === 'status') return { text: await describe($) }

    const isBreak = verb === 'break'
    const asked = isBreak ? amount : verb
    const minutes = asked === undefined || asked === '' ? (isBreak ? settings.breakMinutes || 5 : settings.focusMinutes) : Number(asked)

    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
      return { text: `"${e.args.trim()}" is not a duration from 1 to ${MAX_MINUTES} minutes. ${USAGE}` }
    }

    return { text: await start($, isBreak ? 'break' : 'focus', minutes, settings) }
  })

  // A reload drops the interval; the next prompt or command starts it again for a timer still running.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if ((await read($, timer)) !== null) ensureTicking($, settings)

    return entered
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

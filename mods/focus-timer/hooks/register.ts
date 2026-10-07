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

function ensureTicking($: EngineInterface, settings: Settings): void {
  ticker ??= $.clock.every(TICK_MS, () => void tick($, settings))
}

/** Ends a phase: a focus round rolls into its break, a break ends the cycle. */
async function finish($: EngineInterface, ended: FocusTimer, now: number, settings: Settings): Promise<void> {
  if (ended.phase === 'focus') {
    const done = await update($, completed, n => n + 1)
    const isLong = done % ROUNDS_PER_LONG_BREAK === 0
    const minutes = isLong ? settings.longBreakMinutes : settings.breakMinutes

    if (minutes > 0) {
      const rest: FocusTimer = { phase: 'break', endsAt: now + minutes * MINUTE_MS, minutes, round: ended.round }
      await save($, rest)
      $.ui.status(statusText(rest, rest.endsAt - now))
      $.ui.toast(`🍅 Round ${ended.round} done: take a ${isLong ? 'long ' : ''}${minutes}-minute break.`, { timeoutMs: TOAST_MS })
    } else {
      await save($, null)
      $.ui.status(undefined)
      $.ui.toast(`🍅 Round ${ended.round} done. /pomodoro starts the next one.`, { timeoutMs: TOAST_MS })
    }
  } else {
    await save($, null)
    $.ui.status(undefined)
    $.ui.toast(`☕ Break over. /pomodoro starts round ${ended.round + 1}.`, { timeoutMs: TOAST_MS })
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
  const started: FocusTimer = { phase, endsAt: now + minutes * MINUTE_MS, minutes, round }

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

  if (running === null) return `${NAME}: no timer running · ${rounds}.`

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
      const wasRunning = (await read($, timer)) !== null
      await save($, null)
      $.ui.status(undefined)
      return { text: wasRunning ? `${NAME}: stopped.` : `${NAME}: no timer running.` }
    }

    if (verb === 'status') return { text: await describe($) }

    const isBreak = verb === 'break'
    const asked = isBreak ? amount : verb
    const minutes = asked === undefined || asked === '' ? (isBreak ? settings.breakMinutes || 5 : settings.focusMinutes) : Number(asked)

    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
      return { text: `${NAME}: "${e.args.trim()}" is not a duration from 1 to ${MAX_MINUTES} minutes. ${USAGE}` }
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

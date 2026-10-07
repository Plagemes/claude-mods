import { atom, read, update } from 'claude-code'
import type { EngineInterface, Origin, Register, Timer } from 'claude-code'

import type { QuietState } from '../types'
import { formatMinutes, muteVerdict, parseQuietArgs } from './args'

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

const runQuiet = async ($: EngineInterface, timers: Timers, args: string): Promise<string> => {
  const command = parseQuietArgs(args)
  if (command.kind === 'error') return command.message

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

export const register: Register = on => {
  const timers: Timers = { tick: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quiet',
      description: 'Mutes the toasts and sounds of your mods while you focus; with minutes it switches itself off.',
      argumentHint: '[minutes | off | status]',
    })
    return next(e)
  })

  on('command.run', { command: 'quiet' }, async ($, e) => ({ text: await runQuiet($, timers, e.args) }))

  on('ui.toast', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: undefined } : next(e)))

  on('audio.play', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: undefined } : next(e)))

  on('audio.speak', async ($, e, next) => ((await isMuting($, timers, next.origin)) ? { value: { via: 'system' as const } } : next(e)))
}

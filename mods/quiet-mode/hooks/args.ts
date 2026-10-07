export type QuietCommand =
  | { kind: 'toggle' }
  | { kind: 'on'; minutes: number | null }
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'error'; message: string }

export const MAX_MINUTES = 24 * 60
const DURATION = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i
const USAGE = 'Usage: /quiet [minutes | 25m | 1h | on | off | status]. With no argument it switches quiet mode on or off.'

/** What `/quiet <args>` asks for. Durations are in whole minutes, at least 1 and at most a day. */
export const parseQuietArgs = (args: string): QuietCommand => {
  const text = args.trim().toLowerCase()
  if (text === '') return { kind: 'toggle' }
  if (['off', 'stop', 'end', '0'].includes(text)) return { kind: 'off' }
  if (text === 'on') return { kind: 'on', minutes: null }
  if (text === 'status') return { kind: 'status' }

  const duration = DURATION.exec(text)
  if (duration === null) return { kind: 'error', message: USAGE }
  const amount = Number.parseFloat(duration[1] ?? '0')
  const isHours = duration[2]?.startsWith('h') === true
  const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.ceil(isHours ? amount * 60 : amount)))
  return { kind: 'on', minutes }
}

/** `25m`, `1h 5m`: the time left, rounded up to the minute. */
export const formatMinutes = (ms: number): string => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The origin of a call on `$`: which plugin made it, and which tier of the chain that plugin sits in. */
export type Caller = { plugin: string; tier: string }

export type MuteVerdict = 'mute' | 'pass' | 'expired'

/**
 * Whether a toast or sound raised by `caller` is swallowed. Only other mods the person installed (the `user` tier) are muted: this
 * plugin's own toasts, the engine's, bundled plugins' and a managed (administrator) plugin's still show. A timed quiet period
 * that has run out is `expired`: it lets the call through, and the caller ends the period.
 */
export const muteVerdict = (caller: Caller, self: string, state: { isOn: boolean; until: number | null }, now: number): MuteVerdict => {
  if (caller.tier !== 'user' || caller.plugin === self || !state.isOn) return 'pass'
  return state.until !== null && now >= state.until ? 'expired' : 'mute'
}

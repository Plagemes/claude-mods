/**
 * What the calendar tells the hub. Pure: the status and what is already applied in, one action out.
 * In a meeting the person is away (the hub routes to their channels, not the terminal); out of office the hub also
 * goes into a Night-like hold (nothing but critical reaches a channel, the rest waits for the digest).
 */
import type { CalendarStatus as Status } from '../types'

export type PresenceKind = 'busy' | 'off'

/** Quiet hours covering the whole day: the hub's Night mode, held until the calendar says the person is back. */
export const NIGHT_ALL_DAY = '00:00-23:59'

/** What this mod changed in the hub, remembered in a file so another session (or a restart) can undo it. */
export type Applied = {
  kind: PresenceKind
  since: number
  until: number
  /** The Night settings found before an out-of-office hold changed them. */
  restore?: { isNightOn: boolean; quietHours: string }
}

export type PresenceOptions = { meetings: boolean; outOfOffice: boolean }

export type Action =
  | { type: 'none' }
  | { type: 'engage'; kind: PresenceKind; until: number }
  | { type: 'switch'; kind: PresenceKind; until: number }
  | { type: 'retime'; until: number }
  | { type: 'release' }

const RETIME_MS = 60_000

/** The kind of hold a status asks for, or undefined when it asks for none. */
export function wantedKind(status: Status, options: PresenceOptions): PresenceKind | undefined {
  if (status.kind === 'busy' && options.meetings) return 'busy'
  if (status.kind === 'off' && options.outOfOffice) return 'off'
  return undefined
}

/** Compares what the calendar wants with what is applied. A transition is the only thing that acts. */
export function planPresence(status: Status, applied: Applied | null, options: PresenceOptions): Action {
  const wanted = wantedKind(status, options)
  const until = status.until ?? 0
  if (applied === null) return wanted === undefined ? { type: 'none' } : { type: 'engage', kind: wanted, until }
  if (wanted === undefined) return { type: 'release' }
  if (wanted !== applied.kind) return { type: 'switch', kind: wanted, until }
  if (Math.abs(until - applied.until) > RETIME_MS) return { type: 'retime', until }
  return { type: 'none' }
}

/** The shape of the event other mods can read: `x.calendar-sync.busy`. No titles leave this mod. */
export type BusyEvent = { isBusy: boolean; kind: 'meeting' | 'out-of-office' | 'free'; until: number | null }

export const busyEventOf = (applied: Applied | null): BusyEvent =>
  applied === null ? { isBusy: false, kind: 'free', until: null } : { isBusy: true, kind: applied.kind === 'off' ? 'out-of-office' : 'meeting', until: applied.until }

import type { BrMode, BrPrefs } from '../types'

/** `23-8` or `23:00-08:00` → { from: 23, to: 8 }; empty or malformed → null (no window). */
export const parseHours = (value: string): { from: number; to: number } | null => {
  const match = /^\s*(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?\s*$/.exec(value)
  if (match === null) return null
  const from = Number(match[1])
  const to = Number(match[2])
  if (from > 23 || to > 24 || from === to) return null
  return { from, to: to % 24 }
}

/** Whether `hour` (0-23) falls in the window, which may wrap midnight. */
export const inWindow = (hours: string, hour: number): boolean => {
  const window = parseHours(hours)
  if (window === null) return false
  return window.from < window.to ? hour >= window.from && hour < window.to : hour >= window.from || hour < window.to
}

export type OwnModeInput = {
  prefs: BrPrefs
  quietHours: string
  awayMinutes: number
  /** The newest keystroke or prompt across every session (ms). */
  lastActiveAt: number
  now: number
}

/**
 * The mode when no hub answers, from this mod's own switches: the same formula the hub uses (Interaction × presence ×
 * night), so a phone behaves the same either way.
 */
export const ownMode = (input: OwnModeInput): BrMode => {
  const { prefs, now } = input
  const quiet = now - input.lastActiveAt
  const presence = prefs.presence === 'away' ? 'away' : prefs.presence === 'here' ? 'here' : quiet >= input.awayMinutes * 60_000 ? 'away' : 'here'
  const isNight = inWindow(input.quietHours, new Date(now).getHours())
  const canAsk = prefs.interaction === 'on' ? !isNight : prefs.interaction === 'auto' ? presence === 'away' && !isNight : false
  return { source: 'own', presence, isSilent: false, isNight, interaction: prefs.interaction, canAsk }
}

export type Decision = { action: 'send' | 'drop'; reason: string }

/**
 * What to do with one message when no hub routes it: critical goes now, anything else only while away,
 * outside quiet hours and not paused. `notifyMode` is the person's own on/off/always setting.
 */
export const ownDecide = (level: string, mode: BrMode, notifyMode: 'away' | 'always' | 'off', isPaused: boolean): Decision => {
  if (notifyMode === 'off') return { action: 'drop', reason: 'notifications are off' }
  if (level === 'critical') return { action: 'send', reason: 'critical' }
  if (isPaused) return { action: 'drop', reason: 'this channel is paused' }
  if (mode.isNight) return { action: 'drop', reason: 'quiet hours' }
  if (notifyMode === 'away' && mode.presence !== 'away') return { action: 'drop', reason: 'you are at the keyboard' }
  return { action: 'send', reason: 'away' }
}

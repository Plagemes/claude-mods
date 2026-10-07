import type { PluginOptions } from 'claude-code'

import { offPatternOf, parseHm, parseWorkDays } from './agenda'
import type { CalSettings } from './agenda'
import { systemZone, isKnownZone } from './zones'

export type Settings = {
  icsUrl: string
  refreshMs: number
  meetings: boolean
  outOfOffice: boolean
  isStatusLine: boolean
  cal: CalSettings
}

const MINUTE_MS = 60_000
const WORK_HOURS = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback

/** userConfig into settings; every value has a default and a bad one falls back to it. */
export function readSettings(options: PluginOptions): Settings {
  const hours = WORK_HOURS.exec(text(options.workHours, '09:00-18:00'))
  const zone = text(options.timezone, '').trim()
  return {
    icsUrl: text(options.icsUrl, '').trim(),
    refreshMs: bounded(options.refreshMinutes, 15, 1, 24 * 60) * MINUTE_MS,
    meetings: flag(options.meetingPresence, true),
    outOfOffice: flag(options.outOfOffice, true),
    isStatusLine: flag(options.statusLine, true),
    cal: {
      zone: zone !== '' && isKnownZone(zone) ? zone : systemZone(),
      workStart: parseHm(hours?.[1] ?? '', { h: 9, mi: 0 }),
      workEnd: parseHm(hours?.[2] ?? '', { h: 18, mi: 0 }),
      workDays: parseWorkDays(text(options.workDays, 'mon-fri')),
      minSlotMinutes: bounded(options.minSlotMinutes, 30, 5, 480),
      offPattern: offPatternOf(text(options.offKeywords, '')),
      myEmail: text(options.myEmail, '').trim().toLowerCase(),
    },
  }
}

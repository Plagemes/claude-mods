/** The calendar cache: parsed events plus what they were parsed from, shared by every session through one file. */
import type { IcsEvent } from './ics'

export const CACHE_VERSION = 1

export type CalendarCache = {
  version: number
  /** A hash of the calendar address (never the address itself) so a changed address invalidates the cache. */
  source: string
  zone: string
  fetchedAt: number
  skipped: number
  events: IcsEvent[]
}

/** A short non-cryptographic hash (FNV-1a), enough to tell two addresses apart without storing one. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `webcal://` is `https://`; anything else that is not http(s) is no calendar address. */
export function normalizeUrl(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const url = text.replace(/^webcals?:\/\//i, 'https://')
  return /^https?:\/\/\S+$/i.test(url) ? url : undefined
}

export const looksLikeIcs = (text: string): boolean => /BEGIN:VCALENDAR/i.test(text)

export function parseCache(value: unknown): CalendarCache | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const cache = value as Partial<CalendarCache>
  if (cache.version !== CACHE_VERSION || typeof cache.source !== 'string' || typeof cache.zone !== 'string' || typeof cache.fetchedAt !== 'number' || !Array.isArray(cache.events)) return undefined
  return { version: CACHE_VERSION, source: cache.source, zone: cache.zone, fetchedAt: cache.fetchedAt, skipped: typeof cache.skipped === 'number' ? cache.skipped : 0, events: cache.events as IcsEvent[] }
}

/** Whether a cache is of this address and zone and young enough not to refetch. */
export const isFresh = (cache: CalendarCache | undefined, source: string, zone: string, now: number, refreshMs: number): boolean =>
  cache !== undefined && cache.source === source && cache.zone === zone && now - cache.fetchedAt < refreshMs && cache.fetchedAt <= now + 60_000

/** An error message with the secret address (and its host part) taken out. */
export const withoutUrl = (message: string, url: string): string => (url === '' ? message : message.split(url).join('[calendar address]'))

const DAY_MS = 24 * 60 * 60_000
const KEEP_PAST_MS = 7 * DAY_MS
const KEEP_AHEAD_MS = 400 * DAY_MS
/** `$.fs.read` refuses files over 4 MiB: the cache stays well under it. */
export const MAX_CACHED_EVENTS = 4_000

/** What is worth keeping: nothing that ended a week ago for good, nothing far in the future. */
export function prune(events: readonly IcsEvent[], now: number): IcsEvent[] {
  const kept = events.filter(event => {
    if (event.isCancelled && event.recurrenceId === undefined && event.rule === undefined) return false
    if (event.rule !== undefined && event.recurrenceId === undefined) return event.rule.until === undefined || event.rule.until > now - KEEP_PAST_MS
    return event.end > now - KEEP_PAST_MS && event.start < now + KEEP_AHEAD_MS
  })
  return kept.length <= MAX_CACHED_EVENTS ? kept : kept.sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now)).slice(0, MAX_CACHED_EVENTS)
}

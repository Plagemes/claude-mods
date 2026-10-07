import { expect, test } from 'claude-code/testing'

import { agendaText, bestSlotToday, buildView, classify, dayView, durationText, freeSlots, offPatternOf, parseHm, parseMinutes, parseWorkDays, spansOf, statusAt, statusLine, suggestSlot } from '../hooks/agenda'
import type { CalSettings } from '../hooks/agenda'
import { CACHE_VERSION, fingerprint, isFresh, looksLikeIcs, normalizeUrl, parseCache, prune, withoutUrl } from '../hooks/cache'
import type { CalendarCache } from '../hooks/cache'
import { expand, parseIcs } from '../hooks/ics'
import type { IcsEvent, Occurrence } from '../hooks/ics'
import { LEASE_STALE_MS, leaseAction, parseLease } from '../hooks/lease'
import { busyEventOf, planPresence, wantedKind } from '../hooks/presence'
import { readSettings } from '../hooks/settings'
import { startOfDay, timeText } from '../hooks/zones'

const ROME = 'Europe/Rome'
const settings: CalSettings = { zone: ROME, workStart: { h: 9, mi: 0 }, workEnd: { h: 18, mi: 0 }, workDays: [1, 2, 3, 4, 5], minSlotMinutes: 30, offPattern: offPatternOf(''), myEmail: '' }
/** Wednesday 7 October 2026, 12:00 in Rome (10:00 UTC). */
const NOW = Date.UTC(2026, 9, 7, 10, 0)
const at = (hhmm: string, day = 7): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return Date.UTC(2026, 9, day, h - 2, m)
}
const occ = (summary: string, from: string, to: string, extra: Partial<Occurrence> = {}, day = 7): Occurrence => ({
  uid: summary,
  summary,
  start: at(from, day),
  end: at(to, day),
  isAllDay: false,
  zone: ROME,
  isCancelled: false,
  isFree: false,
  isOof: false,
  declined: [],
  ...extra,
})
const allDay = (summary: string, firstDay: number, lastDay: number): Occurrence => ({ ...occ(summary, '00:00', '00:00'), isAllDay: true, start: at('00:00', firstDay), end: at('00:00', lastDay + 1) })

test('classify: meetings are busy, birthdays free, vacations off; "Kickoff" and "Holiday party" (1 h) are not time off', () => {
  expect(classify(occ('Design review', '10:00', '11:00'), settings)).toBe('busy')
  expect(classify(allDay('Anna birthday', 8, 8), settings)).toBe('free')
  expect(classify(allDay('Ferie estive', 8, 12), settings)).toBe('off')
  expect(classify(allDay('Vacation (Greece)', 8, 12), settings)).toBe('off')
  expect(classify(occ('Kickoff', '10:00', '11:00'), settings)).toBe('busy')
  expect(classify(occ('Holiday party planning', '10:00', '11:00'), settings)).toBe('busy')
  expect(classify(occ('Out of office', '10:00', '11:00'), settings)).toBe('off')
  expect(classify(occ('Permesso', '08:00', '16:00'), settings)).toBe('off')
  expect(classify(occ('Focus', '10:00', '11:00', { isFree: true }), settings)).toBe('free')
  expect(classify(occ('Anything', '10:00', '11:00', { isOof: true }), settings)).toBe('off')
  expect(classify(occ('Weekend trip', '10:00', '11:00'), { offPattern: offPatternOf('weekend trip, Wfh') })).toBe('off')
  expect(classify(occ('Malattia', '10:00', '11:00'), { offPattern: offPatternOf('') })).toBe('busy')
})

test('status: back-to-back meetings are one block, off wins over busy, a chain of all-day entries is one absence', () => {
  const meetings = [occ('A', '10:00', '10:30'), occ('B', '10:30', '11:00'), occ('C', '11:03', '12:30'), occ('D', '15:00', '16:00')]
  const during = statusAt(meetings, at('10:10'), settings)
  expect(during.kind).toBe('busy')
  expect(during.until).toBe(at('12:30'))
  expect(during.nextAt).toBe(at('15:00'))
  expect(spansOf(meetings, 'busy', settings)).toHaveLength(2)
  const free = statusAt(meetings, at('13:00'), settings)
  expect(free).toEqual({ kind: 'free', until: null, title: '', nextAt: at('15:00'), nextTitle: 'D' })
  const absent = [allDay('Ferie', 7, 9), allDay('Ferie', 10, 11), occ('Call', '10:00', '11:00')]
  const off = statusAt(absent, at('10:30'), settings)
  expect(off.kind).toBe('off')
  expect(off.until).toBe(at('00:00', 12))
})

test('free slots: working hours minus meetings, short gaps dropped, nothing on a day off or a weekend, none before now', () => {
  const day = startOfDay(NOW, ROME)
  const meetings = [occ('A', '09:30', '10:00'), occ('B', '11:00', '12:00'), occ('C', '16:45', '18:30')]
  const slots = freeSlots(meetings, day, settings)
  expect(slots.map(slot => `${timeText(slot.start, ROME)}-${timeText(slot.end, ROME)}`)).toEqual(['09:00-09:30', '10:00-11:00', '12:00-16:45'])
  expect(freeSlots(meetings, day, settings, at('12:30')).map(slot => timeText(slot.start, ROME))).toEqual(['12:30'])
  expect(freeSlots([allDay('Ferie', 7, 7)], day, settings)).toEqual([])
  expect(freeSlots([], startOfDay(at('12:00', 10), ROME), settings)).toEqual([])
  expect(freeSlots([], startOfDay(at('12:00', 10), ROME), { ...settings, workDays: [0, 6] })).toHaveLength(1)
})

test('suggestions: the first slot long enough today, else the next days; the longest slot left today', () => {
  const meetings = [occ('A', '13:00', '14:00'), occ('Thu', '09:00', '15:00', {}, 8)]
  expect(suggestSlot(meetings, NOW, 90, settings)?.text).toBe("You're free 14:00–18:00 today (4h)")
  expect(suggestSlot(meetings, NOW, 5 * 60, settings)?.text).toBe("You're free 09:00–18:00 on Fri 9 Oct (9h)")
  expect(suggestSlot([], NOW, 10 * 60, settings)).toBeUndefined()
  const best = bestSlotToday(meetings, NOW, settings)
  expect(best && timeText(best.start, ROME)).toBe('14:00')
})

test('input helpers: durations, hours, working days', () => {
  expect(parseMinutes('2h')).toBe(120)
  expect(parseMinutes('90m')).toBe(90)
  expect(parseMinutes('1,5 hours')).toBe(90)
  expect(parseMinutes('3')).toBe(180)
  expect(parseMinutes('45')).toBe(45)
  expect(parseMinutes('soon')).toBeUndefined()
  expect(durationText(150 * 60_000)).toBe('2h 30m')
  expect(parseHm('07:30', { h: 9, mi: 0 })).toEqual({ h: 7, mi: 30 })
  expect(parseHm('25:00', { h: 9, mi: 0 })).toEqual({ h: 9, mi: 0 })
  expect(parseWorkDays('mon-fri')).toEqual([1, 2, 3, 4, 5])
  expect(parseWorkDays('mon,wed, Sat')).toEqual([1, 3, 6])
  expect(parseWorkDays('sat-mon')).toEqual([0, 1, 6])
  expect(parseWorkDays('nonsense')).toEqual([1, 2, 3, 4, 5])
})

test('the view: today and tomorrow with the agenda, what is on now, free slots and the status line', () => {
  const meetings = [occ('Standup', '09:30', '09:45'), occ('Client call', '11:30', '12:30', { location: 'Zoom' }), allDay('Anna birthday', 7, 7), occ('Retro', '09:30', '10:30', {}, 8)]
  const view = buildView(meetings, NOW, settings, { phase: 'ready', message: '', fetchedAt: NOW })
  const today = view.days[0]
  expect(today?.rows.map(row => row.title)).toEqual(['Anna birthday', 'Standup', 'Client call'])
  expect(today?.rows.map(row => row.isNow)).toEqual([true, false, true])
  expect(today?.rows.map(row => row.isPast)).toEqual([false, true, false])
  expect(view.status.kind).toBe('busy')
  expect(statusLine(view.status, NOW, ROME)).toBe('In a meeting until 12:30')
  expect(view.freeLine).toBe("You're free 12:30–18:00 today (5h 30m)")
  const text = agendaText(view)
  expect(text).toContain('Today · Wed 7 Oct')
  expect(text).toContain('11:30–12:30 Client call · Zoom')
  expect(text).toContain('Tomorrow · Thu 8 Oct')
  expect(dayView(meetings, startOfDay(at('12:00', 8), ROME), NOW, settings).slots.length).toBeGreaterThan(0)
  expect(statusLine({ kind: 'free', until: null, title: '', nextAt: NOW + 20 * 60_000, nextTitle: 'Standup' }, NOW, ROME)).toBe('Next in 20m: Standup')
  expect(statusLine({ kind: 'free', until: null, title: '', nextAt: NOW + 5 * 3_600_000, nextTitle: 'Late' }, NOW, ROME)).toBe('')
  expect(statusLine({ kind: 'off', until: at('00:00', 12), title: 'Ferie', nextAt: null, nextTitle: '' }, NOW, ROME)).toBe('Out of office until Mon 12 Oct')
  expect(agendaText({ ...view, phase: 'unconfigured', days: [] })).toContain('private iCal')
})

test('end to end: an ICS text becomes today\'s agenda in the person\'s zone', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT\nUID:1\nSUMMARY:Planning\nDTSTART;TZID=W. Europe Standard Time:20261007T143000\nDTEND;TZID=W. Europe Standard Time:20261007T153000\nEND:VEVENT',
    'BEGIN:VEVENT\nUID:2\nSUMMARY:Ferie\nDTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261014\nEND:VEVENT',
    'END:VCALENDAR',
  ].join('\n')
  const events = parseIcs(ics, ROME).events
  const view = buildView(expand(events, startOfDay(NOW, ROME), startOfDay(NOW, ROME) + 21 * 86_400_000), NOW, settings, { phase: 'ready', message: '', fetchedAt: NOW }, 7)
  expect(agendaText(view)).toContain('14:30–15:30 Planning')
  expect(view.days[5]?.rows[0]?.kind).toBe('off')
})

test('presence plan: a meeting engages away, a switch to time off, a longer meeting retimes, free releases', () => {
  const on = { meetings: true, outOfOffice: true }
  const busy = { kind: 'busy' as const, until: at('12:30'), title: 'Call', nextAt: null, nextTitle: '' }
  const off = { kind: 'off' as const, until: at('00:00', 12), title: 'Ferie', nextAt: null, nextTitle: '' }
  const free = { kind: 'free' as const, until: null, title: '', nextAt: null, nextTitle: '' }
  expect(planPresence(busy, null, on)).toEqual({ type: 'engage', kind: 'busy', until: at('12:30') })
  expect(planPresence(free, null, on)).toEqual({ type: 'none' })
  const applied = { kind: 'busy' as const, since: NOW, until: at('12:30') }
  expect(planPresence(busy, applied, on)).toEqual({ type: 'none' })
  expect(planPresence({ ...busy, until: at('13:30') }, applied, on)).toEqual({ type: 'retime', until: at('13:30') })
  expect(planPresence({ ...busy, until: at('12:30') + 30_000 }, applied, on)).toEqual({ type: 'none' })
  expect(planPresence(off, applied, on)).toEqual({ type: 'switch', kind: 'off', until: at('00:00', 12) })
  expect(planPresence(free, applied, on)).toEqual({ type: 'release' })
  expect(planPresence(busy, null, { meetings: false, outOfOffice: true })).toEqual({ type: 'none' })
  expect(planPresence(off, null, { meetings: true, outOfOffice: false })).toEqual({ type: 'none' })
  expect(wantedKind(off, on)).toBe('off')
  expect(busyEventOf(applied)).toEqual({ isBusy: true, kind: 'meeting', until: at('12:30') })
  expect(busyEventOf({ ...applied, kind: 'off' }).kind).toBe('out-of-office')
  expect(busyEventOf(null)).toEqual({ isBusy: false, kind: 'free', until: null })
})

test('cache: addresses are fingerprinted, never stored; webcal becomes https; freshness, pruning and the secret in errors', () => {
  expect(fingerprint('https://calendar.example/a')).not.toBe(fingerprint('https://calendar.example/b'))
  expect(fingerprint('x')).toBe(fingerprint('x'))
  expect(normalizeUrl('webcal://p01-caldav.icloud.com/published/2/abc')).toBe('https://p01-caldav.icloud.com/published/2/abc')
  expect(normalizeUrl(' https://calendar.google.com/calendar/ical/x/private-1/basic.ics ')).toBe('https://calendar.google.com/calendar/ical/x/private-1/basic.ics')
  expect(normalizeUrl('file:///etc/passwd')).toBeUndefined()
  expect(normalizeUrl('')).toBeUndefined()
  expect(looksLikeIcs('BEGIN:VCALENDAR\nEND:VCALENDAR')).toBe(true)
  expect(looksLikeIcs('<html>login</html>')).toBe(false)
  const cache: CalendarCache = { version: CACHE_VERSION, source: 'abc', zone: ROME, fetchedAt: NOW, skipped: 0, events: [] }
  expect(parseCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache)
  expect(parseCache({ version: 0 })).toBeUndefined()
  expect(isFresh(cache, 'abc', ROME, NOW + 5 * 60_000, 15 * 60_000)).toBe(true)
  expect(isFresh(cache, 'abc', ROME, NOW + 16 * 60_000, 15 * 60_000)).toBe(false)
  expect(isFresh(cache, 'other', ROME, NOW, 15 * 60_000)).toBe(false)
  expect(isFresh(cache, 'abc', 'UTC', NOW, 15 * 60_000)).toBe(false)
  expect(isFresh(undefined, 'abc', ROME, NOW, 15 * 60_000)).toBe(false)
  const url = 'https://calendar.example/private-SECRET/basic.ics'
  expect(withoutUrl(`fetch failed for ${url}: timeout`, url)).toBe('fetch failed for [calendar address]: timeout')
  const base = { uid: 'x', summary: '', start: 0, end: 0, isAllDay: false, zone: ROME, exdates: [], isCancelled: false, isFree: false, isOof: false, declined: [] } satisfies IcsEvent
  const day = 86_400_000
  const kept = prune(
    [
      { ...base, uid: 'old', start: NOW - 30 * day, end: NOW - 29 * day },
      { ...base, uid: 'recent', start: NOW - 2 * day, end: NOW - 2 * day + 3_600_000 },
      { ...base, uid: 'far', start: NOW + 900 * day, end: NOW + 900 * day + 3_600_000 },
      { ...base, uid: 'series', start: NOW - 900 * day, end: NOW - 900 * day + 3_600_000, rule: { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: [], byMonth: [], weekStart: 1 } },
      { ...base, uid: 'ended-series', start: NOW - 900 * day, end: NOW - 900 * day + 3_600_000, rule: { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: [], byMonth: [], weekStart: 1, until: NOW - 100 * day } },
    ],
    NOW,
  )
  expect(kept.map(event => event.uid)).toEqual(['recent', 'series'])
})

test('lease: a missing or stale lease is taken, our own renewed, a live one followed', () => {
  expect(leaseAction(null, 'me', NOW)).toBe('take')
  expect(leaseAction({ sessionId: 'me', heartbeatAt: NOW - 5_000, since: NOW - 60_000 }, 'me', NOW)).toBe('renew')
  expect(leaseAction({ sessionId: 'other', heartbeatAt: NOW - 5_000, since: NOW - 60_000 }, 'me', NOW)).toBe('follow')
  expect(leaseAction({ sessionId: 'other', heartbeatAt: NOW - LEASE_STALE_MS - 1, since: NOW - 60_000 }, 'me', NOW)).toBe('take')
  expect(parseLease({ sessionId: 's', heartbeatAt: 5 })).toEqual({ sessionId: 's', heartbeatAt: 5, since: 5 })
  expect(parseLease('nope')).toBeNull()
})

test('settings: defaults work with no config; bad values fall back', () => {
  const none = readSettings({})
  expect(none.icsUrl).toBe('')
  expect(none.refreshMs).toBe(15 * 60_000)
  expect(none.cal.workStart).toEqual({ h: 9, mi: 0 })
  expect(none.cal.workDays).toEqual([1, 2, 3, 4, 5])
  expect(none.meetings).toBe(true)
  const custom = readSettings({ icsUrl: ' https://x.example/a.ics ', timezone: 'Europe/Rome', workHours: '08:00-16:30', refreshMinutes: 5, minSlotMinutes: 45, myEmail: 'Me@X.io', meetingPresence: false })
  expect(custom.icsUrl).toBe('https://x.example/a.ics')
  expect(custom.cal.zone).toBe('Europe/Rome')
  expect(custom.cal.workEnd).toEqual({ h: 16, mi: 30 })
  expect(custom.cal.minSlotMinutes).toBe(45)
  expect(custom.cal.myEmail).toBe('me@x.io')
  expect(custom.meetings).toBe(false)
  const bad = readSettings({ timezone: 'Not/AZone', workHours: 'whenever', refreshMinutes: -3 })
  expect(bad.cal.workStart).toEqual({ h: 9, mi: 0 })
  expect(bad.refreshMs).toBe(15 * 60_000)
  expect(bad.cal.zone).not.toBe('Not/AZone')
})

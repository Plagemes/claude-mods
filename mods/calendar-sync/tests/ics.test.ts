import { expect, test } from 'claude-code/testing'

import { expand, parseDateValue, parseDuration, parseIcs, parseLine, parseRule, unescapeText, unfold } from '../hooks/ics'
import { epochToWall, resolveZone, wallToEpoch, zoneOffsetMs } from '../hooks/zones'

const ROME = 'Europe/Rome'
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16) + 'Z'
const calendar = (...events: string[]): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const event = (...lines: string[]): string => `BEGIN:VEVENT\r\nUID:${lines.find(line => line.startsWith('UID:'))?.slice(4) ?? 'u1'}\r\n${lines.filter(line => !line.startsWith('UID:')).join('\r\n')}\r\nEND:VEVENT`
const startsOf = (text: string, from: string, to: string, zone = ROME): string[] =>
  expand(parseIcs(text, zone).events, Date.parse(from), Date.parse(to)).map(occurrence => iso(occurrence.start))

test('lines: folded lines are joined, quoted parameters may hold colons and semicolons, text escapes are undone', () => {
  expect(unfold('SUMMARY:Quarterly pla\r\n nning\r\n\tmeeting\r\nUID:1')).toEqual(['SUMMARY:Quarterly planningmeeting', 'UID:1'])
  const line = parseLine('ATTENDEE;CN="Doe, John: Jr; CEO";PARTSTAT=DECLINED:mailto:jo@example.com')
  expect(line?.name).toBe('ATTENDEE')
  expect(line?.params).toEqual({ CN: 'Doe, John: Jr; CEO', PARTSTAT: 'DECLINED' })
  expect(line?.value).toBe('mailto:jo@example.com')
  expect(parseLine('no colon here')).toBeUndefined()
  expect(unescapeText('Lunch\\, then review\\nRoom 4\; floor 2 \\\\ done')).toBe('Lunch, then review\nRoom 4; floor 2 \\ done')
})

test('values: dates, date-times, UTC marks and durations', () => {
  expect(parseDateValue('20261007')).toEqual({ wall: { y: 2026, m: 10, d: 7, h: 0, mi: 0, s: 0 }, isUtc: false, isDate: true })
  expect(parseDateValue('20261007T093000Z')).toEqual({ wall: { y: 2026, m: 10, d: 7, h: 9, mi: 30, s: 0 }, isUtc: true, isDate: false })
  expect(parseDateValue('20261307T093000')).toBeUndefined()
  expect(parseDateValue('garbage')).toBeUndefined()
  expect(parseDuration('PT1H30M')).toBe(90 * 60_000)
  expect(parseDuration('P1D')).toBe(24 * 3_600_000)
  expect(parseDuration('P1W')).toBe(7 * 24 * 3_600_000)
  expect(parseDuration('-PT15M')).toBe(-15 * 60_000)
  expect(parseDuration('1 hour')).toBeUndefined()
})

test('zones: wall clock to instant and back through Intl, DST included; Windows and path names resolve', () => {
  // Rome: UTC+2 until the last Sunday of October (25 Oct 2026), then UTC+1.
  expect(zoneOffsetMs(ROME, Date.UTC(2026, 6, 1))).toBe(2 * 3_600_000)
  expect(zoneOffsetMs(ROME, Date.UTC(2026, 11, 1))).toBe(3_600_000)
  expect(iso(wallToEpoch({ y: 2026, m: 10, d: 7, h: 11, mi: 0, s: 0 }, ROME))).toBe('2026-10-07T09:00Z')
  expect(iso(wallToEpoch({ y: 2026, m: 12, d: 7, h: 11, mi: 0, s: 0 }, ROME))).toBe('2026-12-07T10:00Z')
  expect(epochToWall(Date.UTC(2026, 9, 7, 22, 30), 'America/New_York')).toEqual({ y: 2026, m: 10, d: 7, h: 18, mi: 30, s: 0 })
  // The hour that does not exist (02:30 on 29 March 2026 in Rome) lands after the gap, not before it.
  expect(iso(wallToEpoch({ y: 2026, m: 3, d: 29, h: 2, mi: 30, s: 0 }, ROME))).toBe('2026-03-29T01:30Z')
  expect(resolveZone('W. Europe Standard Time')).toBe('Europe/Berlin')
  expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles')
  expect(resolveZone('/mozilla.org/20050126_1/Europe/Rome')).toBe('Europe/Rome')
  expect(resolveZone('Mars/Olympus')).toBeUndefined()
})

test('events: UTC, TZID, Windows TZID, floating and unknown-zone events land on the right instant', () => {
  const text = calendar(
    event('UID:utc', 'SUMMARY:Utc call', 'DTSTART:20261007T090000Z', 'DTEND:20261007T100000Z'),
    event('UID:rome', 'SUMMARY:Rome call', 'DTSTART;TZID=Europe/Rome:20261007T110000', 'DTEND;TZID=Europe/Rome:20261007T120000'),
    event('UID:win', 'SUMMARY:Outlook call', 'DTSTART;TZID=W. Europe Standard Time:20261007T110000', 'DURATION:PT45M'),
    event('UID:float', 'SUMMARY:Floating', 'DTSTART:20261007T110000', 'DTEND:20261007T113000'),
    event('UID:ny', 'SUMMARY:New York', 'DTSTART;TZID=America/New_York:20261007T090000', 'DTEND;TZID=America/New_York:20261007T100000'),
  )
  const events = parseIcs(text, ROME).events
  const by = (uid: string) => events.find(one => one.uid === uid)
  expect(iso(by('utc')?.start ?? 0)).toBe('2026-10-07T09:00Z')
  expect(iso(by('rome')?.start ?? 0)).toBe('2026-10-07T09:00Z')
  expect(iso(by('win')?.start ?? 0)).toBe('2026-10-07T09:00Z')
  expect(iso(by('win')?.end ?? 0)).toBe('2026-10-07T09:45Z')
  expect(iso(by('float')?.start ?? 0)).toBe('2026-10-07T09:00Z')
  expect(iso(by('ny')?.start ?? 0)).toBe('2026-10-07T13:00Z')
  // The same floating time in another local zone is another instant.
  expect(iso(parseIcs(text, 'America/New_York').events.find(one => one.uid === 'float')?.start ?? 0)).toBe('2026-10-07T15:00Z')
})

test('events: a VTIMEZONE Intl does not know becomes a fixed offset; a block with no zone falls back to local', () => {
  const text = calendar(
    'BEGIN:VTIMEZONE\r\nTZID:Company HQ\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE',
    event('UID:hq', 'SUMMARY:HQ sync', 'DTSTART;TZID=Company HQ:20261007T100000', 'DTEND;TZID=Company HQ:20261007T110000'),
    event('UID:lost', 'SUMMARY:Lost zone', 'DTSTART;TZID=Nowhere Standard Time:20261007T100000', 'DTEND;TZID=Nowhere Standard Time:20261007T110000'),
  )
  const events = parseIcs(text, ROME).events
  expect(iso(events.find(one => one.uid === 'hq')?.start ?? 0)).toBe('2026-10-07T04:30Z')
  expect(iso(events.find(one => one.uid === 'lost')?.start ?? 0)).toBe('2026-10-07T08:00Z')
})

test('all-day events: local midnight, exclusive end date, one day when no end is given', () => {
  const text = calendar(
    event('UID:trip', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261013'),
    event('UID:bday', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:20261008'),
  )
  const events = parseIcs(text, ROME).events
  const trip = events.find(one => one.uid === 'trip')
  expect(trip?.isAllDay).toBe(true)
  expect(iso(trip?.start ?? 0)).toBe('2026-10-09T22:00Z')
  expect(iso(trip?.end ?? 0)).toBe('2026-10-12T22:00Z')
  const birthday = events.find(one => one.uid === 'bday')
  expect(iso(birthday?.end ?? 0)).toBe('2026-10-08T22:00Z')
  const found = expand(events, Date.parse('2026-10-11T10:00Z'), Date.parse('2026-10-11T11:00Z'))
  expect(found.map(one => one.summary)).toEqual(['Trip'])
})

test('RRULE weekly: BYDAY, UNTIL, EXDATE and INTERVAL', () => {
  const standup = calendar(event('UID:s', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Rome:20261005T093000', 'DTEND;TZID=Europe/Rome:20261005T094500', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261014T000000Z', 'EXDATE;TZID=Europe/Rome:20261007T093000'))
  expect(startsOf(standup, '2026-10-01T00:00Z', '2026-11-01T00:00Z')).toEqual(['2026-10-05T07:30Z', '2026-10-09T07:30Z', '2026-10-12T07:30Z'])
  const biweekly = calendar(event('UID:b', 'SUMMARY:Retro', 'DTSTART:20261001T140000Z', 'DTEND:20261001T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH'))
  expect(startsOf(biweekly, '2026-10-01T00:00Z', '2026-11-10T00:00Z')).toEqual(['2026-10-01T14:00Z', '2026-10-15T14:00Z', '2026-10-29T14:00Z'])
  // A date-only UNTIL covers the whole day it names.
  const untilDay = calendar(event('UID:u', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Rome:20261005T180000', 'DTEND;TZID=Europe/Rome:20261005T190000', 'RRULE:FREQ=DAILY;UNTIL=20261007'))
  expect(startsOf(untilDay, '2026-10-01T00:00Z', '2026-10-20T00:00Z')).toEqual(['2026-10-05T16:00Z', '2026-10-06T16:00Z', '2026-10-07T16:00Z'])
})

test('RRULE: COUNT counts from the first instance, including those before the window, and EXDATEs still use up a count', () => {
  const text = calendar(event('UID:c', 'SUMMARY:Course', 'DTSTART:20261001T100000Z', 'DTEND:20261001T110000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261003T100000Z'))
  expect(startsOf(text, '2026-09-01T00:00Z', '2026-12-01T00:00Z')).toEqual(['2026-10-01T10:00Z', '2026-10-02T10:00Z', '2026-10-04T10:00Z', '2026-10-05T10:00Z'])
  expect(startsOf(text, '2026-10-04T00:00Z', '2026-12-01T00:00Z')).toEqual(['2026-10-04T10:00Z', '2026-10-05T10:00Z'])
})

test('RRULE: a daily 09:00 in Rome stays 09:00 local across the end of daylight saving time (24 Oct 07:00Z, 25 Oct 08:00Z)', () => {
  const text = calendar(event('UID:d', 'SUMMARY:Daily', 'DTSTART;TZID=Europe/Rome:20261023T090000', 'DTEND;TZID=Europe/Rome:20261023T093000', 'RRULE:FREQ=DAILY'))
  expect(startsOf(text, '2026-10-24T00:00Z', '2026-10-27T00:00Z')).toEqual(['2026-10-24T07:00Z', '2026-10-25T08:00Z', '2026-10-26T08:00Z'])
})

test('RRULE: monthly by day of month, by Nth weekday and by last day; yearly all-day', () => {
  const second = calendar(event('UID:m1', 'SUMMARY:Board', 'DTSTART:20261013T150000Z', 'DTEND:20261013T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'))
  expect(startsOf(second, '2026-10-01T00:00Z', '2027-01-01T00:00Z')).toEqual(['2026-10-13T15:00Z', '2026-11-10T15:00Z', '2026-12-08T15:00Z'])
  const lastFriday = calendar(event('UID:m2', 'SUMMARY:Demo', 'DTSTART:20261030T130000Z', 'DTEND:20261030T140000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'))
  expect(startsOf(lastFriday, '2026-10-01T00:00Z', '2027-01-01T00:00Z')).toEqual(['2026-10-30T13:00Z', '2026-11-27T13:00Z', '2026-12-25T13:00Z'])
  const lastDay = calendar(event('UID:m3', 'SUMMARY:Invoices', 'DTSTART:20261031T080000Z', 'DTEND:20261031T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'))
  expect(startsOf(lastDay, '2026-10-01T00:00Z', '2027-03-01T00:00Z')).toEqual(['2026-10-31T08:00Z', '2026-11-30T08:00Z', '2026-12-31T08:00Z', '2027-01-31T08:00Z', '2027-02-28T08:00Z'])
  const thirtyFirst = calendar(event('UID:m4', 'SUMMARY:Payroll', 'DTSTART:20261031T080000Z', 'DTEND:20261031T090000Z', 'RRULE:FREQ=MONTHLY'))
  expect(startsOf(thirtyFirst, '2026-10-01T00:00Z', '2027-02-01T00:00Z')).toEqual(['2026-10-31T08:00Z', '2026-12-31T08:00Z', '2027-01-31T08:00Z'])
  const yearly = calendar(event('UID:y', 'SUMMARY:Anniversary', 'DTSTART;VALUE=DATE:20200315', 'RRULE:FREQ=YEARLY'))
  const found = expand(parseIcs(yearly, ROME).events, Date.parse('2027-03-14T00:00Z'), Date.parse('2027-03-17T00:00Z'))
  expect(found).toHaveLength(1)
  expect(iso(found[0]?.start ?? 0)).toBe('2027-03-14T23:00Z')
})

test('overrides: a moved instance replaces the original, a cancelled one disappears, a cancelled entry never shows', () => {
  const text = calendar(
    event('UID:w', 'SUMMARY:Weekly sync', 'DTSTART:20261005T100000Z', 'DTEND:20261005T110000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO'),
    event('UID:w', 'SUMMARY:Weekly sync (moved)', 'RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261013T120000Z', 'DTEND:20261013T130000Z'),
    event('UID:w', 'SUMMARY:Weekly sync', 'RECURRENCE-ID:20261019T100000Z', 'DTSTART:20261019T100000Z', 'DTEND:20261019T110000Z', 'STATUS:CANCELLED'),
    event('UID:x', 'SUMMARY:Cancelled meeting', 'DTSTART:20261008T100000Z', 'DTEND:20261008T110000Z', 'STATUS:CANCELLED'),
  )
  const found = expand(parseIcs(text, ROME).events, Date.parse('2026-10-01T00:00Z'), Date.parse('2026-10-31T00:00Z'))
  expect(found.map(one => `${iso(one.start)} ${one.summary}`)).toEqual([
    '2026-10-05T10:00Z Weekly sync',
    '2026-10-13T12:00Z Weekly sync (moved)',
    '2026-10-26T10:00Z Weekly sync',
  ])
})

test('flags: free/transparent, out of office and declined attendees', () => {
  const text = calendar(
    event('UID:t', 'SUMMARY:Focus block', 'DTSTART:20261007T090000Z', 'DTEND:20261007T100000Z', 'TRANSP:TRANSPARENT'),
    event('UID:o', 'SUMMARY:Away', 'DTSTART:20261007T090000Z', 'DTEND:20261007T100000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:OOF'),
    event('UID:d', 'SUMMARY:Declined', 'DTSTART:20261007T090000Z', 'DTEND:20261007T100000Z', 'ATTENDEE;CN=Me;PARTSTAT=DECLINED:mailto:Me@Example.com'),
  )
  const events = parseIcs(text, ROME).events
  expect(events.find(one => one.uid === 't')?.isFree).toBe(true)
  expect(events.find(one => one.uid === 'o')?.isOof).toBe(true)
  const window = [Date.parse('2026-10-07T00:00Z'), Date.parse('2026-10-08T00:00Z')] as const
  expect(expand(events, ...window).map(one => one.summary)).toContain('Declined')
  expect(expand(events, ...window, { myEmail: 'me@example.com' }).map(one => one.summary)).not.toContain('Declined')
})

test('robustness: an old daily series is expanded quickly, rules with no instances end, unsupported frequencies show once, bad entries are counted', () => {
  const old = calendar(event('UID:old', 'SUMMARY:Daily since 2019', 'DTSTART:20190102T080000Z', 'DTEND:20190102T081500Z', 'RRULE:FREQ=DAILY'))
  expect(startsOf(old, '2026-10-07T00:00Z', '2026-10-09T00:00Z')).toEqual(['2026-10-07T08:00Z', '2026-10-08T08:00Z'])
  const never = calendar(event('UID:n', 'SUMMARY:Feb 30', 'DTSTART:20260101T080000Z', 'DTEND:20260101T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'))
  expect(startsOf(never, '2026-10-01T00:00Z', '2030-01-01T00:00Z')).toEqual([])
  const hourly = calendar(event('UID:h', 'SUMMARY:Hourly', 'DTSTART:20261007T080000Z', 'DTEND:20261007T083000Z', 'RRULE:FREQ=HOURLY'))
  expect(startsOf(hourly, '2026-10-07T00:00Z', '2026-10-08T00:00Z')).toEqual(['2026-10-07T08:00Z'])
  const bad = calendar(event('UID:bad', 'SUMMARY:No start'), event('UID:ok', 'SUMMARY:Fine', 'DTSTART:20261007T080000Z', 'DTEND:20261007T090000Z'))
  const parsed = parseIcs(bad, ROME)
  expect(parsed.skipped).toBe(1)
  expect(parsed.events.map(one => one.summary)).toEqual(['Fine'])
  expect(parseRule('FREQ=SECONDLY', ROME)).toBeUndefined()
})

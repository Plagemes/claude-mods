import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { fingerprint } from '../hooks/cache'
import { parseIcs } from '../hooks/ics'
import { callsOf, hubStandIn, prefsOf, setPrefs } from './hub'

const PLUGIN = 'calendar-sync'
const SURFACES = ['terminal', 'desktop'] as const
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const MINUTE = 60_000
/** Wednesday 7 October 2026, 11:45 in Rome (09:45 UTC): a meeting is on. */
const NOW = Date.UTC(2026, 9, 7, 9, 45)
const HOME = '/home/me'
const DIR = `${HOME}/.claude/claude-mods/calendar-sync`
const URL = 'https://calendar.google.com/calendar/ical/me%40example.com/private-SECRETSECRET/basic.ics'
const OPTIONS = { icsUrl: URL, timezone: 'Europe/Rome' }
const PANE: RenderPropsOf['Pane'] = { title: 'Calendar', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

const calendar = (...events: string[]): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const event = (uid: string, summary: string, ...lines: string[]): string => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\n${lines.join('\r\n')}\r\nEND:VEVENT`
const MEETINGS = calendar(
  event('m1', 'Client call', 'DTSTART:20261007T093000Z', 'DTEND:20261007T103000Z'),
  event('m2', 'Review', 'DTSTART:20261007T130000Z', 'DTEND:20261007T140000Z'),
  event('v', 'Ferie', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261014'),
)
const VACATION = calendar(event('v', 'Vacation', 'DTSTART;VALUE=DATE:20261006', 'DTEND;VALUE=DATE:20261010'))
const QUIET = calendar(event('r', 'Review', 'DTSTART:20261007T130000Z', 'DTEND:20261007T140000Z'))

type WorldOptions = { ics?: string; status?: number; text?: string; files?: Record<string, string> }

/** Stands for everything beneath the plugin: the calendar server, files, the session, the screen. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const mtimes = new Map<string, number>()
  const net = { ics: options.ics ?? MEETINGS, status: options.status ?? 200, text: options.text, hang: false, urls: [] as string[], headers: [] as unknown[] }
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const panes: string[] = []
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    mtimes.set(e.path, await clock.now())
    return { value: undefined }
  })
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: (files.get(e.path) ?? '').length, mtimeMs: mtimes.get(e.path) ?? 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('http.fetch', ($, e) => {
    net.urls.push(e.url)
    if (net.hang) return new Promise<never>(() => undefined)
    net.headers.push(e.init?.headers)
    const text = net.text ?? net.ics
    return { value: { status: net.status, ok: net.status >= 200 && net.status < 300, headers: {}, text } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.root', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, files, net, statuses, toasts, logs, panes }
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive })
const calls = ($: Engine, method: string) => callsOf($, method, PLUGIN)
const prefs = async ($: Engine) => (await prefsOf($)) as { presence: string; isNightOn: boolean; quietHours: string }
const calendarCommand = ($: Engine, args = '') => $.command.run({ command: 'calendar', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }).then(result => String(result.text ?? ''))
/** Lets the heartbeat run: the first beat takes the lease, the second trusts it. */
const beats = async (w: ReturnType<typeof world>, count = 2) => {
  for (let i = 0; i < count; i += 1) await w.clock.advance(10_000)
}

test('without the hub: /calendar shows today and tomorrow, free slots, the status line works and nothing breaks', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w)
  expect(w.net.urls).toEqual([URL])
  const text = await calendarCommand($)
  expect(text).toContain('Today · Wed 7 Oct')
  expect(text).toContain('11:30–12:30 Client call')
  expect(text).toContain('15:00–16:00 Review')
  expect(text).toContain('Now: In a meeting until 12:30')
  expect(text).toContain("You're free 12:30–15:00 today (2h 30m)")
  expect(text).toContain('Tomorrow · Thu 8 Oct')
  expect(w.statuses.at(-1)).toBe('📅 In a meeting until 12:30')
  expect(await calendarCommand($, 'free 3h')).toBe("You're free 09:00–18:00 tomorrow (9h)")
  expect(await calendarCommand($, 'free 2h')).toBe("You're free 12:30–15:00 today (2h 30m)")
  expect(await calendarCommand($, 'free 45m')).toBe("You're free 12:30–15:00 today (2h 30m)")
  expect(await calendarCommand($, 'free 20h')).toBe('No free slot of 20h in the next week.')
  const week = await calendarCommand($, 'week')
  expect(week).toContain('Mon 12 Oct')
  expect(week).toContain('✈ all day')
  expect(await calendarCommand($, 'bogus')).toContain('Usage: /calendar')
  expect(await calendarCommand($, 'setup')).toContain('Secret address in iCal format')
  // The secret address never reaches a toast, a log or the cache file.
  expect([...w.toasts, ...w.logs].join('\n')).not.toContain('SECRETSECRET')
  expect([...w.files.values()].join('\n')).not.toContain('SECRETSECRET')
})

test('without the hub: the tab hook passes through and the panel command falls back to a pane of its own', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w)
  expect(await calendarCommand($, 'panel')).toBe('Calendar pane opened.')
  expect(w.panes).toEqual(['calendar-sync'])
  // The shared panel's hook does nothing without a hub: it passes the frame through untouched.
  for (const surface of SURFACES) {
    const shared = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await shared.find({ text: 'In a meeting until 12:30' })).toBeUndefined()
    await shared.unmount()
  }
})

test('not configured: a setup hint, no network, no files', async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w)
  expect(w.net.urls).toEqual([])
  expect(await calendarCommand($)).toContain('No calendar yet')
  expect([...w.files.keys()]).toEqual([])
})

test('the calendar is cached for 15 minutes and shared: a second session reads the file instead of fetching', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 2)
  expect(w.net.urls).toHaveLength(1)
  await w.clock.advance(10 * MINUTE)
  expect(w.net.urls).toHaveLength(1)
  await w.clock.advance(6 * MINUTE)
  expect(w.net.urls).toHaveLength(2)
  expect(JSON.parse(w.files.get(`${DIR}/cache.json`) ?? '{}')).toMatchObject({ version: 1, zone: 'Europe/Rome' })
  expect(w.files.get(`${DIR}/cache.json`)).not.toContain('SECRETSECRET')
})

test('errors: a failing server keeps the old copy and says so without the secret address; a page that is not a calendar is refused', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w)
  expect(await calendarCommand($)).toContain('Client call')
  w.net.status = 503
  expect(await calendarCommand($, 'refresh')).toBe('Could not refresh the calendar: the calendar server answered 503')
  expect(await calendarCommand($)).toContain('Client call')
  w.net.status = 200
  w.net.text = '<html>please sign in</html>'
  expect(await calendarCommand($, 'refresh')).toContain('did not return an iCal calendar')
  w.net.text = undefined
  expect(await calendarCommand($, 'refresh')).toBe('Calendar refreshed: 3 entries.')
})

test('a calendar server that never answers is given up on after 30 seconds, without the address in the message', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($)
  w.net.hang = true
  const pending = calendarCommand($, 'refresh')
  await w.clock.advance(31_000)
  expect(await pending).toBe('Could not refresh the calendar: the calendar server did not answer in time')
})

test('errors: with no copy at all the command says what went wrong', { options: OPTIONS }, async ($, on) => {
  const w = world(on, { status: 404 })
  await start($)
  await beats(w)
  expect(await calendarCommand($)).toContain('Could not read the calendar: the calendar server answered 404')
})

test('hub: a meeting makes you away once, tells the hub, shares the status; the end of the meeting releases it', { options: OPTIONS, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 2)
  expect((await calls($, 'registerTab'))).toEqual([{ id: 'calendar', title: 'Calendar', order: 240, command: 'calendar' }])
  expect((await calls($, 'hello'))).toEqual([{ version: '1.0.0', publishes: ['x.calendar-sync.busy'], consumes: [] }])
  expect((await calls($, 'setPresence'))).toEqual([{ presence: 'away', reason: 'timer' }])
  expect((await calls($, 'setMode'))).toEqual([])
  const busy = (await calls($, 'publish')).map(call => call as { topic: string; data: unknown })
  expect(busy).toEqual([{ topic: 'x.calendar-sync.busy', data: { isBusy: true, kind: 'meeting', until: Date.UTC(2026, 9, 7, 10, 30) } }])
  expect(JSON.stringify(busy)).not.toContain('Client call')
  const status = (await calls($, 'share')).find(call => (call as { name: string }).name === 'status') as { value: { kind: string; until: number; free: { start: number; end: number } } }
  expect(status.value.kind).toBe('busy')
  expect(status.value.until).toBe(Date.UTC(2026, 9, 7, 10, 30))
  expect(status.value.free).toEqual({ start: Date.UTC(2026, 9, 7, 10, 30), end: Date.UTC(2026, 9, 7, 13, 0) })
  expect(JSON.parse(w.files.get(`${DIR}/applied.json`) ?? 'null')).toMatchObject({ kind: 'busy', until: Date.UTC(2026, 9, 7, 10, 30) })

  // More beats during the meeting change nothing.
  await beats(w, 5)
  expect((await calls($, 'setPresence'))).toHaveLength(1)

  // At 12:30 the meeting is over: the hold is released, once.
  await w.clock.advance(50 * MINUTE)
  expect((await calls($, 'setPresence'))).toEqual([{ presence: 'away', reason: 'timer' }, { presence: 'auto', reason: 'timer' }])
  expect((await calls($, 'publish')).at(-1)).toEqual({ topic: 'x.calendar-sync.busy', data: { isBusy: false, kind: 'free', until: null } })
  expect(w.files.get(`${DIR}/applied.json`)).toBe('null')
  expect((await prefs($)).presence).toBe('auto')
})

test('hub: time off puts the hub in a Night-like hold and gives the old Night settings back when it ends', { options: OPTIONS, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on, { ics: VACATION })
  await start($)
  await setPrefs($, { isNightOn: false, quietHours: '23:00-06:00' })
  await beats(w, 2)
  expect((await calls($, 'setMode'))).toEqual([{ isNightOn: true, quietHours: '00:00-23:59' }])
  expect((await calls($, 'setPresence'))).toEqual([{ presence: 'away', reason: 'timer' }])
  expect(((await calls($, 'publish')).at(-1) as { data: { kind: string } }).data.kind).toBe('out-of-office')
  expect(JSON.parse(w.files.get(`${DIR}/applied.json`) ?? '{}').restore).toEqual({ isNightOn: false, quietHours: '23:00-06:00' })
  expect(await calendarCommand($)).toContain('Now: Out of office until Sat 10 Oct')
  expect(w.statuses.at(-1)).toBe('📅 Out of office until Sat 10 Oct')

  // The vacation is cancelled in the calendar: the next refresh and beat undo the hold.
  w.net.ics = QUIET
  await calendarCommand($, 'refresh')
  await beats(w, 1)
  expect((await calls($, 'setMode')).at(-1)).toEqual({ isNightOn: false, quietHours: '23:00-06:00' })
  expect((await calls($, 'setPresence')).at(-1)).toEqual({ presence: 'auto', reason: 'timer' })
  expect(await prefs($)).toMatchObject({ isNightOn: false, quietHours: '23:00-06:00', presence: 'auto' })
})

test('hub: a presence you set by hand wins over the calendar', { options: OPTIONS, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($)
  await setPrefs($, { presence: 'here' })
  await beats(w, 4)
  expect((await calls($, 'setPresence'))).toEqual([])
  expect((await calls($, 'publish'))).toEqual([])
})

test('hub: with both switches off the calendar only reads; the hub is never changed', { options: { ...OPTIONS, meetingPresence: false, outOfOffice: false }, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 4)
  expect((await calls($, 'setPresence'))).toEqual([])
  expect((await calls($, 'setMode'))).toEqual([])
  expect(await calendarCommand($)).toContain('11:30–12:30 Client call')
})

test('hub: a session that follows another one fetches nothing more and changes nothing in the hub', { options: OPTIONS, plugins: [hubStandIn()] }, async ($, on) => {
  const events = parseIcs(MEETINGS, 'Europe/Rome').events
  const cache = { version: 1, source: fingerprint(URL), zone: 'Europe/Rome', fetchedAt: NOW, skipped: 0, events }
  const w = world(on, { files: { [`${DIR}/cache.json`]: JSON.stringify(cache), [`${DIR}/lease.json`]: JSON.stringify({ sessionId: 'someone-else', heartbeatAt: NOW, since: NOW - 60_000 }) } })
  await start($)
  await beats(w, 2)
  expect(w.net.urls).toEqual([])
  expect((await calls($, 'setPresence'))).toEqual([])
  expect((await calls($, 'publish'))).toEqual([])
  expect(JSON.parse(w.files.get(`${DIR}/lease.json`) ?? '{}').sessionId).toBe('someone-else')
  // It still shows the shared copy.
  expect(await calendarCommand($)).toContain('11:30–12:30 Client call')
  expect(w.statuses.at(-1)).toBe('📅 In a meeting until 12:30')
})

test('hub: the tab opens through the hub and draws on every surface; another tab is left alone', { options: OPTIONS, plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($)
  await beats(w, 2)
  for (const surface of SURFACES) {
    const other = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await other.find({ text: 'In a meeting until 12:30' })).toBeUndefined()
    await other.unmount()
  }
  expect(await calendarCommand($, 'panel')).toBe('Calendar tab opened.')
  expect((await calls($, 'showTab'))).toEqual([{ id: 'calendar' }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await ui.find({ text: 'In a meeting until 12:30' })).toBeDefined()
    expect(await ui.find({ text: '11:30–12:30 Client call' })).toBeDefined()
    expect(await ui.find({ key: 'calendar-refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('headless sessions (claude -p) answer /calendar from one fetch and start no timers', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await start($, false)
  await w.clock.advance(60 * MINUTE)
  expect(w.net.urls).toHaveLength(1)
  expect(await calendarCommand($)).toContain('Client call')
})

for (const surface of ALL_SURFACES) {
  test(`the pane draws the agenda on ${surface}; Refresh fetches again and the week button shows the days after`, { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    await beats(w)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'calendar-sync', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Calendar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'In a meeting until 12:30' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "You're free 12:30–15:00 today (2h 30m)" })).toBeDefined()
    await ui.press({ key: 'calendar-refresh' })
    expect(w.net.urls).toHaveLength(2)
    await ui.press({ key: 'calendar-span' })
    expect(await ui.find({ type: 'Text', text: 'Mon 12 Oct' })).toBeDefined()
    await ui.unmount()
  })
}

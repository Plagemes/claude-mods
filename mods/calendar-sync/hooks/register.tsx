import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, Timer } from 'claude-code'

import type { ModsPrefs } from '../types/mods-hub'
import { EMPTY_VIEW, agendaText, buildView, durationText, parseMinutes, slotText, statusLine, suggestSlot } from './agenda'
import type { CalSettings } from './agenda'
import { CACHE_VERSION, fingerprint, isFresh, looksLikeIcs, normalizeUrl, parseCache, prune, withoutUrl } from './cache'
import type { CalendarCache } from './cache'
import { expand, parseIcs } from './ics'
import type { Occurrence } from './ics'
import { LEASE_RENEW_MS, leaseAction, parseLease } from './lease'
import type { Lease } from './lease'
import { NIGHT_ALL_DAY, busyEventOf, planPresence } from './presence'
import type { Applied, PresenceKind } from './presence'
import { readSettings } from './settings'
import type { Settings } from './settings'
import { addDays, startOfDay } from './zones'

const NAME = 'calendar-sync'
const TAB = 'calendar'
const PANE = 'calendar-sync'
const TAB_ORDER = 240
const VERSION = '1.0.0'
const FILES_DIR = '.claude/claude-mods/calendar-sync'
const BEAT_MS = LEASE_RENEW_MS
const HORIZON_DAYS = 21
const WEEK_DAYS = 7
const HUB_RETRY_MS = 5 * 60_000
const USAGE = 'Usage: /calendar [today | week | free [2h] | refresh | panel | setup]'
const SETUP_TEXT = [
  'calendar-sync reads one private iCal (ICS) address. Where to find it:',
  '  Google: Calendar settings > your calendar > "Secret address in iCal format"',
  '  Outlook: Settings > Calendar > Shared calendars > Publish a calendar > ICS link',
  '  Apple: Calendar > right-click the calendar > Share Calendar > Public Calendar link (webcal://)',
  'Paste it in /config under calendar-sync > Private iCal (ICS) address. Treat it like a password: anyone with it can read the calendar.',
].join('\n')

const viewAtom = atom({ plugin: 'calendar-sync', key: 'view' } as const, EMPTY_VIEW)
const spanAtom = atom({ plugin: 'calendar-sync', key: 'span' } as const, 2)
const holdAtom = atom({ plugin: 'calendar-sync', key: 'hold' } as const, '')
const leaderAtom = atom({ plugin: 'calendar-sync', key: 'isLeader' } as const, false)

type Runtime = {
  settings: Settings
  dir: string
  me: string
  isInteractive: boolean
  isLeader: boolean
  leaseVerified: boolean
  cache: CalendarCache | undefined
  cacheMtime: number
  occurrences: Occurrence[]
  expandedKey: string
  span: number
  applied: Applied | null
  error: string
  isFetching: boolean
  /** When the hub was last found missing; its calls are not retried for a while. */
  hubMissingAt: number
  shared: string
  statusText: string
  timers: Timer[]
}

const newRuntime = (settings: Settings): Runtime => ({
  settings,
  dir: '',
  me: '',
  isInteractive: false,
  isLeader: false,
  leaseVerified: false,
  cache: undefined,
  cacheMtime: 0,
  occurrences: [],
  expandedKey: '',
  span: 2,
  applied: null,
  error: '',
  isFetching: false,
  hubMissingAt: 0,
  shared: '',
  statusText: '',
  timers: [],
})

const paths = {
  cache: (rt: Runtime): string => `${rt.dir}/cache.json`,
  lease: (rt: Runtime): string => `${rt.dir}/lease.json`,
  applied: (rt: Runtime): string => `${rt.dir}/applied.json`,
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const urlOf = (rt: Runtime): string | undefined => normalizeUrl(rt.settings.icsUrl)

// ── Hub, softly: every call is allowed to fail ─────────────────────────────────────────────────────

async function hubPrefs($: EngineInterface): Promise<ModsPrefs | undefined> {
  try {
    const { value } = await $.state.get({ plugin: 'mods-hub', key: 'prefs' })
    return value
  } catch {
    return undefined
  }
}

async function hubSetPresence($: EngineInterface, presence: 'auto' | 'away'): Promise<boolean> {
  try {
    await $.mods.setPresence({ presence, reason: 'timer' })
    return true
  } catch {
    return false
  }
}

async function hubSetNight($: EngineInterface, input: { isNightOn: boolean; quietHours: string }): Promise<boolean> {
  try {
    await $.mods.setMode(input)
    return true
  } catch {
    return false
  }
}

async function hubShare($: EngineInterface, name: string, value: unknown): Promise<void> {
  try {
    await $.mods.share({ name, value: value as never })
  } catch {
    // no hub: nothing reads the fact
  }
}

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? (JSON.parse(text) as unknown) : undefined
  } catch {
    return undefined
  }
}

async function writeJson($: EngineInterface, path: string, value: unknown): Promise<void> {
  try {
    await $.fs.write(path, JSON.stringify(value))
  } catch (error) {
    $.ui.log(`${NAME}: could not write ${path}: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** The shared copy of the calendar, read again only when its file changed. */
async function loadCache($: EngineInterface, rt: Runtime): Promise<boolean> {
  if (rt.dir === '') return false
  const stat = await $.fs.stat(paths.cache(rt)).catch(() => undefined)
  if (stat === undefined || (stat.mtimeMs === rt.cacheMtime && rt.cache !== undefined)) return false
  const cache = parseCache(await readJson($, paths.cache(rt)))
  if (cache === undefined || cache.source !== fingerprint(rt.settings.icsUrl) || cache.zone !== rt.settings.cal.zone) return false
  rt.cache = cache
  rt.cacheMtime = stat.mtimeMs
  return true
}

// ── Reading the calendar ───────────────────────────────────────────────────────────────────────────

/** The calendar server gets this long to answer. */
const FETCH_TIMEOUT_MS = 30_000

async function fetchWithin($: EngineInterface, url: string): Promise<{ ok: boolean; status: number; text: string }> {
  let timer: Timer | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = $.clock.after(FETCH_TIMEOUT_MS, () => reject(new Error('the calendar server did not answer in time')))
  })
  try {
    return await Promise.race([$.http.fetch(url, { headers: { Accept: 'text/calendar, text/plain, */*' } }), late])
  } finally {
    timer?.cancel()
  }
}

/** Fetches the address, parses it and shares the result through the cache file. Failure keeps the old copy. */
async function refresh($: EngineInterface, rt: Runtime, isForced: boolean): Promise<string> {
  const url = urlOf(rt)
  if (url === undefined) return 'no calendar address set'
  const now = await $.clock.now()
  const source = fingerprint(rt.settings.icsUrl)
  if (!isForced && isFresh(rt.cache, source, rt.settings.cal.zone, now, rt.settings.refreshMs)) return ''
  if (rt.isFetching) return ''
  rt.isFetching = true
  try {
    const response = await fetchWithin($, url)
    if (!response.ok) throw new Error(`the calendar server answered ${response.status}`)
    if (!looksLikeIcs(response.text)) throw new Error('the address did not return an iCal calendar')
    const parsed = parseIcs(response.text, rt.settings.cal.zone)
    const cache: CalendarCache = { version: CACHE_VERSION, source, zone: rt.settings.cal.zone, fetchedAt: now, skipped: parsed.skipped, events: prune(parsed.events, now) }
    rt.cache = cache
    rt.expandedKey = ''
    rt.error = ''
    if (rt.dir !== '') {
      await writeJson($, paths.cache(rt), cache)
      rt.cacheMtime = (await $.fs.stat(paths.cache(rt)).catch(() => undefined))?.mtimeMs ?? 0
    }
    return ''
  } catch (error) {
    rt.error = withoutUrl(messageOf(error), url)
    return rt.error
  } finally {
    rt.isFetching = false
  }
}

/** Expands the cached events into the next weeks of occurrences (again only when the data or the day changed). */
function occurrencesOf(rt: Runtime, now: number): Occurrence[] {
  const cache = rt.cache
  if (cache === undefined) return []
  const from = startOfDay(now, rt.settings.cal.zone)
  const key = `${cache.fetchedAt}:${from}`
  if (key !== rt.expandedKey) {
    rt.occurrences = expand(cache.events, from, addDays(from, HORIZON_DAYS, rt.settings.cal.zone), { myEmail: rt.settings.cal.myEmail })
    rt.expandedKey = key
  }
  return rt.occurrences
}

function viewOf(rt: Runtime, now: number): ReturnType<typeof buildView> {
  const cal: CalSettings = rt.settings.cal
  if (urlOf(rt) === undefined) return { ...EMPTY_VIEW, zone: cal.zone }
  if (rt.cache === undefined) {
    return { ...EMPTY_VIEW, zone: cal.zone, phase: rt.error === '' ? 'loading' : 'error', message: rt.error }
  }
  const message = rt.error === '' ? '' : `showing the copy from ${new Date(rt.cache.fetchedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${rt.error}`
  return buildView(occurrencesOf(rt, now), now, cal, { phase: 'ready', message, fetchedAt: rt.cache.fetchedAt }, rt.span)
}

// ── What the hub is told ───────────────────────────────────────────────────────────────────────────

const holdName = (applied: Applied | null): string => (applied === null ? '' : applied.kind === 'off' ? 'out-of-office' : 'meeting')

async function saveApplied($: EngineInterface, rt: Runtime, applied: Applied | null): Promise<void> {
  rt.applied = applied
  await update($, holdAtom, () => holdName(applied))
  if (rt.dir !== '') await writeJson($, paths.applied(rt), applied)
}

async function hubPublishBusy($: EngineInterface, applied: Applied | null): Promise<void> {
  try {
    await $.mods.publish({ topic: 'x.calendar-sync.busy', data: busyEventOf(applied) })
  } catch {
    // no hub: nobody listens
  }
}

/** Gives the Night settings back, but only while they are still as an out-of-office hold left them. */
async function undoNight($: EngineInterface, applied: Applied, prefs: ModsPrefs | undefined): Promise<void> {
  if (applied.restore !== undefined && prefs?.quietHours === NIGHT_ALL_DAY) await hubSetNight($, applied.restore)
}

/** Undoes what a hold changed in the hub: Night, and presence unless the person set it by hand since. */
async function undoHold($: EngineInterface, applied: Applied): Promise<void> {
  const prefs = await hubPrefs($)
  await undoNight($, applied, prefs)
  if (prefs?.presence === 'away') await hubSetPresence($, 'auto')
}

async function engage($: EngineInterface, rt: Runtime, kind: PresenceKind, until: number, now: number, replaced: Applied | null): Promise<boolean> {
  const prefs = await hubPrefs($)
  if (prefs === undefined) {
    rt.hubMissingAt = now
    return false
  }
  // Someone set presence by hand: that wins over the calendar.
  if (replaced === null && prefs.presence !== 'auto') return false
  let restore = replaced?.restore
  if (kind === 'off') {
    restore ??= prefs.quietHours === NIGHT_ALL_DAY ? { isNightOn: true, quietHours: '22:00-07:00' } : { isNightOn: prefs.isNightOn, quietHours: prefs.quietHours }
    await hubSetNight($, { isNightOn: true, quietHours: NIGHT_ALL_DAY })
  }
  if (!(await hubSetPresence($, 'away'))) {
    // Nothing is recorded as applied, so nothing would ever give Night back: undo it now.
    if (kind === 'off' && restore !== undefined) await hubSetNight($, restore)
    rt.hubMissingAt = now
    return false
  }
  await saveApplied($, rt, { kind, since: replaced?.since ?? now, until, ...(restore === undefined ? {} : { restore }) })
  await hubPublishBusy($, rt.applied)
  return true
}

/** The leader's job each beat: compare the calendar with what is applied and change the hub on a transition only. */
async function syncPresence($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const status = viewOf(rt, now).status
  const options = { meetings: rt.settings.meetings, outOfOffice: rt.settings.outOfOffice }
  const action = planPresence(status, rt.applied, options)
  if (action.type === 'none') return
  if (action.type === 'retime' && rt.applied !== null) {
    await saveApplied($, rt, { ...rt.applied, until: action.until })
    return
  }
  const isHubKnownMissing = rt.hubMissingAt > 0 && now - rt.hubMissingAt < HUB_RETRY_MS
  if (action.type === 'release' && rt.applied !== null) {
    await undoHold($, rt.applied)
    await saveApplied($, rt, null)
    await hubPublishBusy($, rt.applied)
  } else if (action.type === 'engage' && !isHubKnownMissing) {
    await engage($, rt, action.kind, action.until, now, null)
  } else if (action.type === 'switch' && rt.applied !== null) {
    const before = rt.applied
    await undoNight($, before, await hubPrefs($))
    await engage($, rt, action.kind, action.until, now, { kind: before.kind, since: before.since, until: before.until })
  }
}

/** The facts other mods read: `calendar-sync.status` (kind, until, the best free slot today). */
async function shareStatus($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const view = viewOf(rt, now)
  const today = view.days[0]
  const best = today?.slots.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0]
  const value = { kind: view.status.kind, until: view.status.until, nextAt: view.status.nextAt, free: best ?? null, freeLine: view.freeLine }
  const text = JSON.stringify(value)
  if (text === rt.shared) return
  rt.shared = text
  await hubShare($, 'status', value)
}

// ── The beat ───────────────────────────────────────────────────────────────────────────────────────

/** Renews, takes or follows the lease. A taken lease is trusted only once read back on the next beat. */
async function tickLease($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  if (!rt.isInteractive || rt.dir === '') return
  const lease = parseLease(await readJson($, paths.lease(rt)))
  const action = leaseAction(lease, rt.me, now)
  if (action === 'follow') {
    rt.isLeader = false
    rt.leaseVerified = false
  } else {
    const next: Lease = { sessionId: rt.me, heartbeatAt: now, since: action === 'renew' && lease !== null ? lease.since : now }
    await writeJson($, paths.lease(rt), next)
    if (action === 'renew' && rt.isLeader) rt.leaseVerified = true
    else {
      const isTaking = !rt.isLeader
      rt.isLeader = true
      rt.leaseVerified = action === 'renew'
      if (isTaking) rt.applied = parseApplied(await readJson($, paths.applied(rt)))
    }
  }
  await update($, leaderAtom, () => rt.isLeader && rt.leaseVerified)
}

function parseApplied(value: unknown): Applied | null {
  if (typeof value !== 'object' || value === null) return null
  const applied = value as Partial<Applied>
  if ((applied.kind !== 'busy' && applied.kind !== 'off') || typeof applied.since !== 'number' || typeof applied.until !== 'number') return null
  const restore = applied.restore
  const isRestore = typeof restore === 'object' && restore !== null && typeof restore.isNightOn === 'boolean' && typeof restore.quietHours === 'string'
  return { kind: applied.kind, since: applied.since, until: applied.until, ...(isRestore ? { restore } : {}) }
}

/** Every 10 seconds: the lease, the calendar (leader), the status line, the hub (leader), the drawing. */
async function beat($: EngineInterface, rt: Runtime): Promise<void> {
  const now = await $.clock.now()
  await tickLease($, rt, now)
  const isLeading = rt.isLeader && rt.leaseVerified
  if (isLeading) await refresh($, rt, false)
  else await loadCache($, rt)
  await show($, rt, now)
  if (isLeading) {
    await syncPresence($, rt, now)
    await shareStatus($, rt, now)
  }
}

/** Redraws from the current data: the atom the tab and the pane read, and the status line. */
async function show($: EngineInterface, rt: Runtime, now: number): Promise<void> {
  const view = viewOf(rt, now)
  await update($, viewAtom, previous => (JSON.stringify(previous) === JSON.stringify(view) ? previous : view))
  const line = rt.settings.isStatusLine && view.phase === 'ready' ? statusLine(view.status, now, rt.settings.cal.zone) : ''
  if (line !== rt.statusText) {
    rt.statusText = line
    $.ui.status(line === '' ? undefined : `📅 ${line}`)
  }
}

async function startUp($: EngineInterface, rt: Runtime, isInteractive: boolean): Promise<void> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  rt.dir = home === '' ? '' : `${home.replace(/[\\/]+$/, '')}/${FILES_DIR}`
  rt.me = await $.session.id().catch(() => '')
  rt.isInteractive = isInteractive
  await hubHello($, { version: VERSION, publishes: ['x.calendar-sync.busy'], consumes: [] }, { id: TAB, title: 'Calendar', order: TAB_ORDER, command: 'calendar' })
  if (urlOf(rt) === undefined) {
    await show($, rt, await $.clock.now())
    return
  }
  await loadCache($, rt)
  // The first read does not wait for the lease: a session with no copy yet fetches one itself.
  if (rt.cache === undefined) await refresh($, rt, false)
  await beat($, rt)
  if (isInteractive) {
    rt.timers.push($.clock.every(BEAT_MS, () => void beat($, rt).catch(error => $.ui.log(`${NAME}: ${messageOf(error)}`, { to: 'debug' }))))
  }
}

// ── The command ────────────────────────────────────────────────────────────────────────────────────

async function ensureData($: EngineInterface, rt: Runtime): Promise<string> {
  if (urlOf(rt) === undefined) return ''
  await loadCache($, rt)
  return rt.cache === undefined ? refresh($, rt, false) : ''
}

async function openPanel($: EngineInterface): Promise<string> {
  if (await hubShowTab($, TAB)) return 'Calendar tab opened.'
  const opened = await $.ui.open({ id: PANE, title: 'Calendar' })
  return opened.isPlaced ? 'Calendar pane opened.' : 'The terminal is too narrow for a pane: use /calendar for the text agenda.'
}

async function runCalendar($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const command = word.toLowerCase()
  const now = await $.clock.now()
  if (command === 'setup' || command === 'help') return `${SETUP_TEXT}\n${USAGE}`
  if (command === 'panel' || command === 'open' || command === 'tab') return openPanel($)
  if (urlOf(rt) === undefined) return agendaText(EMPTY_VIEW)
  if (command === 'refresh') {
    const problem = await refresh($, rt, true)
    await show($, rt, await $.clock.now())
    return problem === '' ? `Calendar refreshed: ${rt.cache?.events.length ?? 0} entries.` : `Could not refresh the calendar: ${problem}`
  }
  const problem = await ensureData($, rt)
  if (rt.cache === undefined) return `Could not read the calendar: ${problem === '' ? 'nothing yet' : problem}`
  if (command === 'free') {
    const minutes = parseMinutes(rest.join(' ')) ?? 120
    const found = suggestSlot(occurrencesOf(rt, now), now, minutes, rt.settings.cal)
    return found === undefined ? `No free slot of ${durationText(minutes * 60_000)} in the next week.` : found.text
  }
  if (command !== '' && command !== 'today' && command !== 'week') return USAGE
  const days = command === 'week' ? WEEK_DAYS : 2
  const view = buildView(occurrencesOf(rt, now), now, rt.settings.cal, { phase: 'ready', message: '', fetchedAt: rt.cache.fetchedAt }, days)
  const line = statusLine(view.status, now, rt.settings.cal.zone)
  return [agendaText(view), line === '' ? '' : `Now: ${line}`, view.freeLine].filter(part => part !== '').join('\n')
}

// ── The tab and the pane ───────────────────────────────────────────────────────────────────────────

async function setSpan($: EngineInterface, rt: Runtime, span: number): Promise<void> {
  rt.span = span
  await update($, spanAtom, () => span)
  await show($, rt, await $.clock.now())
}

async function refreshNow($: EngineInterface, rt: Runtime): Promise<void> {
  await refresh($, rt, true)
  await show($, rt, await $.clock.now())
}

const KIND_COLOR = { busy: 'warning', off: 'suggestion', free: 'success' } as const

async function drawCalendar($: EngineInterface, e: RenderInput<'Pane'>, rt: Runtime): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [view, span, hold, isLeader, now] = await Promise.all([read($, viewAtom), read($, spanAtom), read($, holdAtom), read($, leaderAtom), $.clock.now()])
  const zone = view.zone
  const line = view.phase === 'ready' ? statusLine(view.status, now, zone) : ''
  const kindColor = KIND_COLOR[view.status.kind]
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1}>
        <Text bold color="claude">📅 Calendar</Text>
        <Text dimColor>{zone}{isLeader ? ' · leader' : ''}</Text>
      </Box>
      {view.phase === 'unconfigured' ? <Text wrap="wrap">{agendaText(view)}</Text> : null}
      {view.phase === 'loading' ? <Text color="suggestion">⟳ Reading the calendar…</Text> : null}
      {view.phase === 'error' ? <Text color="error" wrap="wrap">✗ {view.message}</Text> : null}
      {view.phase === 'ready' ? (
        <Box flexDirection="column">
          <Text color={kindColor} wrap="wrap">{line === '' ? '○ Free' : `${view.status.kind === 'free' ? '○' : '●'} ${line}`}{hold === '' ? '' : ` · hub: ${hold} hold`}</Text>
          {view.freeLine === '' ? null : <Text color="success" wrap="wrap">{view.freeLine}</Text>}
          {view.message === '' ? null : <Text color="warning" wrap="wrap">{view.message}</Text>}
          {view.days.map((day, index) => (
            <Box key={`day-${day.date}`} flexDirection="column" marginTop={1}>
              <Text bold>{index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : day.label}{index < 2 ? ` · ${day.label}` : ''}</Text>
              {day.rows.length === 0 ? <Text dimColor>  nothing scheduled</Text> : null}
              {day.rows.map((row, at) => (
                <Text key={`row-${day.date}-${at}`} dimColor={row.isPast} wrap="truncate-end">
                  <Text color={KIND_COLOR[row.kind]}>{row.isNow ? '▶' : ' '} {row.kind === 'off' ? '✈' : row.kind === 'busy' ? '●' : '○'} </Text>
                  {row.time.padEnd(11)} {row.title}{row.location === '' ? '' : ` · ${row.location}`}
                </Text>
              ))}
              {day.slots.length === 0 ? null : <Text color="success" wrap="wrap">  free: {day.slots.map(slot => slotText(slot, zone)).join(', ')}</Text>}
            </Box>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        <Button key="calendar-refresh" label="Refresh" variant="primary" onPress={() => refreshNow($, rt)} />
        <Button key="calendar-span" label={span > 2 ? 'Today + tomorrow' : 'Whole week'} onPress={() => setSpan($, rt, span > 2 ? 2 : WEEK_DAYS)} />
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readSettings(options))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'calendar', description: 'Your agenda today, free slots and a suggestion for long jobs (private iCal link)', argumentHint: '[today | week | free [2h] | refresh | panel | setup]' })
    } catch (error) {
      $.ui.log(`${NAME}: could not register /calendar: ${messageOf(error)}`, { to: 'debug' })
    }
    try {
      await startUp($, rt, e.isInteractive)
    } catch (error) {
      $.ui.log(`${NAME}: start-up failed: ${messageOf(error)}`, { to: 'debug' })
    }
    return started
  })

  on('command.run', { command: 'calendar' }, async ($, e) => {
    try {
      return { text: await runCalendar($, rt, e.args) }
    } catch (error) {
      return { text: `The /calendar command failed: ${messageOf(error)}` }
    }
  })

  // The shared panel: the Calendar tab's body, drawn here when the hub shows our tab.
  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawCalendar($, e, rt)}
      </Box>
    )
  })

  // Without the hub: the same drawing in a pane of its own.
  on('ui.render', { component: 'Pane', requestId: 'calendar-sync' }, async ($, e) => drawCalendar($, e, rt))
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts

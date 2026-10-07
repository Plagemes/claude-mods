import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatMinutes, muteVerdict, parseQuietArgs } from '../hooks/args'
import type { QuietState } from '../types'
import { fakeHub } from './hub'

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const OFF: QuietState = { isOn: false, until: null }

/** The engine under the plugin: a clock, the session's state store, and what reached the toast and status lines. */
const world = (on: On) => {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const stored = new Map<string, { value: unknown; version: number }>()
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('state.get', (_$, e) => ({ value: stored.get(`${e.plugin}.${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const key = `${e.plugin}.${e.key}`
    const held = stored.get(key)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== held) return { value: { isSet: false, version: held } }
    stored.set(key, { value: e.value, version: held + 1 })
    return { value: { isSet: true, version: held + 1 } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts, statuses, stored }
}

const quiet = ($: Engine, args = '') =>
  $.command.run({ command: 'quiet', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('/quiet switches quiet mode on, keeps it in the session state and shows it in the status line', async ($, on) => {
  const { statuses, stored } = world(on)

  const shown = await quiet($)

  expect(shown.text).toBe('Quiet mode is on until you run /quiet again: toasts and sounds from your other mods are muted.')
  expect(statuses).toEqual(['🔕 quiet'])
  expect(stored.get('quiet-mode.quiet')?.value).toEqual({ isOn: true, until: null })
  expect((await quiet($, 'status')).text).toBe('Quiet mode is on until you switch it off.')
})

test('/quiet again, or /quiet off, switches it off and clears the status', async ($, on) => {
  const { statuses, stored } = world(on)

  await quiet($)
  expect((await quiet($)).text).toBe('Quiet mode is off: toasts and sounds from your mods are back.')
  expect(statuses).toEqual(['🔕 quiet', undefined])
  expect(stored.get('quiet-mode.quiet')?.value).toEqual({ isOn: false, until: null })

  expect((await quiet($, 'off')).text).toBe('Quiet mode was already off.')
  expect((await quiet($, 'status')).text).toBe('Quiet mode is off.')
})

test('/quiet 25 counts down in the status line and switches itself off with a toast of its own', async ($, on) => {
  const { toasts, statuses, stored, clock } = world(on)

  expect((await quiet($, '25')).text).toBe('Quiet mode is on for 25m: toasts and sounds from your other mods are muted.')
  expect(statuses).toEqual(['🔕 quiet 25m'])
  expect(stored.get('quiet-mode.quiet')?.value).toEqual({ isOn: true, until: NOW + 25 * 60_000 })

  await clock.advance(10 * 60_000)
  expect(statuses.at(-1)).toBe('🔕 quiet 15m')
  expect((await quiet($, 'status')).text).toBe('Quiet mode is on, 15m left.')
  expect(toasts).toEqual([])

  await clock.advance(15 * 60_000)
  expect(statuses.at(-1)).toBeUndefined()
  expect(toasts).toEqual(['quiet mode is over; toasts and sounds are back'])
  expect(stored.get('quiet-mode.quiet')?.value).toEqual({ isOn: false, until: null })
  expect((await quiet($, 'status')).text).toBe('Quiet mode is off.')
})

test('switching off by hand stops the countdown: no stray toast or status afterwards', async ($, on) => {
  const { toasts, statuses, clock } = world(on)

  await quiet($, '5')
  await quiet($, 'off')
  const before = statuses.length
  await clock.advance(10 * 60_000)

  expect(toasts).toEqual([])
  expect(statuses).toHaveLength(before)
})

test('a new /quiet N restarts the period; hours and minutes are understood; bad arguments get the usage', async ($, on) => {
  const { statuses } = world(on)

  expect((await quiet($, '1h')).text).toContain('for 1h:')
  expect((await quiet($, '90 minutes')).text).toContain('for 1h 30m:')
  expect(statuses).toEqual(['🔕 quiet 1h', '🔕 quiet 1h 30m'])
  expect((await quiet($, 'soon')).text).toContain('Usage: /quiet [minutes | 25m | 1h | on | off | status]')
})

test('muteVerdict silences other mods only: not itself, the engine, bundled or managed plugins, and not when off or expired', () => {
  const running: QuietState = { isOn: true, until: null }
  const verdict = (plugin: string, tier: string, state: QuietState = running, now = NOW) => muteVerdict({ plugin, tier }, 'quiet-mode', state, now)

  expect(verdict('done-chime', 'user')).toBe('mute')
  expect(verdict('quiet-mode', 'user')).toBe('pass')
  expect(verdict('engine', 'core')).toBe('pass')
  expect(verdict('bundled', 'builtin')).toBe('pass')
  expect(verdict('policy', 'prepend')).toBe('pass')
  expect(verdict('policy', 'append')).toBe('pass')
  expect(verdict('done-chime', 'user', { isOn: false, until: null })).toBe('pass')
  expect(verdict('done-chime', 'user', { isOn: true, until: NOW + 1000 })).toBe('mute')
  expect(verdict('done-chime', 'user', { isOn: true, until: NOW })).toBe('expired')
})

test('parseQuietArgs reads minutes, hours and the words; formatMinutes rounds up', () => {
  expect([parseQuietArgs(''), parseQuietArgs('25'), parseQuietArgs('25m'), parseQuietArgs('1.5h'), parseQuietArgs('0.2'), parseQuietArgs('99h'), parseQuietArgs('off'), parseQuietArgs('on'), parseQuietArgs('status')]).toEqual([
    { kind: 'toggle' },
    { kind: 'on', minutes: 25 },
    { kind: 'on', minutes: 25 },
    { kind: 'on', minutes: 90 },
    { kind: 'on', minutes: 1 },
    { kind: 'on', minutes: 1440 },
    { kind: 'off' },
    { kind: 'on', minutes: null },
    { kind: 'status' },
  ])
  expect([formatMinutes(1), formatMinutes(61_000), formatMinutes(25 * 60_000), formatMinutes(60 * 60_000), formatMinutes(125 * 60_000)]).toEqual(['1m', '2m', '25m', '1h', '2h 5m'])
})

test('with mods-hub: /quiet sets the hub\'s Silent for every session and the status line follows it', async ($, on) => {
  const { statuses, stored, toasts, clock } = world(on)
  const hub = fakeHub(on, {}, clock)

  expect((await quiet($, '25')).text).toBe(
    "Quiet mode is on for 25m, in every session (mods-hub's Silent): toasts and sounds from your mods wait in the Claude Mods panel.",
  )
  expect(hub.modes).toEqual([{ silentMinutes: 25 }])
  expect(statuses).toEqual(['🔕 quiet 25m'])
  // Its own switch stays off: the hub holds other mods' toasts and sounds.
  expect(stored.get('quiet-mode.quiet')?.value ?? OFF).toEqual(OFF)

  await clock.advance(10 * 60_000)
  expect(statuses.at(-1)).toBe('🔕 quiet 15m')
  expect((await quiet($, 'status')).text).toBe("Quiet mode (mods-hub's Silent) is on, 15m left.")

  expect((await quiet($)).text).toBe('Quiet mode is off in every session: toasts and sounds from your mods are back.')
  expect(hub.modes.at(-1)).toEqual({ silentMinutes: null })
  expect(statuses.at(-1)).toBeUndefined()
  expect(toasts).toEqual([])
})

test('with mods-hub: /quiet on asks for a Silent with no end, and a Silent the hub ends clears the status line', async ($, on) => {
  const { statuses, clock } = world(on)
  const hub = fakeHub(on, {}, clock)

  expect((await quiet($, 'on')).text).toContain('until you run /quiet again, in every session')
  expect(hub.modes).toEqual([{ isSilent: true }])
  expect(statuses).toEqual(['🔕 quiet'])

  hub.mode = { ...hub.mode, isSilent: false, silentUntil: null }
  await clock.advance(30_000)
  expect(statuses.at(-1)).toBeUndefined()
})

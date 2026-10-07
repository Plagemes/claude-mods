import { describe, expect, test } from 'claude-code/testing'

import type { ModsChannel, ModsMode } from '../types'
import { problemWith, topicMatches } from '../hooks/catalog'
import { DEFAULT_PREFS, deriveMode, isQuietAt, parseHubArgs, presenceOf, route, sanitizePrefs } from '../hooks/router'

const NOON = 12 * 60
const phone: ModsChannel = { id: 'phone', title: 'WhatsApp', owner: 'whatsapp-bridge', audience: 'me', delivery: 'push', status: 'connected' }
const slack: ModsChannel = { id: 'slack', title: 'Slack', owner: 'slack-bridge', audience: 'team', delivery: 'push', status: 'connected' }
const modeWith = (change: Partial<ModsMode>): ModsMode => ({ ...deriveMode(DEFAULT_PREFS, 'here', 0, NOON), ...change })

describe('route', () => {
  test('while you are here, success stays in the terminal; while away it reaches your channels', () => {
    expect(route({ level: 'success' }, modeWith({}), DEFAULT_PREFS, [phone, slack])).toEqual({ toast: true, channels: [], held: false })
    expect(route({ level: 'success' }, modeWith({ presence: 'away' }), DEFAULT_PREFS, [phone, slack])).toEqual({ toast: true, channels: ['phone'], held: false })
    expect(route({ level: 'critical' }, modeWith({}), DEFAULT_PREFS, [phone]).channels).toEqual(['phone'])
  })

  test('silent keeps it off the screen, night holds it for the digest, critical always goes', () => {
    expect(route({ level: 'warning' }, modeWith({ isSilent: true }), DEFAULT_PREFS, [phone])).toEqual({ toast: false, channels: [], held: false, reason: 'silent' })
    expect(route({ level: 'error' }, modeWith({ presence: 'away', isNight: true }), DEFAULT_PREFS, [phone])).toEqual({ toast: true, channels: [], held: true, reason: 'night' })
    expect(route({ level: 'critical' }, modeWith({ presence: 'away', isNight: true, isSilent: true }), DEFAULT_PREFS, [phone])).toEqual({ toast: true, channels: ['phone'], held: false })
  })

  test('a question needs Interaction; team notices go to team channels; off and per-channel switches hold', () => {
    const away = modeWith({ presence: 'away', interaction: 'off', canAsk: false })
    expect(route({ level: 'warning', kind: 'question' }, away, DEFAULT_PREFS, [phone]).channels).toEqual([])
    expect(route({ level: 'success', audience: 'team' }, modeWith({}), DEFAULT_PREFS, [phone, slack]).channels).toEqual(['slack'])
    expect(route({ level: 'info' }, modeWith({}), { ...DEFAULT_PREFS, routes: { ...DEFAULT_PREFS.routes, info: 'off' } }, [phone]).toast).toBe(false)
    const muted = { ...DEFAULT_PREFS, channels: { phone: { isEnabled: true, minLevel: 'error' as const } } }
    expect(route({ level: 'warning' }, modeWith({ presence: 'away' }), muted, [phone]).channels).toEqual([])
    expect(route({ level: 'error' }, modeWith({ presence: 'away' }), muted, [phone]).channels).toEqual(['phone'])
  })
})

describe('mode', () => {
  test('quiet hours may cross midnight', () => {
    expect(isQuietAt('22:00-07:00', 23 * 60)).toBe(true)
    expect(isQuietAt('22:00-07:00', 6 * 60 + 59)).toBe(true)
    expect(isQuietAt('22:00-07:00', NOON)).toBe(false)
    expect(isQuietAt('13:00-14:00', 13 * 60 + 30)).toBe(true)
  })

  test('presence follows activity unless set by hand; canAsk follows Interaction', () => {
    const clock = { lastActivityAt: 0, now: 11 * 60_000, idleMs: 10 * 60_000, awayMs: 30 * 60_000 }
    expect(presenceOf('auto', clock)).toBe('idle')
    expect(presenceOf('auto', { ...clock, now: 31 * 60_000 })).toBe('away')
    expect(presenceOf('away', { ...clock, now: 1 })).toBe('away')
    expect(deriveMode(DEFAULT_PREFS, 'away', 0, NOON).canAsk).toBe(true)
    expect(deriveMode(DEFAULT_PREFS, 'here', 0, NOON).canAsk).toBe(false)
    expect(deriveMode({ ...DEFAULT_PREFS, interaction: 'on' }, 'here', 0, 23 * 60).canAsk).toBe(false)
    expect(deriveMode({ ...DEFAULT_PREFS, isSilent: true, silentUntil: 100 }, 'here', 200, NOON).isSilent).toBe(false)
  })

  test('prefs from disk are made whole', () => {
    const prefs = sanitizePrefs({ interaction: 'loud', routes: { info: 'always', error: 'nowhere' }, quietHours: '25:00-07:00', channels: { phone: { isEnabled: false } } })
    expect(prefs.interaction).toBe('auto')
    expect(prefs.routes).toEqual({ ...DEFAULT_PREFS.routes, info: 'always' })
    expect(prefs.quietHours).toBe('22:00-07:00')
    expect(prefs.channels).toEqual({ phone: { isEnabled: false, minLevel: 'info' } })
  })
})

describe('catalog and /hub', () => {
  test('standard payloads are checked; custom topics are x.<mod>.<name>', () => {
    expect(problemWith('test.result', { runner: 'vitest', outcome: 'passed', passed: 3, failed: null })).toBeUndefined()
    expect(problemWith('test.result', { runner: 'vitest', outcome: 'green', passed: 3, failed: 0 })).toContain('test.result.outcome')
    expect(problemWith('deploy.done', {})).toContain('x.<mod>.<name>')
    expect(problemWith('x.smart-router.plan', { steps: 3 })).toBeUndefined()
    expect(topicMatches('deploy.failed', 'deploy.')).toBe(true)
    expect(topicMatches('deploy.failed', 'deploy')).toBe(false)
  })

  test('/hub arguments', () => {
    expect(parseHubArgs('')).toEqual({ kind: 'open' })
    expect(parseHubArgs('silent 25')).toEqual({ kind: 'silent', minutes: 25 })
    expect(parseHubArgs('silent off')).toEqual({ kind: 'loud' })
    expect(parseHubArgs('night 23:00-06:30')).toEqual({ kind: 'night', isOn: true, quietHours: '23:00-06:30' })
    expect(parseHubArgs('route error always')).toEqual({ kind: 'route', level: 'error', value: 'always' })
    expect(parseHubArgs('route error loud').kind).toBe('error')
  })
})

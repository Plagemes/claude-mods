import { expect, test } from 'claude-code/testing'

import { argv, claudeBinary, parseInstalled, parseMarketplaceNames, parseOutcome } from '../hooks/cli'
import { detectDrift, driftEvent, driftSignature, driftSummary, modStates } from '../hooks/drift'
import type { Personal } from '../hooks/drift'
import { summaryText } from '../hooks/report'
import { EMPTY_TEAM } from '../hooks/team'
import type { TeamConfig, TeamView } from '../types'

const TEAM: TeamConfig = {
  ...EMPTY_TEAM,
  name: 'Acme',
  recommendedMods: ['secret-shield', 'guardian', 'token-budget'],
  guardLevel: 'strict',
  budget: { sessionUsd: 5, sessionTokens: 200_000, dailyUsd: 20 },
  notifications: { critical: 'always', error: 'away' },
  owners: ['alice@acme.com'],
}

const personal = (extra: Partial<Personal> & { rows?: Record<string, string | number | boolean> } = {}): Personal => ({
  config: new Map(Object.entries(extra.rows ?? {})),
  routes: extra.routes,
  guardLevel: extra.guardLevel,
  isGuardianInstalled: extra.isGuardianInstalled ?? true,
})

test('budget drift: a personal limit above the team\'s, or none at all, is a difference that can be aligned', () => {
  const drift = detectDrift(TEAM, personal({ rows: { 'token-budget.budgetUsd': 10, 'token-budget.budgetTokens': 0, 'daily-spend.dailyLimit': 20 } }))
  expect(drift).toEqual([
    { id: 'budget.sessionUsd', title: 'Session dollar budget', team: '$5', personal: '$10', fix: { key: 'token-budget.budgetUsd', value: 5 } },
    { id: 'budget.sessionTokens', title: 'Session token budget', team: '200,000', personal: 'no limit', fix: { key: 'token-budget.budgetTokens', value: 200_000 } },
  ])
  // At or under the team's limit is fine; a mod that is not installed has no row to compare; the team's own 0 means no rule.
  expect(detectDrift(TEAM, personal({ rows: { 'token-budget.budgetUsd': 3, 'token-budget.budgetTokens': 150_000 }, routes: { error: 'always', critical: 'always' }, guardLevel: 'strict' }))).toEqual([])
  expect(detectDrift(TEAM, personal({ guardLevel: 'strict' }))).toEqual([])
  expect(detectDrift({ ...TEAM, budget: { sessionUsd: 0 }, guardLevel: 'off' }, personal({ rows: { 'token-budget.budgetUsd': 50 } }))).toEqual([])
})

test('notification drift: a route weaker than the team asks for, with the command that fixes it; nothing without a hub', () => {
  const drift = detectDrift(TEAM, personal({ routes: { info: 'terminal', success: 'away', warning: 'away', error: 'terminal', critical: 'always' }, guardLevel: 'strict' }))
  expect(drift).toEqual([{ id: 'route.error', title: 'Notifications: error', team: 'away', personal: 'terminal', hint: '/hub route error away' }])
  expect(detectDrift(TEAM, personal({ routes: { error: 'always', critical: 'always' }, guardLevel: 'strict' }))).toEqual([])
  expect(detectDrift(TEAM, personal({ routes: undefined, guardLevel: 'strict' }))).toEqual([])
})

test('guard drift: a weaker level than required; unknown level with guardian installed is not a difference, without it it is', () => {
  expect(detectDrift(TEAM, personal({ guardLevel: 'standard' }))).toEqual([{ id: 'guard', title: 'Guard level', team: 'strict', personal: 'standard', hint: 'Raise the level in guardian.' }])
  expect(detectDrift(TEAM, personal({ guardLevel: 'off' }))[0]?.personal).toBe('off')
  expect(detectDrift({ ...TEAM, guardLevel: 'standard' }, personal({ guardLevel: 'strict' }))).toEqual([])
  expect(detectDrift(TEAM, personal({ guardLevel: undefined, isGuardianInstalled: true }))).toEqual([])
  expect(detectDrift(TEAM, personal({ guardLevel: undefined, isGuardianInstalled: false }))).toEqual([{ id: 'guard', title: 'Guard level', team: 'strict', personal: 'guardian is not installed', hint: '/team install guardian' }])
  expect(detectDrift({ ...TEAM, guardLevel: 'off' }, personal({ guardLevel: 'off', isGuardianInstalled: false }))).toEqual([])
})

test('recommended mods: installed, switched off, or missing', () => {
  const installed = new Map([
    ['secret-shield', { version: '1.0.0', isEnabled: true }],
    ['guardian', { version: '2.0.0', isEnabled: false }],
  ])
  expect(modStates(TEAM, installed)).toEqual([
    { name: 'secret-shield', state: 'installed', version: '1.0.0' },
    { name: 'guardian', state: 'disabled', version: '2.0.0' },
    { name: 'token-budget', state: 'missing', version: '' },
  ])
  expect(modStates(TEAM, undefined).every(mod => mod.state === 'missing')).toBe(true)
})

test('the drift event: counts settings and missing mods, has a signature that changes with the drift, and a one-line summary', () => {
  const drift = detectDrift(TEAM, personal({ rows: { 'token-budget.budgetUsd': 10 }, guardLevel: 'strict' }))
  const mods = modStates(TEAM, new Map([['secret-shield', { version: '1', isEnabled: true }]]))
  const event = driftEvent(drift, mods, true)
  expect(event).toEqual({ count: 3, items: [{ id: 'budget.sessionUsd', title: 'Session dollar budget', team: '$5', personal: '$10' }], missingMods: ['guardian', 'token-budget'], disabledMods: [] })
  expect(driftSummary(event)).toBe("1 setting differs from the team's rules; 2 recommended mods are missing.")
  expect(driftSummary(driftEvent([], [], true))).toBe('In line with the team rules.')
  // When the installed list could not be read nothing is claimed missing.
  expect(driftEvent([], mods, false)).toEqual({ count: 0, items: [], missingMods: [], disabledMods: [] })
  const same = driftSignature(driftEvent(drift, mods, true))
  expect(driftSignature(driftEvent(drift, mods, true))).toBe(same)
  expect(driftSignature(driftEvent(detectDrift(TEAM, personal({ rows: { 'token-budget.budgetUsd': 7 }, guardLevel: 'strict' })), mods, true))).not.toBe(same)
})

test('the CLI: argument vectors, installed plugins by name, marketplaces and the outcome line', () => {
  expect(claudeBinary('/opt/claude-code/bin/claude')).toBe('/opt/claude-code/bin/claude')
  expect(claudeBinary('/usr/bin/node')).toBe('claude')
  expect(claudeBinary(undefined)).toBe('claude')
  expect(argv.list('claude')).toEqual(['claude', 'plugin', 'list', '--json'])
  expect(argv.install('claude', 'guardian', 'claude-mods')).toEqual(['claude', 'plugin', 'install', 'guardian@claude-mods', '--scope', 'user', '--json'])
  expect(argv.addMarketplace('claude', 'plagemes/claude-mods')).toEqual(['claude', 'plugin', 'marketplace', 'add', 'plagemes/claude-mods', '--json'])
  const list = JSON.stringify([
    { id: 'secret-shield@claude-mods', version: '1.0.0', scope: 'user', enabled: true },
    { id: 'guardian@other', version: '2.0.0', scope: 'project', enabled: false },
    { id: 'secret-shield@other', version: '9', scope: 'user', enabled: true },
  ])
  const installed = parseInstalled(list)
  expect([...installed.keys()]).toEqual(['secret-shield', 'guardian'])
  expect(installed.get('guardian')).toEqual({ version: '2.0.0', scope: 'project', isEnabled: false, marketplace: 'other' })
  expect(installed.get('secret-shield')?.version).toBe('1.0.0')
  expect(() => parseInstalled('{}')).toThrow('printed no list')
  expect(parseMarketplaceNames(JSON.stringify([{ name: 'claude-mods' }, { name: 'x' }, {}]))).toEqual(['claude-mods', 'x'])
  expect(parseOutcome({ exitCode: 0, stdout: '{"outcome":"ok","message":"Installed"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })).toEqual({ isOk: true, message: 'Installed' })
  expect(parseOutcome({ exitCode: 1, stdout: '{"outcome":"error","failureCode":"not_found","message":"No such plugin"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })).toMatchObject({ isOk: false, failureCode: 'not_found' })
})

test('the text summary: conventions, mods with their state, differences with hints, defaults, owners', () => {
  const view: TeamView = {
    phase: 'ready',
    path: '.claude/team.json',
    problems: ['color: not used by team-hub (kept as it is).'],
    team: { ...TEAM, conventions: 'Write small commits.\nRun the tests.' },
    mods: [
      { name: 'secret-shield', state: 'installed', version: '1.0.0' },
      { name: 'guardian', state: 'missing', version: '' },
    ],
    isInstalledKnown: true,
    drift: [
      { id: 'budget.sessionUsd', title: 'Session dollar budget', team: '$5', personal: '$10', fix: { key: 'token-budget.budgetUsd', value: 5 } },
      { id: 'route.error', title: 'Notifications: error', team: 'away', personal: 'terminal', hint: '/hub route error away' },
    ],
    isMaintainer: false,
    who: 'eve@evil.com',
    busy: '',
    notice: null,
    isEditing: false,
    draft: null,
  }
  const text = summaryText(view)
  expect(text).toContain('Acme · .claude/team.json · read-only for you (not an owner)')
  expect(text).toContain('Conventions (2):\n  - Write small commits.\n  - Run the tests.')
  expect(text).toContain('✓ secret-shield 1.0.0')
  expect(text).toContain('✗ guardian')
  expect(text).toContain('Install them with /team install (guardian).')
  expect(text).toContain('⚠ Session dollar budget: yours $10, team $5 (/team align fixes it)')
  expect(text).toContain('⚠ Notifications: error: yours terminal, team away (/hub route error away)')
  expect(text).toContain('Team defaults: guard strict · sessionUsd 5 · sessionTokens 200000 · dailyUsd 20 · critical → always · error → away')
  expect(text).toContain('Owners: alice@acme.com')
  expect(text).toContain('Ignored in the file: color')
  expect(summaryText({ ...view, phase: 'absent', team: null })).toContain('No .claude/team.json in this repository. /team init creates one.')
  expect(summaryText({ ...view, phase: 'invalid', team: null, problems: ['team.json is not valid JSON: x'] })).toContain('cannot be used: team.json is not valid JSON')
  expect(summaryText({ ...view, isInstalledKnown: false })).toContain('? secret-shield')
})

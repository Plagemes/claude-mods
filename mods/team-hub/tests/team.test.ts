import { expect, test } from 'claude-code/testing'

import { applyOp, conventionLines, conventionsSection, EMPTY_TEAM, isMaintainer, MAX_CONVENTIONS, MAX_SECTION, parseTeam, serializeTeam, starterTeam } from '../hooks/team'
import type { TeamConfig } from '../types'

const FULL = {
  version: 1,
  name: 'Acme Web Team',
  conventions: ['Write small commits.', 'Run the tests before a pull request.'],
  recommendedMods: ['secret-shield', 'guardian', 'token-budget'],
  guard: { level: 'strict' },
  budget: { sessionUsd: 5, sessionTokens: 0, dailyUsd: 20 },
  notifications: { critical: 'always', error: 'away' },
  owners: ['alice@acme.com', 'Bob'],
}

const team = (text: unknown): TeamConfig => {
  const parsed = parseTeam(typeof text === 'string' ? text : JSON.stringify(text))
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.team
}

test('schema: a complete team file is read as written, with no warnings', () => {
  const parsed = parseTeam(JSON.stringify(FULL))
  expect('error' in parsed).toBe(false)
  if ('error' in parsed) return
  expect(parsed.warnings).toEqual([])
  expect(parsed.team).toEqual({
    version: 1,
    name: 'Acme Web Team',
    conventions: 'Write small commits.\nRun the tests before a pull request.',
    recommendedMods: ['secret-shield', 'guardian', 'token-budget'],
    marketplace: 'plagemes/claude-mods',
    marketplaceName: 'claude-mods',
    guardLevel: 'strict',
    budget: { sessionUsd: 5, sessionTokens: 0, dailyUsd: 20 },
    notifications: { critical: 'always', error: 'away' },
    owners: ['alice@acme.com', 'Bob'],
    extra: {},
  })
})

test('schema: an empty object is a valid team; text conventions and a plain guard string are accepted', () => {
  expect(team({})).toEqual(EMPTY_TEAM)
  expect(team({ conventions: 'One line', guard: 'standard' })).toMatchObject({ conventions: 'One line', guardLevel: 'standard' })
})

test('schema: unreadable files are an error; anything wrong inside a readable one is dropped and listed', () => {
  expect(parseTeam('{ nope')).toMatchObject({ error: expect.stringContaining('not valid JSON') })
  expect(parseTeam('[1, 2]')).toEqual({ error: 'team.json must hold one JSON object.' })
  const parsed = parseTeam(
    JSON.stringify({
      version: 'one',
      name: 7,
      conventions: [1, 2],
      recommendedMods: ['good-mod', 'Bad Mod', 5, 'good-mod', '../evil'],
      marketplace: 'not a repo',
      marketplaceName: 'has space',
      guard: { level: 'paranoid' },
      budget: { sessionUsd: -1, dailyUsd: 'ten', weeklyUsd: 3, sessionTokens: 100 },
      notifications: { critical: 'loud', urgent: 'always', error: 'away' },
      owners: 'alice',
      color: 'blue',
    }),
  )
  if ('error' in parsed) throw new Error(parsed.error)
  expect(parsed.team).toMatchObject({ recommendedMods: ['good-mod'], budget: { sessionTokens: 100 }, notifications: { error: 'away' }, guardLevel: 'off', owners: [], extra: { color: 'blue' } })
  expect(parsed.warnings.join('\n')).toContain('version: expected a whole number.')
  expect(parsed.warnings.join('\n')).toContain('name: expected text.')
  expect(parsed.warnings.join('\n')).toContain('conventions: expected text, or a list of lines.')
  expect(parsed.warnings.join('\n')).toContain('"Bad Mod" is not a mod name')
  expect(parsed.warnings.join('\n')).toContain('marketplace: expected a GitHub "owner/repo".')
  expect(parsed.warnings.join('\n')).toContain('guard: level must be one of off, standard, strict.')
  expect(parsed.warnings.join('\n')).toContain('budget.sessionUsd: expected a number, 0 or more.')
  expect(parsed.warnings.join('\n')).toContain('budget.weeklyUsd: unknown')
  expect(parsed.warnings.join('\n')).toContain('notifications.critical: route must be one of')
  expect(parsed.warnings.join('\n')).toContain('notifications.urgent: unknown level')
  expect(parsed.warnings.join('\n')).toContain('owners: expected a list of emails or names.')
  expect(parsed.warnings.join('\n')).toContain('color: not used by team-hub (kept as it is).')
  const newer = parseTeam(JSON.stringify({ version: 3 }))
  if ('error' in newer) throw new Error(newer.error)
  expect(newer.warnings[0]).toContain('version 3 is newer')
  const long = parseTeam(JSON.stringify({ conventions: 'x'.repeat(MAX_CONVENTIONS + 50) }))
  if ('error' in long) throw new Error(long.error)
  expect(long.team.conventions).toHaveLength(MAX_CONVENTIONS)
  expect(long.warnings[0]).toContain('cut to')
})

test('writing: stable key order, conventions one line each, defaults left out, unknown keys kept; reading it back gives the same team', () => {
  const read = team(FULL)
  const text = serializeTeam({ ...read, extra: { color: 'blue' } })
  expect(text.endsWith('}\n')).toBe(true)
  expect(Object.keys(JSON.parse(text))).toEqual(['version', 'name', 'conventions', 'recommendedMods', 'guard', 'budget', 'notifications', 'owners', 'color'])
  expect(JSON.parse(text).conventions).toEqual(['Write small commits.', 'Run the tests before a pull request.'])
  expect(JSON.parse(text).guard).toEqual({ level: 'strict' })
  expect(team(text)).toEqual({ ...read, extra: { color: 'blue' } })
  const minimal = JSON.parse(serializeTeam({ ...EMPTY_TEAM, name: 'Solo', conventions: 'Be kind.' })) as Record<string, unknown>
  expect(minimal).toEqual({ version: 1, name: 'Solo', conventions: 'Be kind.', recommendedMods: [] })
  const custom = JSON.parse(serializeTeam({ ...EMPTY_TEAM, marketplace: 'acme/mods', marketplaceName: 'acme' })) as Record<string, unknown>
  expect(custom).toMatchObject({ marketplace: 'acme/mods', marketplaceName: 'acme' })
  // The same team always gives the same file: a diff shows only what changed.
  expect(serializeTeam(read)).toBe(serializeTeam(team(serializeTeam(read))))
})

test('the system prompt section: conventions with the team name, capped at a line, stable, empty when there are none', () => {
  const read = team(FULL)
  const section = conventionsSection(read)
  expect(section).toBe(['# Team conventions: Acme Web Team', 'The team agreed these in .claude/team.json. Follow them unless the person asks otherwise.', '', 'Write small commits.', 'Run the tests before a pull request.'].join('\n'))
  expect(conventionsSection(read)).toBe(section)
  expect(conventionsSection({ ...read, conventions: '' })).toBe('')
  expect(conventionsSection({ ...read, name: '', conventions: 'Only line' }).split('\n')[0]).toBe('# Team conventions')
  const lines = Array.from({ length: 200 }, (_unused, index) => `Convention number ${index} says something fairly long`)
  const capped = conventionsSection({ ...read, conventions: lines.join('\n') })
  expect(capped.length).toBeLessThan(MAX_SECTION + 300)
  expect(capped).toContain('(Shortened here; the full text is in .claude/team.json.)')
  const kept = capped.split('\n').filter(line => line.startsWith('Convention number'))
  expect(kept.every(line => lines.includes(line))).toBe(true)
})

test('edits: each one is checked and works on a copy', () => {
  const base = team(FULL)
  const ok = (op: Parameters<typeof applyOp>[1]): TeamConfig => {
    const edited = applyOp(base, op)
    if ('error' in edited) throw new Error(edited.error)
    return edited.team
  }
  const error = (op: Parameters<typeof applyOp>[1]): string => {
    const edited = applyOp(base, op)
    return 'error' in edited ? edited.error : ''
  }
  expect(ok({ type: 'name', value: '  New name ' }).name).toBe('New name')
  expect(conventionLines(ok({ type: 'addConvention', value: '  Review   within a day ' }))).toEqual(['Write small commits.', 'Run the tests before a pull request.', 'Review within a day'])
  expect(error({ type: 'addConvention', value: '   ' })).toBe('A convention cannot be empty.')
  expect(conventionLines(ok({ type: 'removeConvention', index: 0 }))).toEqual(['Run the tests before a pull request.'])
  expect(error({ type: 'removeConvention', index: 9 })).toBe('There is no such convention.')
  expect(ok({ type: 'addMod', value: 'test-watch' }).recommendedMods).toEqual(['secret-shield', 'guardian', 'token-budget', 'test-watch'])
  expect(error({ type: 'addMod', value: 'guardian' })).toBe('guardian is already recommended.')
  expect(error({ type: 'addMod', value: 'Not A Mod' })).toContain('is not a mod name')
  expect(ok({ type: 'removeMod', value: 'guardian' }).recommendedMods).toEqual(['secret-shield', 'token-budget'])
  expect(error({ type: 'removeMod', value: 'nope' })).toBe('nope is not in the list.')
  expect(ok({ type: 'guard', value: 'standard' }).guardLevel).toBe('standard')
  expect(ok({ type: 'budget', key: 'sessionUsd', value: 3 }).budget).toEqual({ sessionUsd: 3, sessionTokens: 0, dailyUsd: 20 })
  expect(ok({ type: 'budget', key: 'dailyUsd', value: null }).budget).toEqual({ sessionUsd: 5, sessionTokens: 0 })
  expect(error({ type: 'budget', key: 'sessionUsd', value: -2 })).toBe('A budget is a number, 0 or more.')
  expect(error({ type: 'budget', key: 'sessionUsd', value: Number.NaN })).toBe('A budget is a number, 0 or more.')
  expect(ok({ type: 'route', level: 'warning', value: 'away' }).notifications).toEqual({ critical: 'always', error: 'away', warning: 'away' })
  expect(ok({ type: 'route', level: 'error', value: null }).notifications).toEqual({ critical: 'always' })
  expect(ok({ type: 'addOwner', value: 'carol@acme.com' }).owners).toEqual(['alice@acme.com', 'Bob', 'carol@acme.com'])
  expect(error({ type: 'addOwner', value: 'BOB' })).toBe('BOB is already an owner.')
  expect(ok({ type: 'removeOwner', value: 'bob' }).owners).toEqual(['alice@acme.com'])
  expect(base.owners).toEqual(['alice@acme.com', 'Bob'])
  expect(base.recommendedMods).toHaveLength(3)
})

test('maintainers: owners match on git email or name; a file with no owners is open to anyone', () => {
  const read = team(FULL)
  expect(isMaintainer(read, { email: 'ALICE@acme.com', name: 'Alice' })).toBe(true)
  expect(isMaintainer(read, { email: 'x@y.z', name: 'bob' })).toBe(true)
  expect(isMaintainer(read, { email: 'eve@evil.com', name: 'Eve' })).toBe(false)
  expect(isMaintainer(read, { email: '', name: '' })).toBe(false)
  expect(isMaintainer({ ...read, owners: [] }, { email: '', name: '' })).toBe(true)
})

test('starter: a valid file for a repository without one, owned by whoever creates it', () => {
  const starter = starterTeam('shop', 'alice@acme.com')
  expect(starter.owners).toEqual(['alice@acme.com'])
  expect(team(serializeTeam(starter))).toEqual(starter)
  expect(starterTeam('shop', '').owners).toEqual([])
})

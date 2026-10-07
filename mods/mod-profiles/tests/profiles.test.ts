import { expect, test } from 'claude-code/testing'

import { changeLabel, parseInstalled, parseRequest, planFor, profileOf, readProfiles } from '../hooks/profiles'

const plugins = [
  { id: 'cost-meter@claude-mods', scope: 'user', isEnabled: true },
  { id: 'focus-timer@claude-mods', scope: 'user', isEnabled: false },
  { id: 'celebrate@claude-mods', scope: 'project', isEnabled: true },
  { id: 'mod-profiles@claude-mods', scope: 'user', isEnabled: true },
  { id: 'policy@corp', scope: 'managed', isEnabled: true },
]

test('reads the actions and refuses odd profile names', () => {
  expect(parseRequest('')).toEqual({ kind: 'open' })
  expect(parseRequest('list')).toEqual({ kind: 'list' })
  expect(parseRequest('save Work')).toEqual({ kind: 'save', name: 'work' })
  expect(parseRequest('use demo_2')).toEqual({ kind: 'use', name: 'demo_2' })
  expect(parseRequest('delete')).toEqual({ kind: 'usage', reason: 'Give the profile a name, like work, personal or demo.' })
  expect(parseRequest('use my profile')).toEqual({ kind: 'usage', reason: 'A profile name is one word.' })
  expect(parseRequest('save ../etc')).toMatchObject({ kind: 'usage' })
  expect(parseRequest('switch work')).toEqual({ kind: 'usage', reason: 'Unknown action "switch".' })
})

test('a profile records what is on and off; using it enables, disables and leaves newcomers alone', () => {
  const work = profileOf(plugins, 1)
  expect(work).toEqual({
    enabled: ['celebrate@claude-mods', 'cost-meter@claude-mods', 'mod-profiles@claude-mods', 'policy@corp'],
    disabled: ['focus-timer@claude-mods'],
    savedAt: 1,
  })

  const later = [
    { id: 'cost-meter@claude-mods', scope: 'user', isEnabled: false },
    { id: 'focus-timer@claude-mods', scope: 'user', isEnabled: true },
    { id: 'mod-profiles@claude-mods', scope: 'user', isEnabled: false },
    { id: 'policy@corp', scope: 'managed', isEnabled: false },
    { id: 'new-mod@claude-mods', scope: 'user', isEnabled: true },
  ]
  const plan = planFor(work, later)
  expect(plan).toEqual({
    enable: [{ id: 'cost-meter@claude-mods', scope: 'user' }],
    disable: [{ id: 'focus-timer@claude-mods', scope: 'user' }],
    missing: ['celebrate@claude-mods'],
    untouched: ['new-mod@claude-mods'],
  })
  expect(changeLabel(plan)).toBe('+1 −1')
  expect(changeLabel(planFor(work, plugins))).toBe('matches now')
})

test('reads the plugin list and keeps only well-formed stored profiles', () => {
  expect(parseInstalled('[{"id":"a@m","scope":"local","enabled":false},{"id":"broken"},{"version":"1"}]')).toEqual([
    { id: 'a@m', scope: 'local', isEnabled: false },
  ])
  expect(readProfiles({ work: { enabled: ['a@m', 3], disabled: [], savedAt: 5 }, 'Bad Name': { enabled: [], disabled: [], savedAt: 1 }, old: 'x' })).toEqual({
    work: { enabled: ['a@m'], disabled: [], savedAt: 5 },
  })
  expect(readProfiles(undefined)).toEqual({})
})

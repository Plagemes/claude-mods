import { expect, test } from 'claude-code/testing'

import { compareVersions, debugHints, diagnose, parseInstalled, parseMarketplace, parseProfile } from '../hooks/diagnose'
import type { Evidence, Installed, Profile } from '../hooks/diagnose'

const LIST = JSON.stringify([
  {
    id: 'celebrate@claude-mods',
    version: '1.0.0',
    scope: 'user',
    enabled: false,
    installPath: '/home/me/.claude/plugins/cache/claude-mods/celebrate/1.0.0',
    installedAt: '2026-10-07T15:26:03.039Z',
  },
  {
    id: 'mod-store@claude-mods',
    version: '1.0.0',
    scope: 'project',
    enabled: true,
    installPath: '/home/me/.claude/plugins/cache/claude-mods/mod-store/1.0.0',
    readFromFolder: '/src/claude-mods/mods/mod-store',
  },
  { id: 'nameless', version: '1.0.0' },
])

/** A `claude plugin validate --json` report with these notes and errors. */
export const validation = (notes: string[], errors: string[] = []): string =>
  JSON.stringify({
    success: errors.length === 0,
    manifest: { errors: [], warnings: [], notes: [] },
    contents: [{ errors: errors.map(message => ({ path: 'modules', message })), warnings: [], notes }],
  })

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  loadErrors: [],
  commands: [],
  usesStatus: false,
  usesBand: false,
  composes: false,
  ...overrides,
})

const plugin = (name: string, overrides: Partial<Installed> = {}): Installed => ({
  id: `${name}@claude-mods`,
  name,
  marketplace: 'claude-mods',
  version: '1.0.0',
  scope: 'user',
  isEnabled: true,
  folder: `/mods/${name}`,
  ...overrides,
})

test('reads the plugin list, marketplaces and validate reports', () => {
  expect(parseInstalled(LIST)).toEqual([
    {
      id: 'celebrate@claude-mods',
      name: 'celebrate',
      marketplace: 'claude-mods',
      version: '1.0.0',
      scope: 'user',
      isEnabled: false,
      folder: '/home/me/.claude/plugins/cache/claude-mods/celebrate/1.0.0',
    },
    {
      id: 'mod-store@claude-mods',
      name: 'mod-store',
      marketplace: 'claude-mods',
      version: '1.0.0',
      scope: 'project',
      isEnabled: true,
      folder: '/src/claude-mods/mods/mod-store',
    },
  ])
  expect(() => parseInstalled('{"installed":[]}')).toThrow()
  expect(parseMarketplace('{"name":"claude-mods","plugins":[{"name":"a","version":"1.2.0"},{"name":"b"}]}')).toEqual({
    name: 'claude-mods',
    versions: { a: '1.2.0', b: '' },
  })

  expect(
    parseProfile(
      validation([
        './register.tsx hooks: session.start, command.run{command=mods}, ui.render{component=AbovePrompt}, prompt.compose',
        './register.tsx answers its own command: command.run{command=mods}',
        './register.tsx calls: $.command.register, $.ui.status (via show), $.ui.toast',
      ]),
    ),
  ).toEqual({ loadErrors: [], commands: ['mods'], usesStatus: true, usesBand: true, composes: true })
  expect(parseProfile(validation([], ['broken: hooks/register.ts does not parse: Unexpected ; (line 1, column 79)']))?.loadErrors).toEqual([
    'broken: hooks/register.ts does not parse: Unexpected ; (line 1, column 79)',
  ])
  expect(parseProfile('Validating…')).toBeUndefined()
})

test('compares versions numerically and finds debug-log hints by plugin', () => {
  expect(compareVersions('1.10.0', '1.9.2')).toBe(1)
  expect(compareVersions('v2.0.0', '2.0')).toBe(0)
  expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(-1)
  expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)

  const log = [
    '2026-10-07T10:00:00Z [DEBUG] token-budget: prompt.submit hook skipped: TypeError (42 chars)',
    '2026-10-07T10:00:01Z [DEBUG] my-token-budget: prompt.submit hook skipped: TypeError',
    '2026-10-07T10:00:02Z [DEBUG] celebrate: loaded in 3 ms',
    "2026-10-07T10:00:03Z [DEBUG] celebrate: ui.render (AbovePrompt) refused: Box borderStyle is a number; the engine drew its own",
  ].join('\n')
  expect(debugHints(log, ['token-budget', 'celebrate'])).toEqual({
    'token-budget': ['prompt.submit hook skipped: TypeError (42 chars)'],
    celebrate: ['ui.render (AbovePrompt) refused: Box borderStyle is a number; the engine drew its own'],
  })
})

test('diagnoses load errors, updates, disabled mods, command clashes, known pairs and crowding', () => {
  const installed = [
    plugin('secret-shield', { version: '1.0.0' }),
    plugin('broken-thing'),
    plugin('celebrate', { isEnabled: false }),
    plugin('concise-mode'),
    plugin('explain-level'),
    plugin('output-trimmer'),
    plugin('redactor'),
    plugin('review-agent'),
    plugin('my-reviewer', { marketplace: 'other', id: 'my-reviewer@other' }),
    plugin('team-policy', { scope: 'managed', version: '0.9.0' }),
    plugin('retired-mod'),
    plugin('mod-doctor'),
  ]
  const evidence: Evidence = {
    installed,
    profiles: {
      'secret-shield@claude-mods': profile({ usesStatus: true }),
      'broken-thing@claude-mods': profile({ loadErrors: ['hooks/register.ts does not parse'] }),
      'celebrate@claude-mods': profile(),
      'concise-mode@claude-mods': profile({ composes: true, usesStatus: true, commands: ['concise'] }),
      'explain-level@claude-mods': profile({ composes: true, usesStatus: true, commands: ['eli5', 'expert'] }),
      'output-trimmer@claude-mods': profile({ usesStatus: true }),
      'redactor@claude-mods': profile(),
      'review-agent@claude-mods': profile({ commands: ['review', 'code-review'] }),
      'my-reviewer@other': profile({ commands: ['code-review'] }),
      'team-policy@claude-mods': profile(),
      'retired-mod@claude-mods': { problem: 'claude plugin validate did not run: aborted' },
      'mod-doctor@claude-mods': profile({ commands: ['mod-doctor'] }),
    },
    catalogs: {
      'claude-mods': {
        'secret-shield': '1.2.0',
        'broken-thing': '1.0.1',
        celebrate: '1.0.0',
        'concise-mode': '1.0.0',
        'explain-level': '1.0.0',
        'output-trimmer': '1.0.0',
        redactor: '1.0.0',
        'review-agent': '1.0.0',
        'team-policy': '1.0.0',
        'mod-doctor': '1.0.0',
      },
    },
    marketplace: 'claude-mods',
    builtins: ['review', 'help'],
    hints: { 'secret-shield': ['tool.call hook skipped: TypeError'] },
  }
  const found = diagnose(evidence)
  const titled = found.map(finding => `${finding.severity}: ${finding.title}`)

  expect(titled).toEqual([
    'error: /code-review is registered by review-agent and my-reviewer',
    'error: broken-thing fails to load',
    'warning: broken-thing 1.0.0 → 1.0.1 available',
    'warning: concise-mode + explain-level',
    'warning: retired-mod could not be checked',
    'warning: review-agent registers /review, a built-in command',
    'warning: secret-shield 1.0.0 → 1.2.0 available',
    'warning: secret-shield reported problems this session',
    'warning: team-policy 0.9.0 → 1.0.0 available',
    'info: 4 mods write to the status line',
    'info: celebrate is disabled',
    'info: retired-mod is no longer in the claude-mods catalog',
    'ok: output-trimmer + redactor',
  ])
  const byKey = new Map(found.map(finding => [finding.key, finding]))
  expect(byKey.get('load:broken-thing@claude-mods')?.fixes.map(fix => fix.label)).toEqual(['Update to 1.0.1', 'Disable'])
  expect(byKey.get('outdated:secret-shield@claude-mods')?.fixes).toEqual([
    { action: 'update', id: 'secret-shield@claude-mods', scope: 'user', label: 'Update to 1.2.0' },
  ])
  expect(byKey.get('outdated:team-policy@claude-mods')?.fixes).toEqual([])
  expect(byKey.get('disabled:celebrate@claude-mods')?.fixes.map(fix => fix.action)).toEqual(['enable'])
  expect(byKey.get('clash:code-review')?.fixes.map(fix => fix.id)).toEqual(['review-agent@claude-mods', 'my-reviewer@other'])
  expect(byKey.get('crowd:status')?.details[0]).toBe('secret-shield, concise-mode, explain-level, output-trimmer')

  const healthy = diagnose({ ...evidence, installed: [plugin('mod-doctor')], hints: {} })
  expect(healthy.map(finding => finding.title)).toEqual(['No problems found across 1 plugin'])
  expect(healthy[0]?.fixes).toEqual([])
  expect(diagnose({ ...evidence, installed: [] })[0]?.title).toBe('No plugins are installed')
})

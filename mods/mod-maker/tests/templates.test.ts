import { expect, test } from 'claude-code/testing'

import { parseTestRun, parseValidation } from '../hooks/cli'
import { githubRepository, marketplaceName, nameProblem, parseArgs, quote, scaffold } from '../hooks/templates'
import type { ModSpec } from '../hooks/templates'

const SPEC: ModSpec = { name: 'tidy-bot', description: "Keeps Claude's \"tidy\" promises.", kind: 'command', isCollection: false }

test('reads the name, a quoted or bare description and --kind anywhere', () => {
  expect(parseArgs('tidy-bot', 'command')).toEqual({
    isOk: true,
    name: 'tidy-bot',
    kind: 'command',
    description: 'Adds the /tidy-bot command, which counts the words you give it.',
  })
  expect(parseArgs('tidy-bot "Cleans up after Claude" --kind guard', 'command')).toMatchObject({ kind: 'guard', description: 'Cleans up after Claude' })
  expect(parseArgs('--kind=pane tidy-bot Lists   every file', 'status')).toMatchObject({ name: 'tidy-bot', kind: 'pane', description: 'Lists every file' })
  expect(parseArgs('tidy-bot --kind STATUS', 'guard')).toMatchObject({ kind: 'status' })
  expect(parseArgs('tidy-bot --kind widget', 'guard')).toEqual({ isOk: false, reason: '--kind takes guard, status, pane, command, not "widget".' })
  expect(parseArgs('Tidy_Bot', 'guard')).toMatchObject({ isOk: false })
  expect(nameProblem('a'.repeat(65))).toContain('longer than 64')
  expect(nameProblem('my--mod')).toContain('kebab-case')
  expect(nameProblem('2fast')).toContain('kebab-case')
  expect(nameProblem('ok-2')).toBeUndefined()
})

test('every kind has a manifest, a hooks module, a test and a README; the pane adds its state types', () => {
  const paths = (kind: ModSpec['kind']) => Object.keys(scaffold({ ...SPEC, kind })).sort()
  const common = ['.claude-plugin/plugin.json', 'README.md', 'hooks/hooks.json', 'tests/register.test.ts']
  expect(paths('guard')).toEqual([...common, 'hooks/register.ts'].sort())
  expect(paths('status')).toEqual([...common, 'hooks/register.ts'].sort())
  expect(paths('command')).toEqual([...common, 'hooks/register.ts'].sort())
  expect(paths('pane')).toEqual([...common, 'hooks/register.tsx', 'types/index.d.ts'].sort())

  const pane = scaffold({ ...SPEC, kind: 'pane' })
  expect(JSON.parse(pane['hooks/hooks.json'] ?? '')).toEqual({ modules: ['./register.tsx'] })
  expect(JSON.parse(pane['.claude-plugin/plugin.json'] ?? '')).toMatchObject({ name: 'tidy-bot', types: './types/index.d.ts' })
  expect(pane['types/index.d.ts']).toContain("'tidy-bot': { calls: TidyBotCall[] }")
  expect(pane['hooks/register.tsx']).toContain("const calls = atom({ plugin: 'tidy-bot', key: 'calls' } as const, [])")
  expect(pane['hooks/register.tsx']).toContain("on('command.run', { command: 'tidy-bot' }")
})

test('descriptions are escaped in code and kept as written in the manifest and README', () => {
  const files = scaffold({ ...SPEC, author: 'Ada', repository: 'ada/mods', isCollection: true })
  expect(files['hooks/register.ts']).toContain(`description: ${quote(SPEC.description)},`)
  expect(quote(SPEC.description)).toBe(`'Keeps Claude\\'s "tidy" promises.'`)
  expect(JSON.parse(files['.claude-plugin/plugin.json'] ?? '')).toEqual({
    name: 'tidy-bot',
    version: '1.0.0',
    description: SPEC.description,
    author: { name: 'Ada' },
    repository: 'https://github.com/ada/mods',
    license: 'MIT',
    keywords: ['claude-mods', 'command'],
  })
  expect(files['README.md']).toStartWith(`# tidy-bot\n> ${SPEC.description}\n`)
  expect(files['README.md']).toContain('/plugin marketplace add ada/mods\n/plugin install tidy-bot@mods\n')
  expect(scaffold({ ...SPEC, repository: 'ada/mods', marketplace: 'ada-mods', isCollection: true })['README.md']).toContain('/plugin install tidy-bot@ada-mods')
  expect(marketplaceName('{"name":"claude-mods","plugins":[]}')).toBe('claude-mods')
  expect(marketplaceName('nope')).toBeUndefined()
  expect(scaffold(SPEC)['README.md']).toContain('claude --plugin-dir ./tidy-bot')
})

test('reads GitHub remotes and the CLI reports', () => {
  expect(githubRepository('git@github.com:ada/mods.git')).toBe('ada/mods')
  expect(githubRepository('https://github.com/ada/claude.mods')).toBe('ada/claude.mods')
  expect(githubRepository('https://gitlab.com/ada/mods.git')).toBeUndefined()

  expect(parseValidation('{"success":true,"manifest":{"errors":[],"warnings":[{"message":"no author"}]},"contents":[]}')).toEqual({
    isOk: true,
    errors: [],
    warnings: 1,
  })
  expect(parseValidation('{"success":false,"manifest":{"errors":[]},"contents":[{"errors":[{"message":"does not parse"}]}]}')).toEqual({
    isOk: false,
    errors: ['does not parse'],
    warnings: 0,
  })
  expect(parseValidation('not json')).toBeUndefined()
  expect(parseTestRun('(pass) a\n(pass) b\n\n 2 pass\n 0 fail\nRan 2 tests')).toEqual({ passed: 2, failed: 0 })
  expect(parseTestRun('bun: not found')).toBeUndefined()
})

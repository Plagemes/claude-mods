import { describe, expect, test } from 'claude-code/testing'

import type { StoreInstall, StoreMod } from '../types'
import { buildCatalog, parseArgs, parseCatalogMeta, parsePacks } from '../hooks/catalog'
import {
  changesOf,
  disabledEntries,
  editEnabledPlugins,
  firstMatch,
  globToRegExp,
  mentions,
  mergeUsage,
  parseDeps,
  parseTranscript,
  projectFolder,
  proposeProfile,
  proposeSlim,
  usesByMod,
} from '../hooks/profile'

const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const iso = (at: number) => new Date(at).toISOString()

const mod = (name: string, category: string, extra: Partial<StoreMod> = {}): StoreMod =>
  ({ name, description: '', version: '1.0.0', category, keywords: [], ...extra })
const on: StoreInstall = { version: '1.0.0', scope: 'user', isEnabled: true }

const MODS: StoreMod[] = [
  mod('mod-store', 'core', { signals: { always: true }, commands: ['/mods'] }),
  mod('mods-hub', 'core', { commands: ['/hub'] }),
  mod('cost-meter', 'cost', { signals: { always: true } }),
  mod('rm-rf-guard', 'security'),
  mod('prod-guard', 'security', { signals: { files: ['*.tf', '**/*.tf', 'k8s/**'] } }),
  mod('docker-lint', 'devops', { signals: { files: ['Dockerfile', '**/Dockerfile'] } }),
  mod('react-doctor', 'stacks', { signals: { files: ['**/*.tsx'], deps: ['react'] } }),
  mod('sql-safety', 'data', { signals: { files: ['*.sql'], deps: ['pg', 'psycopg2'] } }),
  mod('k8s-dry-run', 'devops', { signals: { files: ['k8s/**'] } }),
  mod('todo-pane', 'productivity', { commands: ['/todos-pane'] }),
  mod('standup', 'team', { commands: ['/standup'] }),
  mod('quiz-me', 'learning', { commands: ['/quiz'], signals: { intents: ['quiz me'] } }),
  mod('done-chime', 'notifications'),
  mod('project-brain', 'memory', { commands: ['/brain'] }),
]
const ALL_ON = Object.fromEntries(MODS.map(one => [one.name, on]))

describe('globs', () => {
  test('* stays in a folder, ** crosses folders, and a glob without / names the root', () => {
    expect(globToRegExp('*.tf').test('main.tf')).toBe(true)
    expect(globToRegExp('*.tf').test('infra/main.tf')).toBe(false)
    expect(globToRegExp('**/*.tf').test('infra/net/main.tf')).toBe(true)
    expect(globToRegExp('**/*.tf').test('main.tf')).toBe(true)
    expect(globToRegExp('requirements*.txt').test('requirements-dev.txt')).toBe(true)
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/ci.yml')).toBe(true)
    expect(globToRegExp('**/migrations/**').test('app/db/migrations/0001.py')).toBe(true)
    expect(globToRegExp('.env.*').test('.envrc')).toBe(false)
  })

  test('a folder the walk did not enter still matches dir/**, and the first glob that matches wins', () => {
    expect(firstMatch(['k8s/**'], ['src/', 'k8s/'])).toBe('k8s')
    expect(firstMatch(['Dockerfile', '**/Dockerfile'], ['api/Dockerfile', 'README.md'])).toBe('api/Dockerfile')
    expect(firstMatch(['*.sql'], ['db/schema.sql'])).toBeUndefined()
  })
})

describe('dependencies', () => {
  test('package.json, composer.json, requirements, pyproject, Pipfile, Gemfile, Cargo.toml and go.mod', () => {
    expect(parseDeps('package.json', JSON.stringify({ dependencies: { React: '^19' }, devDependencies: { vitest: '1' } }))).toEqual(['react', 'vitest'])
    expect(parseDeps('web/package.json', '{ not json')).toEqual([])
    expect(parseDeps('composer.json', JSON.stringify({ require: { 'laravel/framework': '^11' } }))).toEqual(['laravel/framework'])
    expect(parseDeps('requirements-dev.txt', '# tools\nDjango>=4.2\npsycopg2_binary==2.9\n-r base.txt\n')).toEqual(['django', 'psycopg2-binary'])
    const pyproject = '[project]\nname = "app"\ndependencies = ["fastapi>=0.1", "SQLAlchemy"]\n\n[tool.poetry.dependencies]\npython = "^3.12"\nalembic = "^1"\n'
    expect(parseDeps('pyproject.toml', pyproject)).toEqual(expect.arrayContaining(['fastapi', 'sqlalchemy', 'alembic']))
    expect(parseDeps('pyproject.toml', pyproject)).not.toContain('python')
    expect(parseDeps('Pipfile', '[packages]\nflask = "*"\n[dev-packages]\npytest = "*"\n')).toEqual(['flask', 'pytest'])
    expect(parseDeps('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n  gem \"rspec\"\n")).toEqual(['rails', 'rspec'])
    expect(parseDeps('Cargo.toml', '[package]\nname = "x"\n[dependencies]\nserde = "1"\n[dev-dependencies]\ncriterion = "0.5"\n')).toEqual(['serde', 'criterion'])
    expect(parseDeps('go.mod', 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\nrequire golang.org/x/net v0.1.0\n')).toEqual(['github.com/gin-gonic/gin', 'golang.org/x/net'])
  })
})

/** A transcript as Claude Code writes it: one JSON object per line. */
const line = (record: Record<string, unknown>) => JSON.stringify(record)
const TRANSCRIPT = [
  line({ type: 'system', timestamp: iso(NOW - 20 * DAY), tools: [{ name: 'mcp__project-brain__brain_recall', description: 'If a `<command-name>` block is present…' }] }),
  line({ type: 'user', timestamp: iso(NOW - 20 * DAY), message: { role: 'user', content: '<command-name>/standup</command-name>\n<command-message>standup</command-message>\n<command-args></command-args>' } }),
  line({ type: 'user', timestamp: iso(NOW - 3 * DAY), message: { role: 'user', content: '<command-name>/hub</command-name>\n<command-args>status</command-args>' } }),
  line({ type: 'user', timestamp: iso(NOW - 2 * DAY), message: { role: 'user', content: 'Can you quiz me on the parser?' } }),
  line({ type: 'assistant', timestamp: iso(NOW - 2 * DAY), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__project-brain__brain_recall', input: {} }] } }),
  line({ type: 'user', timestamp: iso(NOW - DAY), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '<command-name>/todos-pane</command-name>' }] } }),
  line({ type: 'user', timestamp: iso(NOW - DAY), message: { role: 'user', content: 'please QUIZ ME again tomorrow' } }),
  '{"type":"user","timestamp":"not a date"}',
  'garbage',
].join('\n')

describe('transcripts', () => {
  test('slash commands from user lines and mcp tools from tool_use blocks, with their latest time', () => {
    const usage = parseTranscript(TRANSCRIPT)
    expect(usage.commands).toEqual({ standup: NOW - 20 * DAY, hub: NOW - 3 * DAY, 'todos-pane': NOW - DAY })
    // The tool's description and its definition in the system line are not uses; the tool_use block is.
    expect(usage.tools).toEqual({ 'project-brain': NOW - 2 * DAY })
    expect(usage.prompts).toEqual(['can you quiz me on the parser?', 'please quiz me again tomorrow'])
    expect(usage.first).toBe(NOW - 20 * DAY)
    expect(usage.last).toBe(NOW - DAY)
  })

  test('a newest chunk drops its first, partial line; merged usage keeps the newest time of each', () => {
    const chunk = parseTranscript(`"timestamp":"${iso(NOW)}","type":"user","message":{"content":"<command-name>/brain</command-name>"}}\n${TRANSCRIPT}`, true)
    expect(chunk.commands.brain).toBeUndefined()
    const merged = mergeUsage([chunk, parseTranscript(line({ type: 'user', timestamp: iso(NOW), message: { content: '<command-name>/standup</command-name>' } }))])
    expect(merged.commands.standup).toBe(NOW)
    expect(merged.first).toBe(NOW - 20 * DAY)
    expect(projectFolder('/Users/me/my.app')).toBe('-Users-me-my-app')
  })

  test('uses are credited to the mod that owns the command, the plugin of the tool, or the source of a hub event', () => {
    const uses = usesByMod(MODS, parseTranscript(TRANSCRIPT), { 'done-chime@claude-mods': NOW - 5 * DAY, stranger: NOW })
    expect(uses.standup).toEqual({ at: NOW - 20 * DAY, what: '/standup' })
    expect(uses['mods-hub']).toEqual({ at: NOW - 3 * DAY, what: '/hub' })
    expect(uses['project-brain']).toEqual({ at: NOW - 2 * DAY, what: 'its tool' })
    expect(uses['todo-pane']).toEqual({ at: NOW - DAY, what: '/todos-pane' })
    expect(uses['done-chime']).toEqual({ at: NOW - 5 * DAY, what: 'hub events' })
    expect(usesByMod(MODS, { commands: { 'quiz-me:quiz': NOW }, tools: {} })['quiz-me']).toEqual({ at: NOW, what: '/quiz' })
  })
})

describe('profile scoring', () => {
  const base = { mods: MODS, installed: ALL_ON, paths: [], deps: [], used: {}, prompts: [], essentials: ['done-chime'] }
  const byName = (rows: ReturnType<typeof proposeProfile>) => Object.fromEntries(rows.map(row => [row.name, row]))

  test('an empty project keeps the always-on, core, general guards and Essentials, and says why the rest goes off', () => {
    const rows = byName(proposeProfile(base))
    expect(Object.values(rows).filter(row => row.keep).map(row => row.name)).toEqual(['mod-store', 'mods-hub', 'cost-meter', 'rm-rf-guard', 'done-chime'])
    expect(rows['mod-store']).toMatchObject({ reason: 'always on', isProtected: true, proposed: true })
    expect(rows['mods-hub']).toMatchObject({ reason: 'always on', isProtected: true })
    expect(rows['rm-rf-guard']).toMatchObject({ reason: 'safety guard', isProtected: true })
    expect(rows['done-chime']).toMatchObject({ reason: 'Essentials pack', isProtected: false })
    expect(rows['prod-guard']).toMatchObject({ keep: false, reason: 'no *.tf or similar here', isProtected: false })
    expect(rows['sql-safety']).toMatchObject({ keep: false, reason: 'no *.sql here' })
    expect(rows.standup).toMatchObject({ keep: false, reason: 'not used in this project' })
  })

  test('files, dependencies, commands run here and repeated intents each keep a mod, with the evidence', () => {
    const rows = byName(proposeProfile({
      ...base,
      paths: ['infra/', 'infra/main.tf', 'web/', 'web/App.tsx', 'k8s/'],
      deps: ['PG'],
      used: { standup: { at: NOW, what: '/standup' } },
      prompts: ['quiz me on this', 'can you quiz me again'],
    }))
    expect(rows['prod-guard']).toMatchObject({ keep: true, reason: 'found infra/main.tf' })
    expect(rows['react-doctor']).toMatchObject({ keep: true, reason: 'found web/App.tsx' })
    expect(rows['k8s-dry-run']).toMatchObject({ keep: true, reason: 'found k8s' })
    expect(rows['sql-safety']).toMatchObject({ keep: true, reason: 'uses pg' })
    expect(rows.standup).toMatchObject({ keep: true, reason: 'you ran /standup here' })
    expect(rows['quiz-me']).toMatchObject({ keep: true, reason: 'you asked about “quiz me”' })
    expect(rows['docker-lint']?.keep).toBe(false)
  })

  test('only installed mods are listed, a disabled one the project needs turns back on, and one prompt is not enough', () => {
    const rows = proposeProfile({
      ...base,
      installed: { 'mod-store': on, 'docker-lint': { ...on, isEnabled: false }, 'quiz-me': on },
      paths: ['Dockerfile'],
      prompts: ['quiz me once'],
    })
    expect(rows.map(row => row.name)).toEqual(['mod-store', 'docker-lint', 'quiz-me'])
    expect(changesOf(rows).map(row => `${row.name}:${row.keep}`)).toEqual(['docker-lint:true', 'quiz-me:false'])
    expect(mentions('rewrite projects', 'write pr')).toBe(false)
    expect(mentions('please write pr notes', 'write pr')).toBe(true)
  })
})

describe('slim', () => {
  const uses = { standup: { at: NOW - 3 * DAY, what: '/standup' }, 'quiz-me': { at: NOW - 30 * DAY, what: '/quiz' } }

  test('idle mods with a command go off; used, new, guarded, always-on and background mods stay, each with why', () => {
    const rows = proposeSlim({
      mods: MODS,
      installed: { ...ALL_ON, 'project-brain': { ...on, installedAt: NOW - 2 * DAY }, 'k8s-dry-run': { ...on, isEnabled: false } },
      uses,
      now: NOW,
      days: 14,
    })
    const byName = Object.fromEntries(rows.map(row => [row.name, row]))
    expect(byName['k8s-dry-run']).toBeUndefined()
    expect(rows.filter(row => !row.keep).map(row => `${row.name}: ${row.reason}`)).toEqual([
      'todo-pane: no /todos-pane in 14 d',
      'quiz-me: no /quiz in 14 d',
    ])
    expect(byName.standup).toMatchObject({ keep: true, reason: 'used /standup 3 d ago' })
    expect(byName['project-brain']).toMatchObject({ keep: true, reason: 'installed 2 d ago' })
    expect(byName['prod-guard']).toMatchObject({ keep: true, reason: 'safety guard', isProtected: true })
    expect(byName['mods-hub']).toMatchObject({ keep: true, reason: 'always on', isProtected: true })
    expect(byName['done-chime']).toMatchObject({ keep: true, reason: 'works in the background: leaves no trace to measure', isProtected: false })
  })
})

describe('settings.local.json', () => {
  test('edits enabledPlugins only, keeps every other key and entry, and returns what it replaced', () => {
    const current = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'other@elsewhere': true, 'standup@claude-mods': true } }, null, 4)
    const edit = editEnabledPlugins(current, { 'standup@claude-mods': false, 'quiz-me@claude-mods': false })
    expect(edit.isOk).toBe(true)
    if (!edit.isOk) return
    expect(JSON.parse(edit.text)).toEqual({
      permissions: { allow: ['Bash(npm test)'] },
      enabledPlugins: { 'other@elsewhere': true, 'standup@claude-mods': false, 'quiz-me@claude-mods': false },
    })
    expect(edit.text.endsWith('}\n')).toBe(true)
    expect(edit.previous).toEqual({ 'standup@claude-mods': true, 'quiz-me@claude-mods': null })
    // Undo is the same edit with the previous values: null removes the entry it added.
    const undone = editEnabledPlugins(edit.text, edit.previous)
    expect(undone.isOk && JSON.parse(undone.text)).toEqual(JSON.parse(current))
  })

  test('a missing or empty file starts empty; an emptied enabledPlugins is removed', () => {
    const created = editEnabledPlugins(undefined, { 'a@m': false })
    expect(created.isOk && JSON.parse(created.text)).toEqual({ enabledPlugins: { 'a@m': false } })
    const emptied = editEnabledPlugins('{"model":"opus","enabledPlugins":{"a@m":false}}', { 'a@m': null })
    expect(emptied.isOk && JSON.parse(emptied.text)).toEqual({ model: 'opus' })
    expect(editEnabledPlugins('  \n', {}).isOk).toBe(true)
  })

  test('a malformed file, a non-object, or a non-object enabledPlugins is never overwritten', () => {
    expect(editEnabledPlugins('{ "enabledPlugins": { "a@m": true, }', { 'a@m': false })).toEqual({ isOk: false, reason: 'it is not valid JSON' })
    expect(editEnabledPlugins('[1, 2]', { 'a@m': false })).toEqual({ isOk: false, reason: 'it is not a JSON object' })
    expect(editEnabledPlugins('{"enabledPlugins": ["a@m"]}', { 'a@m': false })).toEqual({ isOk: false, reason: 'its enabledPlugins is not an object' })
  })

  test('reset removes only this marketplace\'s entries that are off', () => {
    const text = JSON.stringify({ enabledPlugins: { 'a@claude-mods': false, 'b@claude-mods': true, 'c@other': false } })
    expect(disabledEntries(text, 'claude-mods')).toEqual({ 'a@claude-mods': null })
    expect(disabledEntries('not json', 'claude-mods')).toEqual({})
    expect(disabledEntries(undefined, 'claude-mods')).toEqual({})
  })
})

describe('packs and commands', () => {
  test('packs are read from catalog.json, de-duplicated, and limited to the mods the marketplace has', () => {
    expect(parsePacks([
      { id: 'web', title: 'Web', tagline: 'Frontend.', mods: ['react-doctor', 'react-doctor', 'Bad Name!', 'ghost'] },
      { id: 'web', title: 'Again', mods: ['x'] },
      { id: 'Not An Id!', mods: ['x'] },
      { id: 'empty', mods: [] },
    ])).toEqual([{ id: 'web', title: 'Web', tagline: 'Frontend.', mods: ['react-doctor', 'ghost'] }])
    const meta = parseCatalogMeta(JSON.stringify({
      categories: [],
      packs: [{ id: 'web', title: 'Web', mods: ['react-doctor', 'ghost'] }, { id: 'gone', title: 'Gone', mods: ['ghost'] }],
      mods: [{ name: 'react-doctor', signals: { files: ['**/*.tsx', '../x'], deps: ['React'], intents: ['test', 'react hooks', 'kubernetes'], always: false } }],
    }))
    expect(meta.mods['react-doctor']?.signals).toEqual({ files: ['**/*.tsx'], deps: ['react'], intents: ['react hooks', 'kubernetes'] })
    const catalog = buildCatalog({ name: 'claude-mods', mods: [mod('react-doctor', 'stacks')] }, meta, { repository: 'o/r', branch: 'main' }, NOW)
    expect(catalog.packs).toEqual([{ id: 'web', title: 'Web', tagline: '', mods: ['react-doctor'] }])
    expect(catalog.mods[0]?.signals?.deps).toEqual(['react'])
  })

  test('/mods profile, slim, packs, pack and undo', () => {
    expect(parseArgs('profile')).toEqual({ kind: 'profile', step: 'show' })
    expect(parseArgs('profile apply')).toEqual({ kind: 'profile', step: 'apply' })
    expect(parseArgs('profile reset')).toEqual({ kind: 'profile', step: 'reset' })
    expect(parseArgs('profile undo')).toEqual({ kind: 'undo' })
    expect(parseArgs('profile now').kind).toBe('usage')
    expect(parseArgs('slim')).toEqual({ kind: 'slim', step: 'show' })
    expect(parseArgs('slim 30')).toEqual({ kind: 'slim', step: 'show', days: 30 })
    expect(parseArgs('slim 7d')).toEqual({ kind: 'slim', step: 'show', days: 7 })
    expect(parseArgs('slim off')).toEqual({ kind: 'slim', step: 'off' })
    expect(parseArgs('slim 0').kind).toBe('usage')
    expect(parseArgs('packs')).toEqual({ kind: 'packs' })
    expect(parseArgs('pack')).toEqual({ kind: 'packs' })
    expect(parseArgs('pack web')).toEqual({ kind: 'pack', id: 'web', step: 'show' })
    expect(parseArgs('pack Web install')).toEqual({ kind: 'pack', id: 'web', step: 'install' })
    expect(parseArgs('pack web enable')).toEqual({ kind: 'pack', id: 'web', step: 'enable' })
    expect(parseArgs('pack web eat').kind).toBe('usage')
    expect(parseArgs('undo')).toEqual({ kind: 'undo' })
  })
})

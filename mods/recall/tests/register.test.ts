import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chunkMarkdown, search } from '../hooks/search'
import { fakeHub } from './hub'

const ROOT = '/work/app'
const NOTES: Record<string, string> = {
  'CLAUDE.md': '# Conventions\nUse pnpm for every script. Tests live next to the code.\n',
  'docs/decisions/0001-database.md': [
    '# 1. Use Postgres',
    '',
    '## Context',
    'We need relational data and transactions for orders.',
    '',
    '## Decision',
    'We use Postgres with Prisma migrations. Rollbacks are down migrations, reviewed like code.',
    '',
  ].join('\n'),
  '.claude/journal/2026-10-01.md': '# 2026-10-01\n\n## Work done\nFixed the login redirect loop in the auth middleware.\n',
}
const PANE_PROPS = {
  title: 'Recall',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const command = (name: string, args: string) => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

/** A small project on a virtual disk, plus the store and UI nouns the mod calls. */
const project = (on: On, entries: Record<string, unknown> = {}) => {
  const files = new Map(Object.entries(NOTES).map(([path, text]) => [`${ROOT}/${path}`, text]))
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${path}/`))
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  mock.store(on, entries)
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
    return isDir(e.path) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    if (!isDir(e.path)) return { deny: `ENOENT: ${e.path}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of files.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = file.slice(e.path.length + 1).split('/')
      names.set(name, rest.length === 0 ? 'file' : 'dir')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 100, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

const searchTool = (query: unknown) => ({ tool: 'mcp__recall__search' as const, query })

test('chunks follow headings and BM25 puts the most relevant passage first', async () => {
  const chunks = chunkMarkdown('docs/decisions/0001-database.md', NOTES['docs/decisions/0001-database.md'] ?? '')
  expect(chunks.map(chunk => [chunk.title, chunk.line])).toEqual([['Context', 4], ['Decision', 7]])

  const corpus = [
    ...chunks,
    { source: 'memory', title: '2026-10-02', line: 0, text: 'Postgres is slow on the reports page.' },
    { source: 'notes.md', title: 'notes.md', line: 1, text: 'Nothing about databases here at all.' },
  ]
  const hits = search(corpus, 'postgres migrations rollback', 5)
  expect(hits[0]?.title).toBe('Decision')
  expect(hits[1]?.source).toBe('memory')
  expect(hits).toHaveLength(2)
  expect(search(corpus, 'the and of', 5)).toEqual([])
})

test('the search tool ranks passages from decisions, journal and CLAUDE.md', async ($, on) => {
  project(on)
  const found = await $.tool.call(searchTool('postgres migrations'))
  const text = String(found.result)
  expect(text).toContain('match')
  expect(text).toContain('1. docs/decisions/0001-database.md › Decision (line 7)')
  expect(text).toContain('searched 3 files and 0 memories')

  const login = String((await $.tool.call(searchTool('login redirect'))).result)
  expect(login).toContain('.claude/journal/2026-10-01.md › Work done')

  const none = String((await $.tool.call(searchTool('kubernetes'))).result)
  expect(none).toContain('No matches for "kubernetes"')

  const empty = String((await $.tool.call(searchTool('  '))).result)
  expect(empty).toContain('the query is empty')
})

test('/remember saves memories the tool can find, per project or global', async ($, on) => {
  project(on, {
    memories: [{ id: 'old', text: 'Staging deploys need the VPN on.', project: '/work/other', createdAt: 0 }],
  })
  const saved = await $.command.run(command('remember', 'Feature flags live in LaunchDarkly, not env vars'))
  expect(saved.text).toContain('Remembered: "Feature flags live in LaunchDarkly')
  const shared = await $.command.run(command('remember', '-g Always answer in British English'))
  expect(shared.text).toContain('for every project')
  const again = await $.command.run(command('remember', 'Feature flags live in LaunchDarkly, not env vars'))
  expect(again.text).toContain('Already remembered')
  const usage = await $.command.run(command('remember', ''))
  expect(usage.text).toContain('2 memories here')

  const flags = String((await $.tool.call(searchTool('launchdarkly flags'))).result)
  expect(flags).toContain('memory · 2026-10-07')
  const english = String((await $.tool.call(searchTool('british english'))).result)
  expect(english).toContain('(global)')
  const other = String((await $.tool.call(searchTool('staging vpn'))).result)
  expect(other).toContain('No matches')
})

test('session start registers the tool and both commands; the tool skips the default prompt', async ($, on) => {
  const tools: string[] = []
  const commands: string[] = []
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__recall__${e.name}` } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let ruled = false
  on('tool.check', () => (ruled ? { decision: 'ask', rule: 'mcp__recall__search' } : { decision: 'ask' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(tools).toEqual(['search'])
  expect(commands).toEqual(['remember', 'recall'])
  expect((await $.tool.check({ tool: 'mcp__recall__search', input: { query: 'x' } })).decision).toBe('allow')
  ruled = true
  expect((await $.tool.check({ tool: 'mcp__recall__search', input: { query: 'x' } })).decision).toBe('ask')
})

test('the /recall pane searches, lists memories and forgets them on terminal and desktop', async ($, on) => {
  project(on, {
    memories: [
      { id: 'a', text: 'Prefer small PRs', project: ROOT, createdAt: 0 },
      { id: 'b', text: 'Auth tokens rotate every 15 minutes', project: ROOT, createdAt: 1 },
    ],
  })
  const ran = await $.command.run(command('recall', 'auth'))
  expect(ran.text).toContain('2 matches for "auth"')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'recall', surface, component: 'Pane', requestId: 'recall', props: PANE_PROPS })
    await ui.input({ key: 'query', text: 'auth' })
    expect((await ui.find({ key: 'results' }))?.text).toContain('auth middleware')
    expect((await ui.find({ key: 'results' }))?.text).toContain('memory · 1970-01-01')
    await ui.input({ key: 'query', text: 'postgres' })
    expect((await ui.find({ key: 'results' }))?.text).toContain('0001-database.md')
    expect(await ui.find({ type: 'Text', text: 'Memories (2)' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'recall', surface: 'terminal', component: 'Pane', requestId: 'recall', props: PANE_PROPS })
  await ui.press({ key: 'forget:a' })
  expect(await ui.find({ type: 'Text', text: 'Memories (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Prefer small PRs' })).toBeUndefined()
})

test('with mods-hub: decisions and lessons other mods published are searched, their files included', async ($, on) => {
  project(on)
  const hub = fakeHub(on)
  hub.events.push(
    // Already a note recall reads: searched once, from its file.
    { topic: 'decision.recorded', source: 'decision-log', at: 1, data: { title: 'Use Postgres', path: 'docs/decisions/0001-database.md' } },
    // A lesson saved to a file recall does not know: searched as published.
    { topic: 'lesson.learned', source: 'lessons-learned', at: 2, data: { lesson: 'Run the kubernetes manifests through kubeconform first.', context: 'fixing make lint', path: 'docs/AGENTS.md' } },
  )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__recall__${e.name}` } }) as never)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['decision.recorded', 'lesson.learned'] }])

  const found = String((await $.tool.call(searchTool('kubernetes manifests'))).result)
  expect(found).toContain('hub · lesson')
  expect(found).toContain('kubeconform')
  expect(found).toContain('searched 3 files, 0 memories and 1 hub event')

  const postgres = String((await $.tool.call(searchTool('postgres migrations'))).result)
  expect(postgres).toContain('1. docs/decisions/0001-database.md › Decision (line 7)')
  expect(postgres).not.toContain('hub · decision')
})

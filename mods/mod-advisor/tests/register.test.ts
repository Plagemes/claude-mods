import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderPropsOf } from 'claude-code'

import { CATALOG_MODS } from './fixtures'
import { fakeHub } from './hub'

const PLUGIN = 'mod-advisor'
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 7, 9, 0, 0)
const MINUTE = 60_000
const ROOT = '/work/shop'
const RAW = 'https://raw.githubusercontent.com/plagemes/claude-mods/main/'
const BIN = '/opt/claude-code/bin/claude'

const CATALOG = { version: '2.0.0', categories: [{ id: 'core', title: 'Core', tagline: 'Essentials.' }], mods: CATALOG_MODS }
const README = '# commit-composer\n> Commits.\n\n## What it does\nWrites messages.\n\n## Usage\nStage your changes, then type `/commit`.\n\n## Configuration\nNone.\n'

const NEXT_PRISMA: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0', '@prisma/client': '6.0.0' }, devDependencies: { prisma: '6.0.0', typescript: '5.6.0' } }),
  'next.config.mjs': 'export default {}',
  'tsconfig.json': '{}',
  'prisma/schema.prisma': 'model User { id Int @id }',
  'app/page.tsx': 'export default function Page() { return null }',
  'node_modules/next/package.json': '{}',
}
const REACT_ONLY: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }),
  'src/App.jsx': 'export const App = () => null',
}

type Install = { version: string; scope: string; enabled: boolean }
type WorldOptions = {
  files?: Record<string, string>
  installed?: Record<string, Install>
  marketplaces?: { name: string; repo?: string; installLocation?: string }[]
  isWide?: boolean
  isOnline?: boolean
  store?: Record<string, unknown>
  model?: string
  extraFiles?: Record<string, string>
}

/** Stands for everything beneath the plugin: GitHub, the claude CLI, the project's files, the surface. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { CLAUDE_CODE_EXECPATH: BIN })
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const files = new Map<string, string>(Object.entries(options.files ?? NEXT_PRISMA).map(([path, text]) => [`${ROOT}/${path}`, text]))
  Object.entries(options.extraFiles ?? {}).forEach(([path, text]) => files.set(path, text))
  const installed = new Map(Object.entries(options.installed ?? { 'commit-composer': { version: '1.0.0', scope: 'user', enabled: true } }))
  const marketplaces = [...(options.marketplaces ?? [{ name: 'claude-mods', repo: 'plagemes/claude-mods' }])]
  const net = { isOnline: options.isOnline ?? true }
  const pane = { isOpen: false, isPlaced: false, opens: [] as { focus: boolean }[] }
  const calls: string[] = []
  const toasts: string[] = []
  const commands: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const models: string[] = []
  const json = (value: unknown) => JSON.stringify(value)
  const result = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const dirsOf = () => {
    const dirs = new Set<string>()
    for (const path of files.keys()) {
      const parts = path.split('/')
      for (let end = 2; end < parts.length; end += 1) dirs.add(parts.slice(0, end).join('/'))
    }
    return dirs
  }

  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'commit', description: 'Commit', source: 'plugin' as const, plugin: 'commit-composer@claude-mods' },
      { name: 'help', description: 'Help', source: 'builtin' as const },
    ],
  }))
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    if (String(e.tool) === 'Write' && 'file_path' in e && 'content' in e) files.set(String(e.file_path), String(e.content))
    return { result: 'ok' }
  })
  on('turn.complete', ($, e) => ({ text: e.answer, reason: 'answer' as const }))
  on('ui.open', ($, e) => {
    const isPlaced = options.isWide !== false || e.focus === true
    pane.isOpen = true
    pane.isPlaced = pane.isPlaced || isPlaced
    pane.opens.push({ focus: e.focus === true })
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is too narrow' } }
  })
  on('ui.panes', () => ({
    value: pane.isOpen ? [{ id: PLUGIN, title: 'Advisor', isShown: true, isFocused: false, isPlaced: pane.isPlaced }] : [],
  }))
  on('ui.close', () => {
    pane.isOpen = false
    pane.isPlaced = false
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  on('model.complete', ($, e) => {
    models.push(e.model)
    return { value: { isAnswered: true as const, text: options.model ?? 'none', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('http.fetch', ($, e) => {
    if (!net.isOnline) return { deny: 'getaddrinfo ENOTFOUND raw.githubusercontent.com' }
    const body = e.url === `${RAW}catalog.json` ? json(CATALOG) : e.url === `${RAW}mods/commit-composer/README.md` ? README : undefined
    return { value: body === undefined ? { status: 404, ok: false, headers: {}, text: '404' } : { status: 200, ok: true, headers: {}, text: body } }
  })
  on('fs.list', ($, e) => {
    const base = e.path.replace(/\/+$/, '')
    const entries: FsEntry[] = []
    for (const dir of dirsOf()) {
      if (dir.slice(0, dir.lastIndexOf('/')) === base) entries.push({ name: dir.slice(base.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }
    for (const [path, text] of files) {
      if (path.slice(0, path.lastIndexOf('/')) === base) entries.push({ name: path.slice(base.length + 1), kind: 'file', size: text.length, mtimeMs: NOW, isLink: false })
    }
    return entries.length === 0 && !dirsOf().has(base) ? { deny: `ENOENT: ${e.path}` } : { value: entries }
  })
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.stat', ($, e) =>
    files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false } }
    : dirsOf().has(e.path) ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    : { deny: `ENOENT: ${e.path}` })
  on('process.run', ($, e) => {
    const [bin = '', ...args] = e.argv
    expect(bin).toBe(BIN)
    const line = args.join(' ')
    calls.push(line)
    const name = (args[2] ?? '').split('@')[0] ?? ''
    if (line === 'plugin list --json') return result(json([...installed].map(([id, one]) => ({ id: `${id}@claude-mods`, ...one }))))
    if (line === 'plugin marketplace list --json') return result(json(marketplaces.map(one => ({ source: 'github', ...one }))))
    if (args[1] === 'marketplace' && args[2] === 'add') {
      marketplaces.push({ name: 'claude-mods', repo: 'plagemes/claude-mods' })
      return result(json({ command: 'marketplace-add', outcome: 'ok', message: 'Added' }))
    }
    if (args[1] === 'install') {
      installed.set(name, { version: '1.0.0', scope: 'user', enabled: true })
      return result(json({ command: 'install', outcome: 'ok', message: `Installed ${name}` }))
    }
    if (args[1] === 'uninstall') {
      installed.delete(name)
      return result(json({ command: 'uninstall', outcome: 'ok', message: `Uninstalled ${name}` }))
    }
    return result(json({ outcome: 'failed', message: 'unknown' }), 1)
  })

  return { clock, store, files, installed, net, pane, calls, toasts, commands, contexts, models }
}

const PANE_PROPS: RenderPropsOf['Pane'] = { title: 'Advisor', isFocused: true, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }
const BAND_PROPS: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} }

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const advisor = ($: Engine, args = '') =>
  $.command.run({ command: 'mods-advisor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const ask = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const mountPane = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })
const mountBand = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
const projectPrefs = (store: Map<string, unknown>) => (store.get('projects') as Record<string, Record<string, unknown>> | undefined)?.[ROOT]

test('at session start the side pane opens by itself and shows what fits the project and how to use what is installed', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  expect(w.pane.opens).toEqual([{ focus: false }])
  expect(w.calls).toEqual(expect.arrayContaining(['plugin marketplace list --json', 'plugin list --json']))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: '🧭 Advisor' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /For this project · Next\.js, Prisma, React/ })).toBeDefined()
    expect((await ui.find({ key: 'row:project:next-guard' }))?.text).toContain('Next.js · uses next')
    expect((await ui.find({ key: 'row:project:schema-sync' }))?.text).toContain('Prisma · uses prisma')
    expect(await ui.find({ key: 'install:project:next-guard' })).toBeDefined()
    expect(await ui.find({ key: 'dismiss:project:next-guard' })).toBeDefined()
    expect((await ui.find({ key: 'row:installed:commit-composer' }))?.text).toContain('commit-composer ✓ /commit')
    expect(await ui.find({ key: 'uninstall:installed:commit-composer' })).toBeDefined()
    expect(await ui.find({ key: 'search' })).toBeDefined()
    await ui.unmount()
  }
  // The pane is on screen: the band stays out of the way and only the engine's own draws.
  const band = await mountBand($)
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')
  expect(w.toasts).toEqual([])
})

test('in a narrow terminal the band announces the fit once, composes with other bands, and Not now snoozes it', async ($, on) => {
  const w = world(on, { isWide: false })
  await start($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'advisor-band' }))?.text).toMatch(/🧭 \d mods fit this project \(Next\.js, Prisma, React\)/)
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await band.find({ key: 'band-show' })).toBeDefined()
    expect(await band.find({ key: 'band-install' })).toBeDefined()
    await band.unmount()
  }
  const band = await mountBand($)
  await band.press({ key: 'band-later' })
  expect(await band.find({ key: 'advisor-band' })).toBeUndefined()
  expect(projectPrefs(w.store)?.snoozedUntil).toBe(NOW + 7 * 24 * 60 * MINUTE)

  // A new session in the same project: snoozed, and already announced for this catalog.
  await start($)
  await w.clock.settle()
  expect(await band.find({ key: 'advisor-band' })).toBeUndefined()
  // Snoozed means no tips either, even for a mod you have.
  await ask($, 'scrivi il messaggio di commit per queste modifiche')
  await w.clock.settle()
  expect(w.toasts.filter(text => text.startsWith('Tip:'))).toEqual([])
})

test('the band\'s Show opens the pane where it fits, and the band steps aside', async ($, on) => {
  const w = world(on, { isWide: false })
  await start($)
  await w.clock.settle()
  const band = await mountBand($)
  await band.press({ key: 'band-show' })
  expect(w.pane.opens.at(-1)).toEqual({ focus: true })
  expect(await band.find({ key: 'advisor-band' })).toBeUndefined()
})

test('Install all recommended adds the marketplace, installs each mod with the CLI and offers to reload', async ($, on) => {
  const w = world(on, { isWide: false, marketplaces: [] })
  await start($)
  await w.clock.settle()
  const band = await mountBand($)
  const offered = (await band.find({ key: 'advisor-band' }))?.text ?? ''
  await band.press({ key: 'band-install' })
  const installs = w.calls.filter(call => call.startsWith('plugin install'))
  expect(w.calls).toContain('plugin marketplace add plagemes/claude-mods --json')
  expect(w.calls.indexOf('plugin marketplace add plagemes/claude-mods --json')).toBeLessThan(w.calls.indexOf(installs[0] ?? ''))
  expect(installs).toContain('plugin install next-guard@claude-mods --scope user --json')
  expect(installs.length).toBe(Number(/(\d) mods/.exec(offered)?.[1]))
  expect((await band.find({ key: 'advisor-band' }))?.text).toMatch(/✓ Installed \d mods\. Reload plugins to use them\./)
  await band.press({ key: 'band-reload' })
  expect(w.commands).toEqual(['reload-plugins'])
  expect(await band.find({ key: 'advisor-band' })).toBeUndefined()

  // Installed mods leave "For this project" and show under "Installed — how to use".
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeUndefined()
  expect(await ui.find({ key: 'row:installed:next-guard' })).toBeDefined()
})

test('a Dockerfile written mid-session brings docker-lint under New for you, with one toast per 15 minutes', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/Dockerfile`, content: 'FROM node:20\n' })
  await w.clock.advance(4_000)
  expect(w.toasts).toEqual([])
  await w.clock.advance(1_000)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^🧭 (docker-lint would help here \(you added Dockerfile\)|\d new mods fit what you're doing) · \/mods-advisor$/)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'New for you' })).toBeDefined()
    const row = await ui.find({ key: 'row:new:docker-lint' })
    expect(row?.text).toContain('● docker-lint')
    expect(row?.text).toContain('you added Dockerfile')
    expect(await ui.find({ key: 'row:project:docker-lint' })).toBeDefined()
    await ui.unmount()
  }

  // Another change soon after updates the pane but makes no second toast.
  await $.tool.call({ tool: 'Bash', command: 'mkdir -p k8s && touch k8s/deployment.yaml' })
  w.files.set(`${ROOT}/k8s/deployment.yaml`, 'kind: Deployment')
  await w.clock.advance(5_000)
  expect(w.toasts).toHaveLength(1)
  const ui = await mountPane($)
  expect((await ui.find({ key: 'row:new:k8s-dry-run' }))?.text).toContain('you added k8s')
})

test('a dependency installed mid-session brings the mods for it, with the package as the reason', async ($, on) => {
  const w = world(on, { files: REACT_ONLY })
  await start($)
  await w.clock.settle()
  const before = await mountPane($)
  expect(await before.find({ key: 'row:project:schema-sync' })).toBeUndefined()
  await before.unmount()

  w.files.set(`${ROOT}/package.json`, JSON.stringify({ dependencies: { react: '19.0.0', '@prisma/client': '6.0.0' }, devDependencies: { prisma: '6.0.0' } }))
  await $.tool.call({ tool: 'Bash', command: 'npm install prisma @prisma/client' })
  await w.clock.advance(5_000)
  const ui = await mountPane($)
  expect((await ui.find({ key: 'row:new:schema-sync' }))?.text).toContain('prisma was installed')
  expect(await ui.find({ key: 'row:project:schema-sync' })).toBeDefined()
  expect(w.toasts.some(toast => toast.includes('schema-sync') || /new mods fit/.test(toast))).toBe(true)
})

test('changes made outside Claude, and mods installed elsewhere, show up with the 10-minute rescan', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  w.files.set(`${ROOT}/infra/main.tf`, 'resource "null_resource" "x" {}')
  w.installed.set('next-guard', { version: '1.0.0', scope: 'user', enabled: true })
  const turn = () => $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't', reason: 'answer' })
  await turn()
  await w.clock.advance(5 * MINUTE)
  let ui = await mountPane($)
  expect(await ui.find({ key: 'row:new:terraform-plan-pane' })).toBeUndefined()
  await ui.unmount()

  await w.clock.advance(5 * MINUTE)
  await turn()
  await w.clock.advance(5_000)
  ui = await mountPane($)
  expect((await ui.find({ key: 'row:new:terraform-plan-pane' }))?.text).toContain('you added infra/main.tf')
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeUndefined()
  expect((await ui.find({ key: 'row:installed:next-guard' }))?.text).toContain('next-guard ✓')
})

test('a prompt about an installed mod gives a tip with what to type, and Claude a note, once each', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await ask($, 'scrivi il messaggio di commit per queste modifiche')
  await w.clock.settle()
  expect(w.toasts).toEqual(['Tip: /commit writes a Conventional Commit message from your staged diff and commits it'])
  expect(w.contexts[0]?.[0]).toContain('/commit (commit-composer: /commit writes a Conventional Commit message')
  expect(w.contexts[0]?.[0]).toContain('tell the user they can type it')

  await w.clock.advance(11 * MINUTE)
  await ask($, 'write the commit message again')
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
  expect(w.contexts[1]).toBeUndefined()

  // Slash commands and other plugins' prompts are not advice material.
  await ask($, '/commit')
  await $.prompt.submit({ text: 'deploy deploy deploy', wait: false, origin: { kind: 'task-notification' } })
  await w.clock.settle()
  expect(w.contexts.slice(2)).toEqual([undefined, undefined])
  const ui = await mountPane($)
  expect((await ui.find({ key: 'row:now:commit-composer' }))?.text).toContain('commit-composer ✓ /commit')

  // After /clear the conversation is new: Claude hears about /commit again (the tip stays shown once per session).
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await ask($, 'commit message please')
  expect(w.contexts.at(-1)?.[0]).toContain('/commit (commit-composer')
})

test('a mod you keep asking about appears under New for you with one toast; a single mention stays under "now"', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await ask($, 'deploy this to production')
  await w.clock.settle()
  let ui = await mountPane($)
  expect((await ui.find({ key: 'row:now:deploy-checklist' }))?.text).toContain('you\'re asking about "deploy"')
  expect(await ui.find({ key: 'row:new:deploy-checklist' })).toBeUndefined()
  expect(w.toasts).toEqual([])
  await ui.unmount()

  await ask($, 'is the deploy safe now?')
  await w.clock.settle()
  expect(w.toasts).toEqual(['🧭 deploy-checklist would help here (you\'re asking about "deploy") · /mods-advisor'])
  ui = await mountPane($, 'desktop')
  expect(await ui.find({ key: 'row:new:deploy-checklist' })).toBeDefined()
  expect(await ui.find({ key: 'install:new:deploy-checklist' })).toBeDefined()
})

test('Dismiss hides a mod in this project for good, until /mods-advisor reset', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'dismiss:project:next-guard' })
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeUndefined()
  expect(projectPrefs(w.store)?.dismissed).toEqual(['next-guard'])
  expect(await ui.find({ type: 'Text', text: '1 dismissed' })).toBeDefined()

  await start($)
  await w.clock.settle()
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeUndefined()
  expect((await advisor($, 'reset')).text).toBe('🧭 Dismissed mods, the snooze and what was announced are cleared for this project.')
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeDefined()
})

test('How to use shows the README usage; Uninstall runs the CLI in the mod\'s scope and offers to reload', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'how:installed:commit-composer' })
    expect(await ui.find({ type: 'Text', text: 'Type /commit' })).toBeDefined()
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Stage your changes, then type `/commit`.')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/plagemes/claude-mods/blob/main/mods/commit-composer/README.md')
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await mountPane($)
  await ui.press({ key: 'how:project:react-doctor' })
  expect(await ui.find({ type: 'Text', text: 'Or type: /plugin install react-doctor@claude-mods' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The README\'s usage could not be loaded.' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'how:installed:commit-composer' })
  await ui.press({ key: 'uninstall-open' })
  expect(w.calls).toContain('plugin uninstall commit-composer@claude-mods --scope user --json')
  expect(await ui.find({ type: 'Text', text: '✓ Uninstalled commit-composer. Reload plugins to unload it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'not installed' })).toBeDefined()
  await ui.press({ key: 'reload' })
  expect(w.commands).toEqual(['reload-plugins'])
})

test('every surface draws the pane and the usage view; mobile has no search field', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: { ...PANE_PROPS, bodyColumns: 40 } })
    expect(await ui.find({ key: 'search' })).toEqual(surface === 'mobile' ? undefined : expect.objectContaining({ type: 'Input' }))
    expect(await ui.find({ key: 'row:project:next-guard' })).toBeDefined()
    await ui.press({ key: 'how:project:next-guard' })
    expect(await ui.find({ type: 'Text', text: 'No command to type: it works on its own once installed.' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('the search ranks the catalog against what you type', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  expect((await advisor($, 'quanto sto spendendo')).text).toBe('🧭 Opened the Advisor, searching for "quanto sto spendendo".')
  const ui = await mountPane($)
  expect((await ui.findAll({ type: 'Box' })).map(found => found.key).filter(key => key?.startsWith('row:search:')).slice(0, 2))
    .toEqual(['row:search:daily-spend', 'row:search:cloud-cost-warn'])
  await ui.input({ key: 'search', text: 'docker', kind: 'change' })
  expect(await ui.find({ key: 'row:search:docker-lint' })).toBeDefined()
  await ui.input({ key: 'search', text: '' })
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeDefined()
})

test('/mods-advisor why explains a score; refresh reports; quiet mutes the tips', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await ask($, 'deploy to production please')
  await w.clock.settle()
  const why = (await advisor($, 'why deploy-checklist')).text ?? ''
  expect(why).toContain('🧭 deploy-checklist: Shows a pre-deploy checklist')
  expect(why).toContain('Status: not installed. Judged by its description (the catalog gives it no signals).')
  expect(why).toContain('Project: Next.js, React, Prisma, TypeScript, Node.js.')
  expect(why).toContain('Recent prompts: score 15.9 — words: "deploy"')
  expect(why).toContain('Commands: none, it works on its own once installed.')
  expect((await advisor($, 'why next-guard')).text).toMatch(/Project fit: score 6\.5 — Next\.js · uses next; React · uses react\./)
  expect((await advisor($, 'why nope')).text).toBe('✗ There is no mod named nope in the catalog.')

  expect((await advisor($, 'refresh')).text).toBe('🧭 202 mods in the catalog 2.0.0, 1 installed; 8 mods fit this project (Next.js, Prisma, React, TypeScript).')

  expect((await advisor($, 'quiet on')).text).toBe('🧭 Quiet: no tips, toasts or band until /mods-advisor quiet off.')
  await ask($, 'write a commit message')
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.store.get('quiet')).toBe(true)
  expect((await advisor($, 'quiet')).text).toBe('🧭 Tips are back on.')
  expect((await advisor($, 'quiet maybe')).text).toContain('✗ /mods-advisor quiet takes on or off.')
})

test('offline it falls back to the cached catalog, then to the marketplace\'s local copy, and otherwise stays silent', async ($, on) => {
  const cached = { version: '1.9.0', repository: 'plagemes/claude-mods', branch: 'main', fetchedAt: NOW - 20 * 60 * MINUTE, origin: 'github', categories: [], mods: CATALOG_MODS }
  const w = world(on, { isOnline: false, store: { catalog: cached } })
  await start($)
  await w.clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '● Offline · catalog from 20 h ago' })).toBeDefined()
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeDefined()
  expect((await advisor($, 'refresh')).text).toContain('Offline (getaddrinfo ENOTFOUND raw.githubusercontent.com): catalog from 20 h ago.')
})

test('with no cache it reads the marketplace already on disk', async ($, on) => {
  const w = world(on, {
    isOnline: false,
    marketplaces: [{ name: 'claude-mods', repo: 'plagemes/claude-mods', installLocation: '/mp/claude-mods' }],
    extraFiles: { '/mp/claude-mods/catalog.json': JSON.stringify(CATALOG) },
  })
  await start($)
  await w.clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ key: 'row:project:next-guard' })).toBeDefined()
  expect(w.toasts).toEqual([])
})

test('with no network, no cache and no marketplace the pane says so and nothing else happens', async ($, on) => {
  const w = world(on, { isOnline: false, marketplaces: [] })
  await start($)
  await w.clock.settle()
  await ask($, 'write a commit message')
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.contexts).toEqual([undefined])
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: '✗ No catalog: getaddrinfo ENOTFOUND raw.githubusercontent.com' })).toBeDefined()
    expect(await ui.find({ key: 'retry' })).toBeDefined()
    await ui.unmount()
  }
})

test('with useModel a small model re-ranks the matches in the background', { options: { useModel: true } }, async ($, on) => {
  const w = world(on, { model: 'docker-lint' })
  await start($)
  await w.clock.settle()
  await ask($, 'the docker build is failing')
  await w.clock.settle()
  expect(w.models).toEqual(['haiku'])
  expect(w.toasts).toEqual([expect.stringMatching(/^🧭 docker-lint would help here/)])
  const ui = await mountPane($)
  expect(await ui.find({ key: 'row:new:docker-lint' })).toBeDefined()
  expect(await ui.find({ key: 'row:now:docker-prune-guard' })).toBeUndefined()
})

test('tellClaude off keeps the note out of the prompt', { options: { tellClaude: false, autoOpen: false } }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  expect(w.pane.opens).toEqual([])
  await ask($, 'write a commit message')
  await w.clock.settle()
  expect(w.contexts).toEqual([undefined])
  expect(w.toasts).toHaveLength(1)
})

const HUB_PANE_PROPS: RenderPropsOf['Pane'] = { ...PANE_PROPS, title: 'Claude Mods' }

test('with mods-hub: the Advisor is the first tab of the shared panel, opened at start instead of its own pane', async ($, on) => {
  const w = world(on)
  const hub = fakeHub(on, {}, w.clock)
  await start($)
  await w.clock.settle()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['mod.recommended'], consumes: ['mod.installed', 'test.result', 'ci.result'] }])
  expect(hub.tabs).toEqual([{ id: 'advisor', title: 'Advisor', order: 10, command: 'mods-advisor' }])
  expect(hub.shown).toEqual(['advisor'])
  expect(w.pane.opens).toEqual([])
  expect(hub.facts.get('stack')).toEqual({ root: ROOT, stack: ['Next.js', 'Prisma', 'React', 'TypeScript'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: HUB_PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '🧭 Advisor' })).toBeDefined()
    expect(await ui.find({ key: 'install:project:next-guard' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.unmount()
  }
  expect((await advisor($)).text).toBe('🧭 Opened the Advisor.')
  expect(hub.shown).toEqual(['advisor', 'advisor'])
})

test('with mods-hub: failing tests on the bus bring the test mods, published as mod.recommended and told through the hub', async ($, on) => {
  const w = world(on)
  const hub = fakeHub(on, {}, w.clock)
  await start($)
  await w.clock.settle()
  const lists = w.calls.filter(call => call === 'plugin list --json').length

  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 10, failed: 2 }, at: NOW + 1, source: 'test-watch' })
  hub.events.push({ topic: 'mod.installed', data: { name: 'secret-shield', version: '1.0.0' }, at: NOW + 2, source: 'mod-store' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.settle()

  expect(w.calls.filter(call => call === 'plugin list --json').length).toBe(lists + 1)
  const recommended = hub.published.filter(event => event.topic === 'mod.recommended').map(event => event.data)
  expect(recommended.length).toBeGreaterThan(0)
  expect(recommended.every(data => (data as { reason: string }).reason === '2 tests failed')).toBe(true)
  expect(hub.notified.at(-1)).toMatchObject({ level: 'info', audience: 'terminal', topic: 'mod.recommended' })
  expect(hub.notified.at(-1)?.title).toMatch(/^🧭 /)
  expect(w.toasts).toEqual([])

  // The same events are not read twice.
  const published = hub.published.length
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await w.clock.settle()
  expect(hub.published.length).toBe(published)
})

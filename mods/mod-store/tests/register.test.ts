import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'mod-store'
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const RAW = 'https://raw.githubusercontent.com/plagemes/claude-mods/main/'
const BIN = '/opt/claude-code/bin/claude'

const MARKETPLACE = {
  name: 'claude-mods',
  owner: { name: 'Plagemes' },
  plugins: [
    { name: 'mod-store', source: './mods/mod-store', description: 'An in-terminal app store.', version: '1.0.0', category: 'core', keywords: ['store'] },
    { name: 'secret-shield', source: './mods/secret-shield', description: 'Blocks reads of .env files and other secrets.', version: '1.2.0', category: 'security', keywords: ['secrets', 'guard'] },
    { name: 'rm-rf-guard', source: './mods/rm-rf-guard', description: 'Stops recursive deletes outside the project.', version: '1.0.0', category: 'security', keywords: ['shell', 'guard'] },
    { name: 'git-status-line', source: './mods/git-status-line', description: 'Branch and dirty count in the status line.', version: '2.0.0', category: 'git', keywords: ['git'] },
    { name: 'branch-namer', source: './mods/branch-namer', description: 'Suggests branch names.', version: '1.0.0', category: 'git', keywords: ['git'] },
    { name: 'cost-meter', source: './mods/cost-meter', description: 'Live session cost in the status line.', version: '1.1.0', category: 'cost', keywords: ['tokens'] },
  ],
}

const CATALOG = {
  categories: [
    { id: 'core', title: 'Core', tagline: 'The mod store and essentials.' },
    { id: 'security', title: 'Security & Guardrails', tagline: 'Stop dangerous actions before they happen.' },
    { id: 'git', title: 'Git & Versioning', tagline: 'Branches, commits and PRs without friction.' },
    { id: 'cost', title: 'Cost, Tokens & Context', tagline: 'Know what every turn costs.' },
  ],
  mods: [{ name: 'cost-meter', category: 'cost', tier: 'simple' }],
}

const FILES: Record<string, string> = {
  '.claude-plugin/marketplace.json': JSON.stringify(MARKETPLACE),
  'catalog.json': JSON.stringify(CATALOG),
  'mods/cost-meter/README.md': '# cost-meter\n> Live session cost.\n\n## What it does\nShows the **cost** of the session.\n',
}

/** Types `/mods <args>` at the prompt of a fullscreen terminal. */
const mods = ($: Engine, args = '') =>
  $.command.run({ command: 'mods', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

type Install = { version: string; scope: string; enabled: boolean }
type WorldOptions = {
  isOnline?: boolean
  installed?: Record<string, Install>
  marketplaces?: string[]
  store?: Record<string, unknown>
  isPlaced?: boolean
  copies?: boolean
  listFails?: boolean
}

/** Stands for everything beneath the plugin: GitHub, the claude CLI, the surface. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
  mock.env(on, { CLAUDE_CODE_EXECPATH: BIN })
  const net = { isOnline: options.isOnline ?? true }
  const installed = new Map(Object.entries(options.installed ?? {}))
  const marketplaces = [...(options.marketplaces ?? ['claude-mods'])]
  const calls: string[] = []
  const fetched: string[] = []
  const toasts: string[] = []
  const commands: string[] = []
  const latest = new Map(MARKETPLACE.plugins.map(plugin => [plugin.name, plugin.version]))
  const json = (value: unknown) => JSON.stringify(value)
  const result = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('ui.open', () => ({
    value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface places panes' } : { isPlaced: true as const },
  }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({
    value: options.copies === false ? { isCopied: false as const, reason: 'no-clipboard' as const } : { isCopied: true as const },
  }))
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    if (!net.isOnline) {
      return { deny: 'getaddrinfo ENOTFOUND raw.githubusercontent.com' }
    }
    const body = FILES[e.url.replace(RAW, '')]
    return {
      value: body === undefined
        ? { status: 404, ok: false, headers: {}, text: '404: Not Found' }
        : { status: 200, ok: true, headers: {}, text: body },
    }
  })
  on('process.run', ($, e) => {
    const [bin = '', ...args] = e.argv
    expect(bin).toBe(BIN)
    calls.push(args.join(' '))
    const [, verb, target = ''] = args
    const name = target.split('@')[0] ?? ''
    if (args.join(' ') === 'plugin list --json') {
      if (options.listFails === true) {
        return { deny: 'spawn claude ENOENT' }
      }
      return result(json([...installed].map(([id, one]) => ({ id: `${id}@claude-mods`, ...one }))))
    }
    if (args.join(' ') === 'plugin marketplace list --json') {
      return result(json(marketplaces.map(market => ({ name: market, source: 'github' }))))
    }
    if (verb === 'marketplace' && args[2] === 'add') {
      marketplaces.push('claude-mods')
      return result(json({ command: 'marketplace-add', outcome: 'ok', marketplace: 'claude-mods', message: 'Added' }))
    }
    if (verb === 'marketplace') {
      return result(json({ command: 'marketplace-update', outcome: 'ok', message: 'Updated' }))
    }
    if (verb === 'install') {
      installed.set(name, { version: latest.get(name) ?? '1.0.0', scope: 'user', enabled: true })
      return result(json({ command: 'install', outcome: 'ok', message: `Installed ${name}` }))
    }
    if (verb === 'update') {
      const before = installed.get(name)?.version ?? ''
      const after = latest.get(name) ?? before
      installed.set(name, { ...(installed.get(name) ?? { scope: 'user', enabled: true }), version: after })
      return result(json({ command: 'update', outcome: 'ok', message: 'ok', updateOutcome: 'updated', oldVersion: before, newVersion: after }))
    }
    if (verb === 'uninstall') {
      installed.delete(name)
      return result(json({ command: 'uninstall', outcome: 'ok', message: `Uninstalled ${name}` }))
    }
    return result(json({ outcome: 'failed', message: 'unknown command' }), 1)
  })

  return { clock, net, installed, calls, fetched, toasts, commands }
}

const pane = (bodyRows = 40, bodyColumns = 100) => ({
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'mod-store',
  props: {
    title: 'Mod Store',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

const OUTDATED = {
  'secret-shield': { version: '1.0.0', scope: 'user', enabled: true },
  'git-status-line': { version: '2.0.0', scope: 'project', enabled: true },
}

test('/mods opens the store and draws the catalog with installed and update badges', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const opened = await mods($)
  await w.clock.settle()
  expect(opened.text).toBe('◆ Opened the mod store.')
  expect(w.fetched).toContain(`${RAW}.claude-plugin/marketplace.json`)
  expect(w.calls).toContain('plugin list --json')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: '◆ Claude Mods' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6 mods · 2 installed · 1 update' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /plagemes\/claude-mods@main · synced just now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Security & Guardrails$/ })).toBeDefined()
    expect((await ui.find({ key: 'row:secret-shield' }))?.text).toContain('↑ 1.2.0')
    expect((await ui.find({ key: 'row:git-status-line' }))?.text).toContain('✓ installed')
    expect((await ui.find({ key: 'row:cost-meter' }))?.text).toContain('v1.1.0')
    expect((await ui.find({ key: 'open:mod-store' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true, plain: true })
    expect(await ui.find({ key: 'update-all' })).toBeDefined()
    expect(await ui.find({ key: 'search' })).toBeDefined()
    await ui.unmount()
  }
})

test('every surface draws the list and the detail view; mobile has no search fields', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane(40, 50), surface })
    expect(await ui.find({ key: 'search' })).toEqual(surface === 'mobile' ? undefined : expect.objectContaining({ type: 'Input' }))
    expect((await ui.find({ key: 'row:cost-meter' }))?.text).not.toContain('Live session cost')
    await ui.press({ key: 'open:secret-shield' })
    expect(await ui.find({ key: 'update' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('search and the category picker narrow the list, with an empty state', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    await mods($, 'search guard')
    const ui = await $.ui.mount({ ...pane(), surface })
    const rows = async () => (await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('open:'))
    expect(await rows()).toEqual(['open:rm-rf-guard', 'open:secret-shield'])

    await ui.input({ key: 'search', text: 'status line', kind: 'change' })
    expect(await rows()).toEqual(['open:git-status-line', 'open:cost-meter'])

    await ui.input({ key: 'search', text: '' })
    await ui.select({ key: 'filter', value: 'git' })
    expect(await rows()).toEqual(['open:git-status-line', 'open:branch-namer'])
    await ui.select({ key: 'filter', value: '@updates' })
    expect(await rows()).toEqual(['open:secret-shield'])

    await ui.input({ key: 'search', text: 'kubernetes' })
    expect(await ui.find({ type: 'Text', text: 'No mods match “kubernetes”.' })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await rows()).toHaveLength(6)
    await ui.unmount()
  }
})

test('the detail view shows the README, installs with the claude CLI and offers /reload-plugins', async ($, on) => {
  const w = world(on, { marketplaces: [] })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'open:cost-meter' })

  expect(await ui.find({ type: 'Text', text: 'not installed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Cost, Tokens & Context · simple' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/plugin install cost-meter@claude-mods' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('## What it does\nShows the **cost** of the session.')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/plagemes/claude-mods/blob/main/mods/cost-meter/README.md')

  await ui.press({ key: 'install' })
  expect(w.calls).toEqual(expect.arrayContaining([
    'plugin marketplace list --json',
    'plugin marketplace add plagemes/claude-mods --json',
    'plugin install cost-meter@claude-mods --scope user --json',
  ]))
  expect(w.toasts).toContain('✓ Installed cost-meter 1.1.0. Run /reload-plugins to activate it.')
  expect(await ui.find({ type: 'Text', text: /✓ installed 1\.1\.0 \(user\)/ })).toBeDefined()
  expect(await ui.find({ key: 'install' })).toBeUndefined()
  expect(await ui.find({ key: 'uninstall' })).toBeDefined()

  await ui.press({ key: 'reload' })
  expect(w.commands).toEqual(['reload-plugins'])
  expect(await ui.find({ key: 'reload' })).toBeUndefined()

  await ui.press({ key: 'back' })
  expect((await ui.find({ key: 'row:cost-meter' }))?.text).toContain('✓ installed')
})

test('update and uninstall act in the scope the mod is installed in, on both surfaces', async ($, on) => {
  const w = world(on, { installed: { 'secret-shield': { version: '1.0.0', scope: 'project', enabled: true } } })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    w.installed.set('secret-shield', { version: '1.0.0', scope: 'project', enabled: true })
    await mods($, 'refresh')
    const ui = await $.ui.mount({ ...pane(), surface })
    await ui.press({ key: 'open:secret-shield' })
    expect(await ui.find({ type: 'Text', text: '↑ update 1.0.0 → 1.2.0' })).toBeDefined()
    expect((await ui.find({ key: 'update' }))?.props).toMatchObject({ label: 'Update to 1.2.0', hotkey: 'u', variant: 'primary' })

    await ui.press({ key: 'update' })
    expect(w.calls).toContain('plugin update secret-shield@claude-mods --scope project --json')
    expect(await ui.find({ type: 'Text', text: /Updated secret-shield 1\.0\.0 → 1\.2\.0/ })).toBeDefined()

    await ui.press({ key: 'uninstall' })
    expect(w.calls).toContain('plugin uninstall secret-shield@claude-mods --scope project --json')
    expect(await ui.find({ type: 'Text', text: 'not installed' })).toBeDefined()
    expect(w.installed.has('secret-shield')).toBe(false)
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('/mods update-all updates every outdated mod after refreshing the marketplace', async ($, on) => {
  const w = world(on, {
    installed: {
      ...OUTDATED,
      'cost-meter': { version: '1.0.0', scope: 'user', enabled: true },
    },
  })
  const done = await mods($, 'update-all')
  expect(done.text).toBe('✓ Updated secret-shield 1.0.0 → 1.2.0, cost-meter 1.0.0 → 1.1.0. Run /reload-plugins to apply.')
  const marketplaceUpdate = w.calls.indexOf('plugin marketplace update claude-mods --json')
  expect(marketplaceUpdate).toBeGreaterThan(-1)
  expect(w.calls.indexOf('plugin update secret-shield@claude-mods --scope user --json')).toBeGreaterThan(marketplaceUpdate)
  expect(w.calls).not.toContain('plugin update git-status-line@claude-mods --scope project --json')

  const again = await mods($, 'update-all')
  expect(again.text).toBe('• Every installed mod is up to date.')
})

test('/mods install-all installs every mod not yet installed after refreshing the marketplace', async ($, on) => {
  const w = world(on, { installed: OUTDATED, marketplaces: [] })
  const done = await mods($, 'install-all')
  expect(done.text).toBe('✓ Installed 4 mods (mod-store, rm-rf-guard, branch-namer, …). Run /reload-plugins to activate them.')
  expect(w.toasts).toContain(done.text)
  expect(w.calls).toContain('plugin marketplace add plagemes/claude-mods --json')
  const marketplaceUpdate = w.calls.indexOf('plugin marketplace update claude-mods --json')
  expect(marketplaceUpdate).toBeGreaterThan(-1)
  const installs = w.calls.filter(call => call.startsWith('plugin install'))
  expect(installs).toEqual([
    'plugin install mod-store@claude-mods --scope user --json',
    'plugin install rm-rf-guard@claude-mods --scope user --json',
    'plugin install branch-namer@claude-mods --scope user --json',
    'plugin install cost-meter@claude-mods --scope user --json',
  ])
  expect(w.calls.indexOf(installs[0]!)).toBeGreaterThan(marketplaceUpdate)

  const again = await mods($, 'install all')
  expect(again.text).toBe('• Every mod is already installed.')
})

test('the pane installs every mod the list shows that is not installed yet', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect((await ui.find({ key: 'install-all' }))?.props).toMatchObject({ label: 'Install all (4)' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.select({ key: 'filter', value: 'git' })
  expect((await ui.find({ key: 'install-all' }))?.props).toMatchObject({ label: 'Install all (1)' })
  await ui.press({ key: 'install-all' })
  expect(w.calls.filter(call => call.startsWith('plugin install'))).toEqual(['plugin install branch-namer@claude-mods --scope user --json'])
  expect(w.toasts).toContain('✓ Installed 1 mod (branch-namer). Run /reload-plugins to activate it.')
  expect(await ui.find({ key: 'install-all' })).toBeUndefined()
})

test('offline, the store falls back to the cached catalog and says so', async ($, on) => {
  const first = world(on, { installed: OUTDATED })
  await mods($, 'refresh')
  first.net.isOnline = false
  await first.clock.advance(3 * 3_600_000)

  const report = await mods($, 'refresh')
  expect(report.text).toContain('◆ 6 mods in 4 categories, 2 installed, 1 update available.')
  expect(report.text).toContain('Offline (getaddrinfo ENOTFOUND raw.githubusercontent.com): showing the catalog cached 3 h ago.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: /● Offline · catalog cached 3 h ago/ })).toBeDefined()
    expect(await ui.find({ key: 'row:secret-shield' })).toBeDefined()
    await ui.press({ key: 'open:cost-meter' })
    expect(await ui.find({ type: 'Text', text: 'The README could not be loaded while offline.' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a cached catalog from the store draws at once in a new session', async ($, on) => {
  const cached = {
    marketplace: 'claude-mods',
    repository: 'plagemes/claude-mods',
    branch: 'main',
    fetchedAt: NOW - 60_000,
    categories: CATALOG.categories,
    mods: MARKETPLACE.plugins.map(({ source, ...mod }) => ({ ...mod, path: source.slice(2) })),
  }
  const w = world(on, { isOnline: false, store: { catalog: cached } })
  await mods($)
  await w.clock.settle()
  expect(w.fetched).toEqual([])
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /synced 1 min ago/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button', text: /^(mod-store|secret-shield|rm-rf-guard|git-status-line|branch-namer|cost-meter)$/ })).toHaveLength(6)
})

test('with no network and no cache the pane shows the error and a working retry', async ($, on) => {
  const w = world(on, { isOnline: false })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: '✗ Could not load the catalog' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'getaddrinfo ENOTFOUND raw.githubusercontent.com' })).toBeDefined()
    expect((await ui.find({ key: 'retry' }))?.props).toMatchObject({ hotkey: 'r', autoFocus: true })
    await ui.unmount()
  }
  w.net.isOnline = true
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ key: 'row:cost-meter' })).toBeDefined()
})

test('the pane pages long lists and repeats the category heading', async ($, on) => {
  const w = world(on)
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(9), surface })
    const rows = async () => (await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('open:'))
    expect(await ui.find({ type: 'Text', text: 'Page 1/3' })).toBeDefined()
    expect(await ui.find({ key: 'prev' })).toBeUndefined()
    expect(await rows()).toEqual(['open:mod-store', 'open:secret-shield'])
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: 'Page 2/3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(continued)' })).toBeDefined()
    expect(await rows()).toEqual(['open:rm-rf-guard', 'open:git-status-line'])
    expect((await ui.find({ key: 'open:rm-rf-guard' }))?.props).toMatchObject({ hotkey: '1' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: 'Page 3/3' })).toBeDefined()
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: 'Page 1/3' })).toBeDefined()
    await ui.unmount()
  }
})

test('copying the install line toasts, or shows the line where there is no clipboard', async ($, on) => {
  const w = world(on, { copies: false })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  await ui.press({ key: 'open:branch-namer' })
  await ui.press({ key: 'copy-install' })
  expect(await ui.find({ type: 'Text', text: /No clipboard here \(no-clipboard\)\. The install line: \/plugin install branch-namer@claude-mods/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
})

test('a session start registers /mods and toasts new updates only once', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.toasts).toEqual(['↑ 1 mod update available (secret-shield) · /mods update-all'])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
})

test('commands report usage, unknown mods and a pane that could not be placed', async ($, on) => {
  const w = world(on, { isPlaced: false, installed: OUTDATED })
  const usage = await mods($, 'install')
  expect(usage.text).toContain('/mods install needs the name of one mod.')
  const unknown = await mods($, 'install no-such-mod')
  expect(unknown.text).toBe('✗ There is no mod named no-such-mod in plagemes/claude-mods.')
  expect(w.calls.some(call => call.startsWith('plugin install'))).toBe(false)
  const listing = await mods($, 'search guard')
  expect(listing.text).toBe([
    '◆ 2 mods match "guard" (the store pane could not be shown here).',
    '- rm-rf-guard: Stops recursive deletes outside the project.',
    '- secret-shield [update 1.2.0]: Blocks reads of .env files and other secrets.',
  ].join('\n'))
})

test('a repository setting that is not owner/repo is reported instead of fetched', { options: { repository: 'not a repo' } }, async ($, on) => {
  const w = world(on)
  const report = await mods($, 'refresh')
  expect(report.text).toBe('✗ Could not load the catalog: the repository setting "not a repo" is not owner/repo.')
  expect(w.fetched).toEqual([])
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /is not owner\/repo/ })).toBeDefined()
})

test('when the installed mods cannot be read, the store says so instead of counting zero', async ($, on) => {
  const w = world(on, { listFails: true })
  const report = await mods($, 'refresh')
  expect(report.text).toBe('◆ 6 mods in 4 categories, install status unavailable (spawn claude ENOENT).')
  const updated = await mods($, 'update-all')
  expect(updated.text).toBe('✗ Could not read the installed mods: spawn claude ENOENT')
  expect(w.calls.some(call => call.startsWith('plugin update'))).toBe(false)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'install status unknown' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /▲ Install status unavailable/ }))?.props).toMatchObject({ wrap: 'wrap' })
  expect(await ui.find({ type: 'Text', text: /0 installed/ })).toBeUndefined()
})

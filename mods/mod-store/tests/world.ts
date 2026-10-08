// The world beneath the store in tests: GitHub, the claude CLI, the surface, and (for profiles and slims) a small
// file system with a project and transcripts. Shared by register.test.ts and plan.test.ts.
import { expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'


export const PLUGIN = 'mod-store'
export const SURFACES = ['terminal', 'desktop'] as const
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
export const RAW = 'https://raw.githubusercontent.com/plagemes/claude-mods/main/'
export const BIN = '/opt/claude-code/bin/claude'
export const HOME = '/Users/me'

export const MARKETPLACE = {
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

export const CATALOG = {
  categories: [
    { id: 'core', title: 'Core', tagline: 'The mod store and essentials.' },
    { id: 'security', title: 'Security & Guardrails', tagline: 'Stop dangerous actions before they happen.' },
    { id: 'git', title: 'Git & Versioning', tagline: 'Branches, commits and PRs without friction.' },
    { id: 'cost', title: 'Cost, Tokens & Context', tagline: 'Know what every turn costs.' },
  ],
  mods: [{ name: 'cost-meter', category: 'cost', tier: 'simple' }],
}

/** The site's data: catalog.json plus each mod's release and commands. */
export const DATA = {
  ...CATALOG,
  mods: MARKETPLACE.plugins.map(plugin => ({
    name: plugin.name,
    category: plugin.category,
    tier: plugin.name === 'cost-meter' ? 'simple' : 'complex',
    since: plugin.name === 'cost-meter' || plugin.name === 'branch-namer' ? '2.0.0' : '1.0.0',
    commands: plugin.name === 'cost-meter' ? ['/cost'] : [],
  })),
}

export const FILES: Record<string, string> = {
  '.claude-plugin/marketplace.json': JSON.stringify(MARKETPLACE),
  'catalog.json': JSON.stringify(CATALOG),
  'docs/data/mods.json': JSON.stringify(DATA),
  'mods/cost-meter/README.md': '# cost-meter\n> Live session cost.\n\n**Category:** Cost · **Version:** 1.0.0\n\n## What it does\nShows the **cost** of the session.\n\n## Install\n```\n/plugin install cost-meter@claude-mods\n```\n\n## Configuration\n| Key | Default |\n| --- | --- |\n| `currency` | `USD` |\n',
  'mods/cost-meter/.claude-plugin/plugin.json': JSON.stringify({
    name: 'cost-meter',
    userConfig: { currency: { type: 'string', description: 'Shown after the amount.', default: 'USD' } },
  }),
}

/** Types `/mods <args>` at the prompt of a fullscreen terminal. */
export const mods = ($: Engine, args = '') =>
  $.command.run({ command: 'mods', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

export type Install = { version: string; scope: string; enabled: boolean; installedAt?: string }
/** A file of the fake file system: its text, and when it was last written. */
export type FakeFile = { text: string; mtimeMs?: number }
export type WorldOptions = {
  isOnline?: boolean
  installed?: Record<string, Install>
  marketplaces?: string[]
  store?: Record<string, unknown>
  isPlaced?: boolean
  copies?: boolean
  listFails?: boolean
  /** Each `claude plugin install` / `update` takes this long on the mocked clock (a slow CLI). */
  slowMs?: number
  /** Mods whose install the CLI refuses, and mods whose install cannot even start. */
  refuses?: string[]
  crashes?: string[]
  /** The marketplace served, when not the default one. */
  plugins?: typeof MARKETPLACE.plugins
  /** The desktop app: no CLAUDE_CODE_EXECPATH, its environment, its folders by path, and the engine version. */
  desktop?: { env: Record<string, string>; folders: Record<string, { name: string; kind: 'file' | 'dir' }[]>; version: string; bin: string }
  /** The site's data served, when not the default one (packs, signals). */
  data?: unknown
  /** A file system by absolute path (folders are implied); the project root is PROJECT. */
  files?: Record<string, string | FakeFile>
  /** What any other file read answers (the store's own manifest, for its version). */
  anyRead?: string
  /** More environment variables (HOME, CLAUDE_CONFIG_DIR). */
  env?: Record<string, string>
}

/** The project the session runs in, and where its transcripts and local settings live in the fake file system. */
export const PROJECT = '/work/app'
export const CONFIG = `${HOME}/.claude`
export const LOCAL_SETTINGS = `${PROJECT}/.claude/settings.local.json`
export const TRANSCRIPTS = `${CONFIG}/projects/-work-app`

/** Stands for everything beneath the plugin: GitHub, the claude CLI, the surface. */
export function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
  const bin = options.desktop?.bin ?? BIN
  mock.env(on, { ...(options.desktop === undefined ? { CLAUDE_CODE_EXECPATH: BIN } : options.desktop.env), ...options.env })
  const files = new Map(Object.entries(options.files ?? {}).map(([path, file]) => [path, typeof file === 'string' ? { text: file } : file]))
  const writes: string[] = []
  const folders = options.desktop?.folders ?? {}
  if (options.desktop !== undefined) {
    const { version } = options.desktop
    on('session.version', () => ({ value: { version } }))
  }
  on('session.root', () => ({ value: PROJECT }))
  on('fs.list', ($, e) => {
    const path = e.path ?? ''
    const desktop = folders[path]
    if (desktop !== undefined) return { value: desktop.map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })) }
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [file, { text, mtimeMs = NOW }] of files) {
      if (!file.startsWith(`${path}/`)) continue
      const [name = '', ...below] = file.slice(path.length + 1).split('/')
      entries.set(name, below.length === 0
        ? { name, kind: 'file', size: text.length, mtimeMs, isLink: false }
        : { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }
    return entries.size === 0 ? { deny: `ENOENT: ${path}` } : { value: [...entries.values()] }
  })
  on('fs.read', ($, e) => {
    const file = files.get(e.path)
    return file !== undefined ? { value: file.text }
      : options.anyRead !== undefined ? { value: options.anyRead }
      : { deny: `ENOENT: no such file ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(file => file.startsWith(`${e.path}/`)) }))
  on('fs.write', ($, e) => {
    writes.push(e.path)
    files.set(e.path, { text: e.text })
    return { value: undefined }
  })
  /** What this project's settings.local.json turns on or off, as `claude plugin list` reports it from the project. */
  const localEnabled = (id: string): boolean | undefined => {
    try {
      const value = (JSON.parse(files.get(LOCAL_SETTINGS)?.text ?? '{}') as { enabledPlugins?: Record<string, unknown> }).enabledPlugins?.[id]
      return typeof value === 'boolean' ? value : undefined
    } catch {
      return undefined
    }
  }
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
    const path = e.url.replace(RAW, '')
    const body = path === '.claude-plugin/marketplace.json' && options.plugins !== undefined
      ? JSON.stringify({ ...MARKETPLACE, plugins: options.plugins })
      : path === 'docs/data/mods.json' && options.data !== undefined ? JSON.stringify(options.data)
    : FILES[path]
    return {
      value: body === undefined
        ? { status: 404, ok: false, headers: {}, text: '404: Not Found' }
        : { status: 200, ok: true, headers: {}, text: body },
    }
  })
  on('process.run', async ($, e) => {
    const [bin0 = '', ...args] = e.argv
    if (bin0 === 'tail') {
      calls.push(e.argv.join(' '))
      const text = files.get(args[2] ?? '')?.text
      return text === undefined ? { deny: 'tail: no such file' } : result(text.slice(-Number(args[1])))
    }
    expect(bin0).toBe(bin)
    calls.push(args.join(' '))
    const [, verb, target = ''] = args
    const name = target.split('@')[0] ?? ''
    if (args.join(' ') === 'plugin list --json') {
      if (options.listFails === true) {
        return { deny: 'spawn claude ENOENT' }
      }
      return result(json([...installed].map(([id, one]) => ({ id: `${id}@claude-mods`, ...one, enabled: localEnabled(`${id}@claude-mods`) ?? one.enabled }))))
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
    if ((verb === 'install' || verb === 'update') && options.slowMs !== undefined) {
      await clock.sleep(options.slowMs)
    }
    if (verb === 'install' && options.crashes?.includes(name) === true) {
      return { deny: 'spawn claude EAGAIN' }
    }
    if (verb === 'install' && options.refuses?.includes(name) === true) {
      return result(json({ command: 'install', outcome: 'failed', message: `Plugin ${name} failed validation` }), 1)
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
    if ((verb === 'disable' || verb === 'enable') && installed.has(name)) {
      const one = installed.get(name)
      if (one !== undefined) installed.set(name, { ...one, enabled: verb === 'enable' })
      return result(json({ command: verb, outcome: 'ok', message: `${verb}d ${name}` }))
    }
    if (verb === 'uninstall') {
      installed.delete(name)
      return result(json({ command: 'uninstall', outcome: 'ok', message: `Uninstalled ${name}` }))
    }
    return result(json({ outcome: 'failed', message: 'unknown command' }), 1)
  })

  const fileText = (path: string): string | undefined => files.get(path)?.text

  return { clock, net, installed, calls, fetched, toasts, commands, writes, fileText }
}

export const pane = (bodyRows = 40, bodyColumns = 100) => ({
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

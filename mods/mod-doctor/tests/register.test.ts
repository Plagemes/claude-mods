import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'mod-doctor'
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 7, 12)
const BIN = '/opt/claude-code/bin/claude'
const RAW = 'https://raw.githubusercontent.com/plagemes/claude-mods/main/.claude-plugin/marketplace.json'
const LOCAL_MARKET = '/home/me/.claude/plugins/marketplaces/claude-mods'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Mod Doctor',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type Install = { version: string; scope: string; enabled: boolean }

const validation = (notes: string[], errors: string[] = []): string =>
  JSON.stringify({
    success: errors.length === 0,
    manifest: { errors: [], warnings: [], notes: [] },
    contents: [{ errors: errors.map(message => ({ path: 'modules', message })), warnings: [], notes }],
  })

const NOTES: Record<string, string> = {
  'secret-shield': validation(['./register.ts hooks: tool.call{tool=Edit|Write}']),
  'broken-thing': validation([], ['broken-thing: hooks/register.ts does not parse: Unexpected ; (line 1, column 79)']),
  celebrate: validation(['./register.ts hooks: tool.call{tool=Bash}']),
  'mod-doctor': validation(['./register.tsx answers its own command: command.run{command=mod-doctor}']),
}

type WorldOptions = { isOnline?: boolean; isPlaced?: boolean; store?: Record<string, unknown>; debugLog?: string }

/** Stands for the claude CLI, GitHub, the disk and the surface beneath the plugin. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
  mock.env(on, { CLAUDE_CODE_EXECPATH: BIN, HOME: '/home/me' })
  const installed = new Map<string, Install>([
    ['secret-shield', { version: '1.0.0', scope: 'user', enabled: true }],
    ['broken-thing', { version: '1.0.0', scope: 'user', enabled: true }],
    ['celebrate', { version: '1.0.0', scope: 'project', enabled: false }],
    ['mod-doctor', { version: '1.0.0', scope: 'user', enabled: true }],
  ])
  const latest: Record<string, string> = { 'secret-shield': '1.2.0', 'broken-thing': '1.0.0', celebrate: '1.0.0', 'mod-doctor': '1.0.0' }
  const calls: string[] = []
  const toasts: string[] = []
  const commands: string[] = []
  const out = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  const files: Record<string, string> = {
    [`${LOCAL_MARKET}/.claude-plugin/marketplace.json`]: JSON.stringify({
      name: 'claude-mods',
      plugins: Object.keys(latest).map(name => ({ name, version: name === 'secret-shield' ? '1.1.0' : latest[name] })),
    }),
    ...(options.debugLog === undefined ? {} : { '/home/me/.claude/debug/session-1.txt': options.debugLog }),
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [{ name: 'help', description: 'Help', source: 'builtin' as const }] }))
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('ui.open', () => ({
    value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no surface places panes' } : { isPlaced: true as const },
  }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) =>
    options.isOnline === false || e.url !== RAW
      ? { deny: 'getaddrinfo ENOTFOUND raw.githubusercontent.com' }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'claude-mods', plugins: Object.entries(latest).map(([name, version]) => ({ name, version })) }) } },
  )
  on('fs.exists', ($, e) => ({ value: files[e.path] !== undefined }))
  on('fs.stat', ($, e) =>
    files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: NOW, isLink: false } },
  )
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: `ENOENT: ${e.path}` } : { value: files[e.path] ?? '' }))
  on('process.run', ($, e) => {
    const [bin = '', ...args] = e.argv
    expect(bin).toBe(BIN)
    const line = args.join(' ')
    calls.push(line)
    if (line === 'plugin list --json') {
      return out(JSON.stringify([...installed].map(([name, one]) => ({ id: `${name}@claude-mods`, installPath: `/cache/${name}`, ...one }))))
    }
    if (line === 'plugin marketplace list --json') return out(JSON.stringify([{ name: 'claude-mods', source: 'github', installLocation: LOCAL_MARKET }]))
    if (args[1] === 'validate') return out(NOTES[(args[2] ?? '').replace('/cache/', '')] ?? validation([]), 0)
    if (args[1] === 'marketplace') return out(JSON.stringify({ outcome: 'ok', message: 'Updated' }))
    const name = (args[2] ?? '').split('@')[0] ?? ''
    const one = installed.get(name)
    if (one === undefined) return out(JSON.stringify({ outcome: 'failed', message: `Plugin "${name}" not found` }), 1)
    if (args[1] === 'update') {
      const before = one.version
      one.version = latest[name] ?? before
      return out(JSON.stringify({ outcome: 'ok', message: 'ok', updateOutcome: 'updated', oldVersion: before, newVersion: one.version }))
    }
    if (args[1] === 'enable' || args[1] === 'disable') {
      one.enabled = args[1] === 'enable'
      return out(JSON.stringify({ outcome: 'ok', message: `Successfully ${args[1]}d plugin: ${name}` }))
    }
    return out(JSON.stringify({ outcome: 'failed', message: 'unknown' }), 1)
  })

  return { clock, installed, calls, toasts, commands }
}

const doctor = ($: Engine, args = '') =>
  $.command.run({ command: 'mod-doctor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('/mod-doctor checks every plugin in the background and lists the findings in the pane', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect((await doctor($)).text).toBe('🩺 Checking your mods in the Mod Doctor pane.')
  await w.clock.settle()
  expect(w.calls).toEqual(expect.arrayContaining([
    'plugin list --json',
    'plugin validate /cache/secret-shield --json',
    'plugin validate /cache/broken-thing --json',
    'plugin validate /cache/celebrate --json',
  ]))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })
    expect(await ui.find({ type: 'Text', text: '🩺 Mod Doctor' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4 plugins · 1 error · 1 warning · 1 note' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Catalog plagemes\/claude-mods@main, fetched just now/ })).toBeDefined()
    expect((await ui.find({ key: 'finding:load:broken-thing@claude-mods' }))?.text).toContain('hooks/register.ts does not parse')
    expect((await ui.find({ key: 'finding:outdated:secret-shield@claude-mods' }))?.text).toContain('secret-shield 1.0.0 → 1.2.0 available')
    expect(await ui.find({ key: 'fix:outdated:secret-shield@claude-mods:update:secret-shield@claude-mods' })).toBeDefined()
    expect(await ui.find({ key: 'fix:disabled:celebrate@claude-mods:enable:celebrate@claude-mods' })).toBeDefined()
    expect(await ui.find({ key: 'update-all' })).toMatchObject({ props: { label: 'Update all (1)' } })
    await ui.unmount()
  }
})

test('a fix runs the CLI, offers /reload-plugins and checks again', async ($, on) => {
  const w = world(on)
  await doctor($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })

  await ui.press({ key: 'fix:outdated:secret-shield@claude-mods:update:secret-shield@claude-mods' })
  expect(w.calls).toEqual(expect.arrayContaining(['plugin marketplace update claude-mods --json', 'plugin update secret-shield@claude-mods --scope user --json']))
  expect(w.toasts).toEqual(['✓ Updated secret-shield 1.0.0 → 1.2.0. Run /reload-plugins to apply.'])
  expect(await ui.find({ key: 'finding:outdated:secret-shield@claude-mods' })).toBeUndefined()
  expect(await ui.find({ key: 'update-all' })).toBeUndefined()

  await ui.press({ key: 'fix:disabled:celebrate@claude-mods:enable:celebrate@claude-mods' })
  expect(w.calls).toContain('plugin enable celebrate@claude-mods --scope project --json')
  expect(w.installed.get('celebrate')?.enabled).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Enabled celebrate\. Run \/reload-plugins to apply\./ })).toBeDefined()

  await ui.press({ key: 'reload' })
  expect(w.commands).toEqual(['reload-plugins'])
  expect(await ui.find({ key: 'reload' })).toBeUndefined()
  await ui.unmount()
})

test('/mod-doctor report prints the findings with the CLI fix for each, offline from the local catalog', async ($, on) => {
  const log = '2026-10-07T11:00:00Z [DEBUG] secret-shield: tool.call hook skipped: TypeError (31 chars)\n'
  world(on, { isOnline: false, debugLog: log })
  const text = (await doctor($, 'report')).text ?? ''

  expect(text).toStartWith('🩺 Mod Doctor: 4 plugins (3 enabled) · 1 error · 2 warnings · 1 note')
  expect(text).toContain('✗ broken-thing fails to load\n    broken-thing: hooks/register.ts does not parse: Unexpected ; (line 1, column 79)\n    Fix: claude plugin disable broken-thing@claude-mods --scope user')
  expect(text).toContain('▲ secret-shield 1.0.0 → 1.1.0 available')
  expect(text).toContain('▲ secret-shield reported problems this session\n    tool.call hook skipped: TypeError (31 chars)')
  expect(text).toContain('• celebrate is disabled\n    Fix: claude plugin enable celebrate@claude-mods --scope project')
  expect(text).toEndWith('Offline (getaddrinfo ENOTFOUND raw.githubusercontent.com): versions from your local copy of claude-mods')
})

test('offline with a cached catalog, and without a pane, the report still compares against GitHub', async ($, on) => {
  const cached = { repository: 'plagemes/claude-mods', branch: 'main', fetchedAt: NOW - 3 * 3_600_000, marketplace: 'claude-mods', versions: { 'secret-shield': '1.3.0' } }
  world(on, { isOnline: false, isPlaced: false, store: { catalog: cached } })
  const text = (await doctor($)).text ?? ''
  expect(text).toContain('▲ secret-shield 1.0.0 → 1.3.0 available')
  expect(text).toContain('• broken-thing is no longer in the claude-mods catalog')
  expect(text).toEndWith('Offline (getaddrinfo ENOTFOUND raw.githubusercontent.com): catalog plagemes/claude-mods@main as cached 3 h ago')
})

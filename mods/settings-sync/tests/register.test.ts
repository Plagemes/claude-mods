import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { applyChanges, applyHubChanges, exportableOptions, looksSecret, parseExport, planHubImport, planImport, portableHubPrefs, stamp } from '../hooks/sync'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const HOME = '/home/ana'
const SETTINGS = `${HOME}/.claude/settings.json`
const EXPORT = `${HOME}/claude-mods-settings.json`
const NOW = Date.UTC(2026, 9, 7, 12, 30, 5)

const settingsOf = (extra: Record<string, unknown> = {}) => ({
  theme: 'dark',
  enabledPlugins: { 'done-chime@claude-mods': true, 'token-budget@claude-mods': true, 'focus-timer@claude-mods': false, 'other@elsewhere': true },
  pluginConfigs: {
    'done-chime@claude-mods': { options: { seconds: 30, volume: 0.5 } },
    'token-budget@claude-mods': { options: { budgetTokens: 500000, showTokens: true, apiToken: 'sk-private' } },
    'focus-timer@claude-mods': { options: { minutes: 50 } },
    'other@elsewhere': { options: { color: 'red' } },
    unknown: { options: { x: 1 } },
  },
  ...extra,
})

/** A home folder on a virtual disk (path → text). Settings-sync sees the engine's file system, env and clock. */
const world = (on: On, files: Map<string, string>, writes: string[] = []) => {
  startClock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return files
}

const run = ($: Engine, command: 'mods-export' | 'mods-import', args: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 80 } })

const json = (files: Map<string, string>, path: string): Record<string, any> => JSON.parse(files.get(path) ?? 'null')

test('/mods-export writes the options of the installed claude-mods plugins, leaving out secrets and other plugins', async ($, on) => {
  const files = world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())]]))

  const shown = await run($, 'mods-export', '')

  expect(shown.text).toBe(
    [
      `Exported 5 settings of 3 mods to ${EXPORT}.`,
      'Left out because they look like secrets: token-budget.apiToken.',
      `On another machine: /mods-import ${EXPORT}`,
    ].join('\n'),
  )
  expect(json(files, EXPORT)).toEqual({
    format: 'claude-mods-settings',
    version: 1,
    exportedAt: '2026-10-07T12:30:05.000Z',
    marketplace: 'claude-mods',
    pluginConfigs: {
      'done-chime': { options: { seconds: 30, volume: 0.5 } },
      'token-budget': { options: { budgetTokens: 500000, showTokens: true } },
      'focus-timer': { options: { minutes: 50 } },
    },
  })
  expect(files.get(EXPORT)).not.toContain('sk-private')
})

test('/mods-export takes a path, and says so when there is nothing to export', async ($, on) => {
  const files = world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())]]))

  await run($, 'mods-export', '"~/backup dir/mods.json"')
  expect(files.has(`${HOME}/backup dir/mods.json`)).toBe(true)

  files.set(SETTINGS, JSON.stringify({ theme: 'dark' }))
  const empty = await run($, 'mods-export', '')
  expect(empty.text).toContain('No settings to export')
  expect(empty.text).toContain('claude-mods marketplace')
})

test('/mods-export reports a missing or broken settings file instead of failing', async ($, on) => {
  const files = world(on, new Map())

  expect((await run($, 'mods-export', '')).text).toBe(`Nothing exported: ${SETTINGS} does not exist.`)

  files.set(SETTINGS, '{ not json')
  expect((await run($, 'mods-export', '')).text).toBe(`Nothing exported: ${SETTINGS} could not be read as JSON.`)
})

const EXPORTED = JSON.stringify({
  format: 'claude-mods-settings',
  version: 1,
  exportedAt: '2026-09-30T08:00:00.000Z',
  marketplace: 'claude-mods',
  pluginConfigs: {
    'done-chime': { options: { seconds: 45, volume: 0.5 } },
    'token-budget': { options: { budgetTokens: 750000 } },
    'new-mod': { options: { mode: 'strict' } },
  },
})

test('/mods-import shows what would change and changes nothing without --yes', async ($, on) => {
  const writes: string[] = []
  world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [EXPORT, EXPORTED]]), writes)

  const shown = await run($, 'mods-import', EXPORT)

  expect(writes).toEqual([])
  expect(shown.text).toBe(
    [
      `3 changes from ${EXPORT} (exported 2026-09-30):`,
      '  done-chime.seconds: 30 → 45',
      '  token-budget.budgetTokens: 500000 → 750000',
      '  new-mod.mode: (not set) → "strict"',
      '1 setting already matches.',
      'Not installed here yet, so they take effect once you install them: new-mod.',
      `Nothing has been changed. To apply, run: /mods-import ${EXPORT} --yes (your settings.json is backed up first).`,
    ].join('\n'),
  )
})

test('/mods-import --yes backs settings.json up first, merges, and keeps everything else', async ($, on) => {
  const original = JSON.stringify(settingsOf())
  const writes: string[] = []
  const files = world(on, new Map([[SETTINGS, original], [EXPORT, EXPORTED]]), writes)

  const shown = await run($, 'mods-import', `${EXPORT} --yes`)

  const backup = `${SETTINGS}.bak-20261007-123005`
  expect(writes).toEqual([backup, SETTINGS]) // the backup comes first
  expect(files.get(backup)).toBe(original)
  expect(shown.text).toContain('Applied 3 changes')
  expect(shown.text).toContain(`Backup: ${backup}`)
  expect(shown.text).toContain('/reload-plugins')

  const merged = json(files, SETTINGS)
  expect(merged.theme).toBe('dark')
  expect(merged.enabledPlugins['other@elsewhere']).toBe(true)
  expect(merged.pluginConfigs['done-chime@claude-mods'].options).toEqual({ seconds: 45, volume: 0.5 })
  expect(merged.pluginConfigs['token-budget@claude-mods'].options).toEqual({ budgetTokens: 750000, showTokens: true, apiToken: 'sk-private' })
  expect(merged.pluginConfigs['new-mod@claude-mods']).toEqual({ options: { mode: 'strict' } })
  expect(merged.pluginConfigs['other@elsewhere']).toEqual({ options: { color: 'red' } })
  expect(files.get(SETTINGS)?.endsWith('}\n')).toBe(true)
})

test('--yes counts only when the person typed it', async ($, on) => {
  const writes: string[] = []
  world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [EXPORT, EXPORTED]]), writes)

  const fromModel = await run($, 'mods-import', `${EXPORT} --yes`, { kind: 'unclassified' })
  const fromPlugin = await run($, 'mods-import', `${EXPORT} -y`, { kind: 'plugin', name: 'other' })

  expect(writes).toEqual([])
  expect(fromModel.text).toContain('Not applied: --yes has to come from you')
  expect(fromPlugin.text).toContain('Not applied')
})

test('/mods-import creates settings.json when there is none, with no backup to make', async ($, on) => {
  const writes: string[] = []
  const files = world(on, new Map([[EXPORT, EXPORTED]]), writes)

  const shown = await run($, 'mods-import', `${EXPORT} --yes`)

  expect(writes).toEqual([SETTINGS])
  expect(shown.text).not.toContain('Backup')
  expect(json(files, SETTINGS).pluginConfigs['done-chime@claude-mods'].options).toEqual({ seconds: 45, volume: 0.5 })
})

test('/mods-import refuses files that are not exports, and drops secrets and unsafe names from ones that are', async ($, on) => {
  const writes: string[] = []
  const files = world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [EXPORT, '[1, 2]']]), writes)

  expect((await run($, 'mods-import', EXPORT)).text).toContain('is not a settings export (it has no "pluginConfigs" object')
  files.set(EXPORT, 'nope')
  expect((await run($, 'mods-import', EXPORT)).text).toContain('(it is not valid JSON)')
  expect((await run($, 'mods-import', '/nowhere.json')).text).toBe('Nothing imported: could not read /nowhere.json.')

  files.set(
    EXPORT,
    JSON.stringify({ pluginConfigs: { 'done-chime': { options: { seconds: 45, webhookSecret: 'abc', __proto__x: 1 } }, constructor: { options: { polluted: true } } } }),
  )
  const shown = await run($, 'mods-import', `${EXPORT} --yes`)

  expect(shown.text).toContain('Applied 2 changes')
  expect(shown.text).toContain('Ignored because they are not safe to merge or look like secrets: done-chime.webhookSecret, done-chime.__proto__x')
  expect(files.get(SETTINGS)).not.toContain('abc')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect((Object as unknown as Record<string, unknown>).polluted).toBeUndefined()
})

test('/mods-import says so when everything already matches', async ($, on) => {
  const writes: string[] = []
  world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [EXPORT, JSON.stringify({ pluginConfigs: { 'done-chime': { options: { seconds: 30 } } } })]]), writes)

  const shown = await run($, 'mods-import', `${EXPORT} --yes`)

  expect(shown.text).toBe(`Nothing to change: this machine already has the 1 setting in ${EXPORT}.`)
  expect(writes).toEqual([])
})

test('the marketplace option picks which plugins count as mods', { options: { marketplace: 'my-fork' } }, async ($, on) => {
  const files = world(on, new Map([[SETTINGS, JSON.stringify({ pluginConfigs: { 'a@my-fork': { options: { n: 1 } }, 'b@claude-mods': { options: { n: 2 } } } })]]))

  await run($, 'mods-export', '')

  expect(Object.keys(json(files, EXPORT).pluginConfigs)).toEqual(['a'])
})

test('CLAUDE_CONFIG_DIR moves the settings file', async ($, on) => {
  startClock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: '/cfg' })
  const files = new Map([['/cfg/settings.json', JSON.stringify(settingsOf())]])
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })

  const shown = await run($, 'mods-export', '')

  expect(shown.text).toContain('Exported 5 settings of 3 mods')
})

test('bare plugin keys count when enabledPlugins names the plugin from the marketplace', () => {
  const found = exportableOptions(
    { enabledPlugins: { 'focus-timer@claude-mods': true }, pluginConfigs: { 'focus-timer': { options: { minutes: 50 } }, other: { options: { n: 1 } } } },
    'claude-mods',
  )
  expect(found).toEqual({ plugins: { 'focus-timer': { minutes: 50 } }, skipped: [] })
})

test('looksSecret is about text under a secret-sounding name, so counters and switches travel', () => {
  expect([looksSecret('apiKey', 'abc'), looksSecret('webhookToken', 'abc'), looksSecret('password', ['a']), looksSecret('budgetTokens', 5), looksSecret('showTokens', true), looksSecret('seconds', '30')]).toEqual([
    true, true, true, false, false, false,
  ])
})

test('parseExport, planImport and applyChanges work on plain data', () => {
  expect(parseExport('{"pluginConfigs":{"a@claude-mods":{"options":{"n":1}}}}')).toEqual({ file: { exportedAt: undefined, plugins: { a: { n: 1 } } }, dropped: [] })
  const plan = planImport({ pluginConfigs: { a: { options: { n: 1, m: 2 } } } }, { a: { n: 1, m: 3 } }, 'claude-mods')
  expect(plan.unchanged).toBe(1)
  expect(plan.changes).toEqual([{ key: 'a', plugin: 'a', option: 'm', before: 2, after: 3 }]) // the bare key is the one that exists
  expect(applyChanges({ x: 1, pluginConfigs: { a: { options: { n: 1, m: 2 } } } }, plan.changes)).toEqual({ x: 1, pluginConfigs: { a: { options: { n: 1, m: 3 } } } })
  expect(stamp(NOW)).toBe('20261007-123005')
})

const HUB_PREFS = `${HOME}/.claude/claude-mods/hub/prefs.json`
const hubPrefs = (extra: Record<string, unknown> = {}) => ({
  interaction: 'auto',
  silentUntil: 99,
  isSilent: true,
  isNightOn: true,
  quietHours: '22:00-07:00',
  presence: 'away',
  routes: { info: 'terminal', success: 'away', warning: 'away', error: 'away', critical: 'always' },
  channels: { telegram: { isEnabled: true, minLevel: 'warning' } },
  ...extra,
})

test('with mods-hub: /mods-export also writes the hub\'s portable preferences, without Silent and presence', async ($, on) => {
  const files = world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [HUB_PREFS, JSON.stringify(hubPrefs())]]))
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  const shown = await run($, 'mods-export', '')
  expect(shown.text).toContain('Exported 5 settings of 3 mods')
  expect(shown.text).toContain('Also exported the preferences of mods-hub')
  const written = json(files, EXPORT)
  expect(written.hub.prefs).toEqual({
    interaction: 'auto',
    isNightOn: true,
    quietHours: '22:00-07:00',
    routes: { info: 'terminal', success: 'away', warning: 'away', error: 'away', critical: 'always' },
    channels: { telegram: { isEnabled: true, minLevel: 'warning' } },
  })
  expect(written.hub.prefs.isSilent).toBeUndefined()
  expect(written.hub.prefs.presence).toBeUndefined()
})

test('with mods-hub: only the hub preferences can be exported when no mod has settings', async ($, on) => {
  const files = world(on, new Map([[SETTINGS, JSON.stringify({ theme: 'dark' })], [HUB_PREFS, JSON.stringify(hubPrefs())]]))
  const shown = await run($, 'mods-export', '')
  expect(shown.text).toContain(`Exported the hub's preferences to ${EXPORT}.`)
  expect(Object.keys(json(files, EXPORT).pluginConfigs)).toEqual([])
})

const EXPORT_WITH_HUB = JSON.stringify({
  format: 'claude-mods-settings',
  version: 1,
  exportedAt: '2026-09-30T08:00:00.000Z',
  marketplace: 'claude-mods',
  pluginConfigs: { 'done-chime': { options: { seconds: 45 } } },
  hub: { prefs: { interaction: 'on', quietHours: '23:00-06:00', routes: { warning: 'always', bogus: 'x' }, channels: { slack: { isEnabled: true, minLevel: 'error' }, 'Bad Id': { isEnabled: true } } } },
})

test('with mods-hub: /mods-import lists the hub changes, applies them only with --yes after a backup, and keeps the hub\'s own state', async ($, on) => {
  const writes: string[] = []
  const original = JSON.stringify(hubPrefs())
  const files = world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [HUB_PREFS, original], [EXPORT, EXPORT_WITH_HUB]]), writes)

  const shown = await run($, 'mods-import', EXPORT)
  expect(writes).toEqual([])
  expect(shown.text).toBe(
    [
      `6 changes from ${EXPORT} (exported 2026-09-30):`,
      '  done-chime.seconds: 30 → 45',
      `mods-hub preferences (${HUB_PREFS}):`,
      '  interaction: "auto" → "on"',
      '  quietHours: "22:00-07:00" → "23:00-06:00"',
      '  routes.warning: "away" → "always"',
      '  channels.slack.isEnabled: (not set) → true',
      '  channels.slack.minLevel: (not set) → "error"',
      `Nothing has been changed. To apply, run: /mods-import ${EXPORT} --yes (your settings.json is backed up first).`,
    ].join('\n'),
  )

  const applied = await run($, 'mods-import', `${EXPORT} --yes`)
  const backup = `${HUB_PREFS}.bak-20261007-123005`
  expect(writes).toEqual([`${SETTINGS}.bak-20261007-123005`, SETTINGS, backup, HUB_PREFS])
  expect(files.get(backup)).toBe(original)
  expect(applied.text).toContain('Applied 1 change to')
  expect(applied.text).toContain(`Applied 5 mods-hub preferences to ${HUB_PREFS} (backup: ${backup})`)
  const merged = json(files, HUB_PREFS)
  expect(merged).toMatchObject({ interaction: 'on', quietHours: '23:00-06:00', isSilent: true, presence: 'away', silentUntil: 99 })
  expect(merged.routes).toEqual({ info: 'terminal', success: 'away', warning: 'always', error: 'away', critical: 'always' })
  expect(merged.channels).toEqual({ telegram: { isEnabled: true, minLevel: 'warning' }, slack: { isEnabled: true, minLevel: 'error' } })
})

test('/mods-import leaves the hub preferences out where the hub is not installed (no prefs.json), and says so', async ($, on) => {
  const writes: string[] = []
  world(on, new Map([[SETTINGS, JSON.stringify(settingsOf())], [EXPORT, EXPORT_WITH_HUB]]), writes)
  const applied = await run($, 'mods-import', `${EXPORT} --yes`)
  expect(applied.text).toContain(`mods-hub is not installed here (no ${HUB_PREFS}), so they were left out.`)
  expect(writes).not.toContain(HUB_PREFS)
})

test('hub preferences: portableHubPrefs keeps the known and valid, planHubImport and applyHubChanges merge them', () => {
  expect(portableHubPrefs({ interaction: 'maybe', routes: { info: 'terminal', nope: 'x' }, isSilent: true })).toEqual({ routes: { info: 'terminal' } })
  expect(portableHubPrefs('x')).toBeUndefined()
  expect(portableHubPrefs({ isSilent: true })).toBeUndefined()
  const plan = planHubImport({ routes: { info: 'terminal' } }, { routes: { info: 'terminal', error: 'always' } })
  expect(plan).toEqual({ changes: [{ path: 'routes.error', before: undefined, after: 'always' }], unchanged: 1 })
  expect(applyHubChanges({ routes: { info: 'terminal' }, isSilent: false }, plan.changes)).toEqual({ routes: { info: 'terminal', error: 'always' }, isSilent: false })
})

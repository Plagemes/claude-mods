import { expect, test } from 'claude-code/testing'

import { parseArgs, uninstallTargets } from '../hooks/catalog'
import { LOCAL_SETTINGS, mods, pane, SURFACES, world } from './world'

const mod = (version = '1.0.0', extra: { scope?: string; enabled?: boolean } = {}) => ({ version, scope: extra.scope ?? 'user', enabled: extra.enabled ?? true })
const PLUGINS = [
  ...['mod-store', 'mods-hub', 'secret-shield', 'git-status-line', 'cost-meter'].map(name => ({
    name, source: `./mods/${name}`, description: `${name}.`, version: '1.0.0', category: 'core', keywords: [],
  })),
]
/** Five installed claude-mods (mods-hub among them, cost-meter off), and a plugin of another marketplace the CLI never lists here. */
const INSTALLED = {
  'mod-store': mod(),
  'mods-hub': mod(),
  'secret-shield': mod(),
  'git-status-line': mod('1.0.0', { scope: 'project' }),
  'cost-meter': mod('1.0.0', { enabled: false }),
}
const uninstalls = (calls: readonly string[]) => calls.filter(call => call.startsWith('plugin uninstall'))
const installs = (calls: readonly string[]) => calls.filter(call => call.startsWith('plugin install'))
const SUMMARY = '◆ This will uninstall 4 mods: secret-shield, git-status-line and 2 more. mod-store stays installed. Run `/mods uninstall-all confirm` to proceed.'

test('parses uninstall-all, its flags and the spaced form; `uninstall all` is no longer a mod name', () => {
  expect(parseArgs('uninstall-all')).toEqual({ kind: 'uninstall-all', step: 'ask', keepHub: false })
  expect(parseArgs('uninstall all')).toEqual({ kind: 'uninstall-all', step: 'ask', keepHub: false })
  expect(parseArgs('remove all --keep-hub')).toEqual({ kind: 'uninstall-all', step: 'ask', keepHub: true })
  expect(parseArgs('uninstall-all confirm')).toEqual({ kind: 'uninstall-all', step: 'confirm', keepHub: false })
  expect(parseArgs('uninstall all confirm --keep-hub')).toEqual({ kind: 'uninstall-all', step: 'confirm', keepHub: true })
  expect(parseArgs('uninstall-all cancel').kind).toBe('uninstall-all')
  expect(parseArgs('uninstall-all now').kind).toBe('usage')
  expect(parseArgs('uninstall cost-meter')).toEqual({ kind: 'uninstall', name: 'cost-meter' })
  expect(parseArgs('reinstall-last')).toEqual({ kind: 'reinstall-last' })
  expect(parseArgs('reinstall last')).toEqual({ kind: 'reinstall-last' })
})

test('targets: never mod-store, mods-hub last (or kept), nothing managed', () => {
  const asInstall = (one: { version: string; scope: string; enabled: boolean }) => ({ version: one.version, scope: one.scope, isEnabled: one.enabled })
  const all = Object.fromEntries(Object.entries({ ...INSTALLED, 'managed-one': mod('1.0.0', { scope: 'managed' }) }).map(([name, one]) => [name, asInstall(one)]))
  expect(uninstallTargets(all, false)).toEqual(['secret-shield', 'git-status-line', 'cost-meter', 'mods-hub'])
  expect(uninstallTargets(all, true)).toEqual(['secret-shield', 'git-status-line', 'cost-meter'])
})

test('the command only asks: nothing is uninstalled until /mods uninstall-all confirm', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS })
  await mods($, 'refresh')
  const asked = await mods($, 'uninstall-all')
  await w.clock.settle()
  expect(asked.text).toBe(SUMMARY)
  expect(uninstalls(w.calls)).toEqual([])
  expect([...w.installed.keys()]).toHaveLength(5)
  expect((await mods($, 'uninstall-all cancel')).text).toBe('◆ Cancelled: nothing was uninstalled.')
  expect((await mods($, 'uninstall-all confirm')).text).toContain('Nothing to confirm')
  await w.clock.settle()
  expect(uninstalls(w.calls)).toEqual([])
})

test('confirm uninstalls only claude-mods, in the scope each is in, mod-store kept and mods-hub last', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, slowMs: 0 })
  await mods($, 'refresh')
  await mods($, 'uninstall-all')
  const started = await mods($, 'uninstall-all confirm')
  expect(started.text).toBe('◆ Uninstalling 4 mods in the background. Progress is in the store; s stops it.')
  await w.clock.settle()
  expect(uninstalls(w.calls)).toEqual([
    'plugin uninstall secret-shield@claude-mods --scope user --json',
    'plugin uninstall git-status-line@claude-mods --scope project --json',
    'plugin uninstall cost-meter@claude-mods --scope user --json',
    'plugin uninstall mods-hub@claude-mods --scope user --json',
  ])
  expect([...w.installed.keys()]).toEqual(['mod-store'])
  expect(w.toasts).toContain('✓ Uninstalled 4 mods (secret-shield, git-status-line and 2 more). mod-store stays installed. Run /reload-plugins to unload them.')
  // A second confirm has nothing pending.
  expect((await mods($, 'uninstall-all confirm')).text).toContain('Nothing to confirm')
})

test('--keep-hub keeps mods-hub, and a confirm that differs from the question is refused', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS })
  await mods($, 'refresh')
  const asked = await mods($, 'uninstall-all --keep-hub')
  expect(asked.text).toBe('◆ This will uninstall 3 mods: secret-shield, git-status-line and 1 more. mod-store stays installed and so does mods-hub. Run `/mods uninstall-all confirm --keep-hub` to proceed.')
  expect((await mods($, 'uninstall-all confirm')).text).toContain('That is not what was asked')
  await w.clock.settle()
  expect(uninstalls(w.calls)).toEqual([])
  await mods($, 'uninstall-all confirm --keep-hub')
  await w.clock.settle()
  expect(uninstalls(w.calls).map(call => call.split(' ')[2])).toEqual(['secret-shield@claude-mods', 'git-status-line@claude-mods', 'cost-meter@claude-mods'])
  expect([...w.installed.keys()].sort()).toEqual(['mod-store', 'mods-hub'])
})

test('with only mod-store installed there is nothing to uninstall', async ($, on) => {
  const w = world(on, { installed: { 'mod-store': mod() }, plugins: PLUGINS })
  await mods($, 'refresh')
  expect((await mods($, 'uninstall-all')).text).toBe('• There is nothing to uninstall: only mod-store is installed.')
  expect(uninstalls(w.calls)).toEqual([])
})

test('the list is saved before the first uninstall, with each mod\'s enabled state, and trimmed to what is gone', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, slowMs: 1_000, keeps: ['git-status-line'] })
  await mods($, 'refresh')
  await mods($, 'uninstall-all')
  await mods($, 'uninstall-all confirm')
  await w.clock.advance(100)
  expect(uninstalls(w.calls)).toHaveLength(1)
  expect((w.stored.lastUninstallAll as { mods: unknown[] }).mods).toEqual([
    { name: 'secret-shield', isEnabled: true },
    { name: 'git-status-line', isEnabled: true },
    { name: 'cost-meter', isEnabled: false },
    { name: 'mods-hub', isEnabled: true },
  ])
  await w.clock.advance(10_000)
  expect((w.stored.lastUninstallAll as { mods: unknown[] }).mods).toEqual([
    { name: 'secret-shield', isEnabled: true },
    { name: 'cost-meter', isEnabled: false },
    { name: 'mods-hub', isEnabled: true },
  ])
})

test('the bar moves per mod, s / the Stop button stop after the current one, and a second job is refused', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, slowMs: 1_000 })
  await mods($, 'refresh')
  await mods($, 'uninstall-all')
  await mods($, 'uninstall-all confirm')
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const progress = async () => (await ui.find({ type: 'Text', text: /^Uninstalling / }))?.text
  await w.clock.advance(100)
  expect(await progress()).toBe('Uninstalling secret-shield · 1/4')
  expect((await mods($, 'install cost-meter')).text).toContain('is still running')
  await w.clock.advance(1_000)
  expect(await progress()).toBe('Uninstalling git-status-line · 2/4')
  await ui.press({ key: 'stop' })
  await w.clock.advance(10_000)
  expect(uninstalls(w.calls)).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '✓ Uninstalled 2 mods (secret-shield, git-status-line). mod-store stays installed. Stopped with 2 mods left. Run /reload-plugins to unload them.' })).toBeDefined()
})

test('/mods stop works too', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, slowMs: 1_000 })
  await mods($, 'refresh')
  await mods($, 'uninstall-all')
  await mods($, 'uninstall-all confirm')
  await w.clock.advance(100)
  expect((await mods($, 'stop')).text).toBe('◆ Stopping after the mod it is on.')
  await w.clock.advance(10_000)
  expect(uninstalls(w.calls)).toHaveLength(1)
})

test('a failed uninstall does not stop the rest; the summary names it and Retry failed uninstalls it again, keeping the saved list whole', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, keeps: ['git-status-line'] })
  await mods($, 'refresh')
  await mods($, 'uninstall-all')
  await mods($, 'uninstall-all confirm')
  await w.clock.settle()
  expect(uninstalls(w.calls)).toHaveLength(4)
  expect([...w.installed.keys()].sort()).toEqual(['git-status-line', 'mod-store'])
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Uninstalled 3 mods .*Failed: git-status-line \(Could not remove git-status-line\)\./ })).toBeDefined()
  expect((await ui.find({ key: 'retry-failed' }))?.props).toMatchObject({ label: 'Retry 1 failed mod' })
  await ui.press({ key: 'retry-failed' })
  await w.clock.settle()
  expect(uninstalls(w.calls).slice(4)).toEqual(['plugin uninstall git-status-line@claude-mods --scope project --json'])
  expect((w.stored.lastUninstallAll as { mods: { name: string }[] }).mods.map(one => one.name)).toEqual(['secret-shield', 'cost-meter', 'mods-hub'])
})

test('Reinstall these and /mods reinstall-last install exactly the saved list and disable again what was disabled', async ($, on) => {
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS })
  await mods($, 'refresh')
  expect((await mods($, 'reinstall-last')).text).toBe('• There is nothing to reinstall: no uninstall-all is saved.')
  await mods($, 'uninstall-all --keep-hub')
  await mods($, 'uninstall-all confirm --keep-hub')
  await w.clock.settle()
  const before = w.calls.length
  const started = await mods($, 'reinstall-last')
  expect(started.text).toBe('◆ Reinstalling 3 mods in the background. Progress is in the store; s stops it.')
  await w.clock.settle()
  expect(installs(w.calls.slice(before))).toEqual([
    'plugin install secret-shield@claude-mods --scope user --json',
    'plugin install git-status-line@claude-mods --scope user --json',
    'plugin install cost-meter@claude-mods --scope user --json',
  ])
  expect(w.calls.slice(before)).toContain('plugin disable cost-meter@claude-mods --scope user --json')
  expect(w.calls.slice(before).filter(call => call.startsWith('plugin disable'))).toHaveLength(1)
  expect([...w.installed.keys()].sort()).toEqual(['cost-meter', 'git-status-line', 'mod-store', 'mods-hub', 'secret-shield'])
  expect(w.installed.get('cost-meter')?.enabled).toBe(false)
  expect(w.toasts.at(-1)).toContain('1 mod left disabled, as before.')
  expect((await mods($, 'reinstall-last')).text).toBe('• There is nothing to reinstall: no uninstall-all is saved.')
})

for (const surface of SURFACES) {
  test(`${surface}: the Installed view offers Uninstall all, the pane asks first, Cancel does nothing, the button runs it`, async ($, on) => {
    const w = world(on, { installed: INSTALLED, plugins: PLUGINS })
    await mods($, 'refresh')
    const ui = await $.ui.mount({ ...pane(), surface })
    // Not on the home view; on the Installed view only, secondary and dim.
    expect(await ui.find({ key: 'uninstall-all' })).toBeUndefined()
    await mods($, 'search')
    await ui.select({ key: 'status', value: 'installed' })
    const button = await ui.find({ key: 'uninstall-all' })
    expect(button?.props).toMatchObject({ label: 'Uninstall all (4)', dimColor: true })
    await ui.press({ key: 'uninstall-all' })
    expect(await ui.find({ type: 'Text', text: 'Uninstall 4 mods?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'This will uninstall 4 mods: secret-shield, git-status-line and 2 more. mod-store stays installed.' })).toBeDefined()
    expect(uninstalls(w.calls)).toEqual([])

    await ui.press({ key: 'confirm-cancel' })
    expect(await ui.find({ key: 'confirm-uninstall' })).toBeUndefined()
    await w.clock.settle()
    expect(uninstalls(w.calls)).toEqual([])

    await ui.press({ key: 'uninstall-all' })
    await ui.press({ key: 'confirm-keep-hub' })
    expect((await ui.find({ key: 'confirm-uninstall' }))?.props).toMatchObject({ label: 'Uninstall 3 mods' })
    await ui.press({ key: 'confirm-keep-hub' })
    await ui.press({ key: 'confirm-uninstall' })
    await w.clock.settle()
    expect(uninstalls(w.calls)).toHaveLength(4)
    expect(uninstalls(w.calls).at(-1)).toContain('mods-hub')
    expect(await ui.find({ key: 'reinstall' })).toBeDefined()
    await ui.press({ key: 'reinstall' })
    await w.clock.settle()
    expect(installs(w.calls)).toHaveLength(4)
    expect([...w.installed.keys()]).toHaveLength(5)
    await ui.unmount()
  })
}

test('the project profile loses the uninstalled mods\' entries and nothing else', async ($, on) => {
  const settings = JSON.stringify({
    permissions: { allow: ['Bash(ls)'] },
    enabledPlugins: { 'secret-shield@claude-mods': false, 'cost-meter@claude-mods': true, 'mods-hub@claude-mods': false, 'other@elsewhere': false, 'mod-store@claude-mods': false },
  })
  const w = world(on, { installed: INSTALLED, plugins: PLUGINS, files: { [LOCAL_SETTINGS]: settings } })
  await mods($, 'refresh')
  await mods($, 'uninstall-all --keep-hub')
  await mods($, 'uninstall-all confirm --keep-hub')
  await w.clock.settle()
  expect(JSON.parse(w.fileText(LOCAL_SETTINGS) ?? '{}')).toEqual({
    permissions: { allow: ['Bash(ls)'] },
    enabledPlugins: { 'mods-hub@claude-mods': false, 'other@elsewhere': false, 'mod-store@claude-mods': false },
  })
  expect(w.toasts.at(-1)).toContain('Cleared 2 entries from this project\'s profile.')
})

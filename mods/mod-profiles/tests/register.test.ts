import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'mod-profiles'
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.UTC(2026, 9, 7, 12)
const BIN = '/opt/claude-code/bin/claude'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Mod Profiles',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

type Install = { scope: string; enabled: boolean }

/** Stands for the claude CLI, the store and the surface beneath the plugin. */
function world(on: On, options: { store?: Record<string, unknown>; isPlaced?: boolean; failing?: string } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, options.store ?? {})
  mock.env(on, { CLAUDE_CODE_EXECPATH: BIN })
  const installed = new Map<string, Install>([
    ['cost-meter', { scope: 'user', enabled: true }],
    ['focus-timer', { scope: 'user', enabled: true }],
    ['celebrate', { scope: 'project', enabled: false }],
    ['mod-profiles', { scope: 'user', enabled: true }],
  ])
  const calls: string[] = []
  const commands: string[] = []
  const out = (stdout: string, exitCode = 0) => ({
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
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const [, ...args] = e.argv
    const line = args.join(' ')
    calls.push(line)
    if (line === 'plugin list --json') {
      return out(JSON.stringify([...installed].map(([name, one]) => ({ id: `${name}@claude-mods`, version: '1.0.0', ...one }))))
    }
    const name = (args[2] ?? '').split('@')[0] ?? ''
    const one = installed.get(name)
    if (one === undefined || name === options.failing) {
      return out(JSON.stringify({ outcome: 'failed', message: `Plugin "${name}" is managed by policy` }), 1)
    }
    one.enabled = args[1] === 'enable'
    return out(JSON.stringify({ outcome: 'ok', message: `Successfully ${args[1]}d plugin: ${name}` }))
  })

  return { clock, installed, calls, commands }
}

const profiles = ($: Engine, args = '') =>
  $.command.run({ command: 'profile-mods', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('save records the plugins that are on; use switches back to them and reloads', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await profiles($, 'save work')).text).toBe('✓ Saved profile work: 3 enabled plugins (1 disabled plugin stays off when you use it).')
  w.installed.set('focus-timer', { scope: 'user', enabled: false })
  w.installed.set('celebrate', { scope: 'project', enabled: true })
  w.installed.set('fresh-mod', { scope: 'user', enabled: true })

  const used = await profiles($, 'use work')
  expect(used.text).toBe('✓ Switched to work: enabled focus-timer; disabled celebrate. Reloading plugins…')
  expect(w.calls).toEqual([
    'plugin list --json',
    'plugin list --json',
    'plugin enable focus-timer@claude-mods --scope user --json',
    'plugin disable celebrate@claude-mods --scope project --json',
    'plugin list --json',
  ])
  expect(w.installed.get('fresh-mod')?.enabled).toBe(true)
  await w.clock.settle()
  expect(w.commands).toEqual(['reload-plugins'])

  expect((await profiles($, 'use work')).text).toBe('• Profile work already matches your plugins.')
  expect((await profiles($, 'list')).text).toBe('◆ 1 profile · active: work\n● work: 3 plugins on · saved just now · matches now')
})

test('the pane lists profiles with what Use would change, and Use, Delete and Save work from it', async ($, on) => {
  const saved = {
    profiles: {
      demo: { enabled: ['cost-meter@claude-mods'], disabled: ['focus-timer@claude-mods'], savedAt: NOW - 2 * 3_600_000 },
      work: { enabled: ['cost-meter@claude-mods', 'focus-timer@claude-mods', 'mod-profiles@claude-mods'], disabled: ['celebrate@claude-mods'], savedAt: NOW - 3 * 86_400_000 },
    },
    active: 'work',
  }
  const w = world(on, { store: saved })
  expect((await profiles($)).text).toBe('◆ Opened your mod profiles.')
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })
    expect(await ui.find({ type: 'Text', text: '2 profiles · active: work' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Now: 3 plugins on · 1 off' })).toBeDefined()
    expect((await ui.find({ key: 'profile:demo' }))?.text).toBe('○demo1 plugin on · saved 2 h ago−1UseDelete')
    expect((await ui.find({ key: 'profile:work' }))?.text).toContain('matches now')
    expect(await ui.find({ key: 'use:demo' })).toMatchObject({ props: { hotkey: '1' } })
    await ui.press({ key: 'open:demo' })
    expect(await ui.find({ type: 'Text', text: 'Disables focus-timer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Left as they are (installed since it was saved): celebrate' })).toBeDefined()
    await ui.press({ key: 'open:demo' })
    expect(await ui.find({ type: 'Text', text: 'Disables focus-timer' })).toBeUndefined()
    expect(await ui.find({ key: 'save-name' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  await ui.press({ key: 'use:demo' })
  expect(w.installed.get('focus-timer')?.enabled).toBe(false)
  expect(await ui.find({ type: 'Text', text: '✓ Switched to demo: disabled focus-timer. Reloading plugins…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 profiles · active: demo' })).toBeDefined()

  await ui.press({ key: 'delete:work' })
  expect(await ui.find({ key: 'use:work' })).toBeUndefined()
  await ui.press({ key: 'confirm:work' })
  expect(await ui.find({ key: 'profile:work' })).toBeUndefined()

  await ui.input({ key: 'save-name', text: 'Night' })
  expect(await ui.find({ key: 'profile:night' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Saved profile night: 2 enabled plugins/ })).toBeDefined()
  await ui.unmount()
})

test('reports unknown profiles, failed switches and usage, and lists in text without a pane', { options: { autoReload: false } }, async ($, on) => {
  const w = world(on, { isPlaced: false, failing: 'celebrate' })
  expect((await profiles($)).text).toBe('◆ No profiles yet. Save the mods you have on now with /profile-mods save <name>.')
  expect((await profiles($, 'use work')).text).toBe('✗ There is no profile named work. Save one with /profile-mods save work.')
  await profiles($, 'save quiet')
  w.installed.set('celebrate', { scope: 'project', enabled: true })
  w.installed.set('cost-meter', { scope: 'user', enabled: false })

  const used = await profiles($, 'use quiet')
  expect(used.text).toBe(
    '✗ Switched to quiet: enabled cost-meter. Could not disable celebrate (Plugin "celebrate" is managed by policy). Run /reload-plugins to apply.',
  )
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect((await profiles($, 'delete quiet')).text).toBe('✓ Deleted profile quiet.')
  expect((await profiles($, 'rename x')).text).toBe('✗ Unknown action "rename". Usage: /profile-mods [save|use|delete <name> | list]')
})

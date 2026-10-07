import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { callsOf, hubStandIn, script, setPrefs } from './hub'
import { serializeTeam } from '../hooks/team'
import type { TeamConfig } from '../types'

const PLUGIN = 'team-hub'
const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const SURFACES = ['terminal', 'desktop'] as const
const MINUTE = 60_000
const ROOT = '/work/shop'
const TEAM_PATH = `${ROOT}/.claude/team.json`
const BIN = '/opt/claude-code/bin/claude'
const NOW = Date.UTC(2026, 9, 7, 10, 0)
const PANE: RenderPropsOf['Pane'] = { title: 'Team', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const COMPOSE = { model: 'claude', promptModel: 'claude', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] as readonly 'bare'[] }
const TOKEN = `ghp_${'a1'.repeat(18)}`

const TEAM = {
  version: 1,
  name: 'Acme Web Team',
  conventions: ['Write small commits.', 'Run the tests before a pull request.'],
  recommendedMods: ['secret-shield', 'guardian', 'token-budget'],
  guard: { level: 'strict' },
  budget: { sessionUsd: 5, dailyUsd: 20 },
  notifications: { critical: 'always', error: 'away' },
  owners: ['alice@acme.com'],
}
const TEAM_TEXT = `${JSON.stringify(TEAM, null, 2)}\n`
const TEAM_CONFIG = { version: 1, name: 'Acme Web Team', conventions: 'Write small commits.\nRun the tests before a pull request.', recommendedMods: ['secret-shield', 'guardian', 'token-budget'], marketplace: 'plagemes/claude-mods', marketplaceName: 'claude-mods', guardLevel: 'strict', budget: { sessionUsd: 5, dailyUsd: 20 }, notifications: { critical: 'always', error: 'away' }, owners: ['alice@acme.com'], extra: {} } satisfies TeamConfig

type Installed = Record<string, { version: string; enabled: boolean }>
type WorldOptions = {
  team?: string | null
  rows?: Record<string, string | number | boolean>
  installed?: Installed
  email?: string
  name?: string
  marketplaces?: string[]
  installFails?: Record<string, string>
  locked?: string[]
  listFails?: boolean
}

/** Stands for everything beneath the plugin: git, the claude CLI, /config, the repository's files, the screen. */
function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me', CLAUDE_CODE_EXECPATH: BIN })
  const files = new Map<string, string>()
  if (options.team !== null) files.set(TEAM_PATH, options.team ?? TEAM_TEXT)
  const mtimes = new Map<string, number>([[TEAM_PATH, 1]])
  const rows = new Map<string, string | number | boolean>(Object.entries(options.rows ?? { 'token-budget.budgetUsd': 10, 'token-budget.budgetTokens': 0, 'daily-spend.dailyLimit': 20 }))
  const installed = new Map(Object.entries(options.installed ?? { 'secret-shield': { version: '1.0.0', enabled: true } }))
  const marketplaces = [...(options.marketplaces ?? ['claude-mods'])]
  const calls: string[] = []
  const sets: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  const panes: string[] = []
  const json = (value: unknown) => JSON.stringify(value)
  const result = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const touch = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, (mtimes.get(path) ?? 1) + 1)
  }
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    touch(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => (files.has(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: mtimes.get(e.path) ?? 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('process.run', ($, e) => {
    const [bin = '', ...args] = e.argv
    const line = args.join(' ')
    if (bin === 'git') return result(line === 'config user.email' ? `${options.email ?? 'alice@acme.com'}\n` : `${options.name ?? 'Alice'}\n`)
    calls.push(line)
    expect(bin).toBe(BIN)
    if (line === 'plugin list --json') return options.listFails === true ? result('', 1) : result(json([...installed].map(([name, one]) => ({ id: `${name}@claude-mods`, version: one.version, scope: 'user', enabled: one.enabled }))))
    if (line === 'plugin marketplace list --json') return result(json(marketplaces.map(name => ({ name }))))
    if (args[1] === 'marketplace' && args[2] === 'add') {
      marketplaces.push('claude-mods')
      return result(json({ command: 'marketplace-add', outcome: 'ok', message: 'Added' }))
    }
    if (args[1] === 'marketplace' && args[2] === 'update') return result(json({ outcome: 'ok', message: 'Updated' }))
    if (args[1] === 'install') {
      const name = (args[2] ?? '').split('@')[0] ?? ''
      const failure = options.installFails?.[name]
      if (failure !== undefined) return result(json({ command: 'install', outcome: 'error', message: failure }), 1)
      installed.set(name, { version: '1.0.0', enabled: true })
      return result(json({ command: 'install', outcome: 'ok', message: `Installed ${name}` }))
    }
    return result('', 1)
  })
  on('config.list', () => ({ value: [...rows].map(([key, value]) => ({ key, label: key, kind: typeof value === 'number' ? 'number' : 'text', value, provider: { kind: 'plugin', name: key.split('.')[0] ?? '' }, isLocked: false })) as never }))
  on('config.set', ($, e) => {
    if (options.locked?.includes(e.key)) return { deny: 'managed by your organization' }
    sets.push({ key: e.key, value: e.value })
    rows.set(e.key, e.value as string | number | boolean)
    return { value: e.value } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT } as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  return { clock, files, calls, sets, toasts, panes, rows, installed, touch }
}

type World = ReturnType<typeof world>

const start = async ($: Engine, w: World) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(1_000)
}
const team = ($: Engine, args = '') => $.command.run({ command: 'team', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }).then(result => String(result.text ?? ''))
const section = async ($: Engine, traits: readonly 'bare'[] = []) => (await $.prompt.compose({ ...COMPOSE, traits })).sections.find(one => one.id === 'team-hub')?.text ?? ''
const fileOf = (w: World): TeamConfig & Record<string, unknown> => JSON.parse(w.files.get(TEAM_PATH) ?? '{}') as never

test('without the hub: /team shows the conventions, the mods with their state and what differs from the team rules', async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = await team($, 'show')
  expect(text).toContain('Acme Web Team · .claude/team.json')
  expect(text).not.toContain('read-only')
  expect(text).toContain('Conventions (2):\n  - Write small commits.\n  - Run the tests before a pull request.')
  expect(text).toContain('✓ secret-shield 1.0.0')
  expect(text).toContain('✗ guardian')
  expect(text).toContain('✗ token-budget')
  expect(text).toContain('⚠ Session dollar budget: yours $10, team $5 (/team align fixes it)')
  expect(text).toContain('⚠ Guard level: yours guardian is not installed, team strict')
  expect(text).toContain('Team defaults: guard strict · sessionUsd 5 · dailyUsd 20 · critical → always · error → away')
  expect(text).toContain('Owners: alice@acme.com')
  const check = await team($, 'check')
  expect(check).toBe("2 settings differ from the team's rules; 2 recommended mods are missing.\n  ⚠ Session dollar budget: yours $10, team $5\n  ⚠ Guard level: yours guardian is not installed, team strict\n  Missing: guardian, token-budget (/team install)")
  expect(w.calls.filter(call => call === 'plugin list --json').length).toBeGreaterThan(0)
  expect(await team($, 'bogus')).toContain('Usage: /team')
})

test('without the hub: the drift is said once as a toast', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.toasts).toEqual(["Team rules: 2 settings differ from the team's rules; 2 recommended mods are missing. — Run /team to see what differs."])
  await w.clock.advance(5 * MINUTE)
  expect(w.toasts).toHaveLength(1)
})

test('the notice can be switched off; a person in line with the team hears nothing', { options: { notifyDrift: false } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.toasts).toEqual([])
})

test('the system prompt gets the conventions as one stable session section; not for bare prompts, not when switched off', async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = await section($)
  expect(text).toBe(['# Team conventions: Acme Web Team', 'The team agreed these in .claude/team.json. Follow them unless the person asks otherwise.', '', 'Write small commits.', 'Run the tests before a pull request.'].join('\n'))
  expect(await section($)).toBe(text)
  expect(await section($, ['bare'])).toBe('')
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.find(one => one.id === 'team-hub')).toMatchObject({ scope: 'session' })
})

test('the conventions section can be switched off', { options: { injectConventions: false } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await section($)).toBe('')
})

test('the section follows the file when it changes on disk (a git pull), and only then', async ($, on) => {
  const w = world(on)
  await start($, w)
  const before = await section($)
  await w.clock.advance(2 * MINUTE)
  expect(await section($)).toBe(before)
  w.touch(TEAM_PATH, serializeTeam({ ...TEAM_CONFIG, name: 'Acme', conventions: 'Ship on Fridays only if the tests pass.', guardLevel: 'off', budget: {}, notifications: {}, owners: [], recommendedMods: [] }))
  await w.clock.advance(MINUTE)
  expect(await section($)).toContain('Ship on Fridays only if the tests pass.')
  expect(await team($, 'show')).toContain('Acme · .claude/team.json')
})

test('no team file: it says so, creates a starter for whoever asks, and the starter is a valid file owned by them', async ($, on) => {
  const w = world(on, { team: null })
  await start($, w)
  expect(await team($, 'show')).toBe('No .claude/team.json in this repository. /team init creates one.')
  expect(await section($)).toBe('')
  expect(await team($, 'init')).toContain('Created .claude/team.json with a starter')
  expect(fileOf(w)).toMatchObject({ version: 1, name: 'shop', owners: ['alice@acme.com'], recommendedMods: ['secret-shield', 'commit-composer'] })
  expect(await team($, 'init')).toBe('.claude/team.json already exists.')
  expect(await section($)).toContain('Write small commits with a clear message.')
})

test('an unreadable file is explained and never reaches the prompt; a secret in it is flagged and masked', async ($, on) => {
  const broken = world(on, { team: '{ "name": ' })
  await start($, broken)
  expect(await team($, 'show')).toContain('.claude/team.json cannot be used: team.json is not valid JSON')
  expect(await section($)).toBe('')
})

test('a secret in the file is flagged and never goes into the system prompt', async ($, on) => {
  const w = world(on, { team: JSON.stringify({ ...TEAM, conventions: [`Use the token ${TOKEN} for the API.`] }) })
  await start($, w)
  expect(await team($, 'show')).toContain('looks like a secret')
  const text = await section($)
  expect(text).not.toContain(TOKEN)
  expect(text).toContain('[REDACTED:github-token]')
})

test('maintainers edit through commands: each change is a normal, reviewable file change; the checks refuse nonsense and secrets', async ($, on) => {
  const w = world(on)
  await start($, w)
  const saved = 'Saved .claude/team.json. It is a normal file: review and commit it (git add .claude/team.json) so the team gets it.'
  expect(await team($, 'add-mod test-watch commit-composer')).toBe(saved)
  expect(fileOf(w).recommendedMods).toEqual(['secret-shield', 'guardian', 'token-budget', 'test-watch', 'commit-composer'])
  expect(await team($, 'add-mod test-watch')).toBe('test-watch is already recommended.')
  expect(await team($, 'remove-mod commit-composer')).toBe(saved)
  expect(await team($, 'convention Review pull requests within a day')).toBe(saved)
  expect(fileOf(w).conventions).toEqual(['Write small commits.', 'Run the tests before a pull request.', 'Review pull requests within a day'])
  expect(await team($, 'guard standard')).toBe(saved)
  expect(fileOf(w).guard).toEqual({ level: 'standard' })
  expect(await team($, 'budget sessionUsd 3')).toBe(saved)
  expect(fileOf(w).budget).toEqual({ sessionUsd: 3, dailyUsd: 20 })
  expect(await team($, 'budget dailyUsd none')).toBe(saved)
  expect(fileOf(w).budget).toEqual({ sessionUsd: 3 })
  expect(await team($, 'budget sessionUsd lots')).toBe('A budget is a number, 0 or more.')
  expect(await team($, 'route warning away')).toBe(saved)
  expect(fileOf(w).notifications).toEqual({ warning: 'away', error: 'away', critical: 'always' })
  expect(await team($, 'owner add carol@acme.com')).toBe(saved)
  expect(fileOf(w).owners).toEqual(['alice@acme.com', 'carol@acme.com'])
  expect(await team($, 'guard paranoid')).toContain('Usage: /team')
  const before = w.files.get(TEAM_PATH)
  expect(await team($, `convention rotate ${TOKEN} monthly`)).toContain('Not saved: the file would contain what looks like a secret')
  expect(w.files.get(TEAM_PATH)).toBe(before)
  // The file is always written in the same shape: the next edit changes only its own lines.
  expect(w.files.get(TEAM_PATH)).toBe(serializeTeam({ ...TEAM_CONFIG, conventions: 'Write small commits.\nRun the tests before a pull request.\nReview pull requests within a day', recommendedMods: ['secret-shield', 'guardian', 'token-budget', 'test-watch'], guardLevel: 'standard', budget: { sessionUsd: 3 }, notifications: { warning: 'away', error: 'away', critical: 'always' }, owners: ['alice@acme.com', 'carol@acme.com'] }))
})

test('someone who is not an owner can read but not write', async ($, on) => {
  const w = world(on, { email: 'eve@evil.com', name: 'Eve' })
  await start($, w)
  expect(await team($, 'show')).toContain('read-only for you (not an owner)')
  const before = w.files.get(TEAM_PATH)
  expect(await team($, 'add-mod test-watch')).toBe('Only the owners of this team file can change it (alice@acme.com). You are eve@evil.com.')
  expect(await team($, 'guard off')).toContain('Only the owners')
  expect(w.files.get(TEAM_PATH)).toBe(before)
})

test('install: adds the marketplace when it is missing, installs every missing recommended mod, and says to reload', async ($, on) => {
  const w = world(on, { marketplaces: [] })
  await start($, w)
  expect(await team($, 'install')).toBe('Installed guardian, token-budget. Run /reload-plugins to activate them.')
  expect(w.calls).toEqual(expect.arrayContaining(['plugin marketplace list --json', 'plugin marketplace add plagemes/claude-mods --json', 'plugin install guardian@claude-mods --scope user --json', 'plugin install token-budget@claude-mods --scope user --json']))
  expect(w.installed.has('guardian')).toBe(true)
  expect(await team($, 'install')).toBe('Every recommended mod is already installed.')
  expect(await team($, 'install nope')).toBe("Not in the team's list: nope.")
  expect(await team($, 'show')).toContain('✓ guardian 1.0.0')
})

test('install: one mod by name; a failure is reported and the others still go on', async ($, on) => {
  const w = world(on, { installFails: { guardian: 'No such plugin' } })
  await start($, w)
  expect(await team($, 'install guardian token-budget')).toBe('Installed token-budget. Run /reload-plugins to activate it. Failed: guardian (No such plugin).')
  expect(w.installed.has('token-budget')).toBe(true)
  expect(w.installed.has('guardian')).toBe(false)
})

test('install: when the plugin list cannot be read nothing is claimed missing and nothing is installed', async ($, on) => {
  const w = world(on, { listFails: true })
  await start($, w)
  expect(await team($, 'install')).toBe('Could not read the installed mods (claude plugin list failed).')
  const text = await team($, 'show')
  expect(text).toContain('? secret-shield')
  expect(text).not.toContain('recommended mods are missing')
})

test('align: sets the budget rows back to the team\'s values through /config; a locked row is reported', async ($, on) => {
  const w = world(on, { rows: { 'token-budget.budgetUsd': 10, 'token-budget.budgetTokens': 0, 'daily-spend.dailyLimit': 50 }, installed: { 'secret-shield': { version: '1', enabled: true }, guardian: { version: '1', enabled: true }, 'token-budget': { version: '1', enabled: true } } })
  await start($, w)
  expect(await team($, 'align')).toBe("Set Session dollar budget, Daily dollar limit to the team's values.")
  expect(w.sets).toEqual([
    { key: 'token-budget.budgetUsd', value: 5 },
    { key: 'daily-spend.dailyLimit', value: 20 },
  ])
  expect(await team($, 'check')).toBe('In line with the team rules.')
  expect(await team($, 'align')).toContain('Nothing to align')
})

test('align: a row an organization has locked is not changed and the person is told', async ($, on) => {
  const w = world(on, { locked: ['token-budget.budgetUsd'] })
  await start($, w)
  expect(await team($, 'align')).toBe('Could not change: Session dollar budget (managed by your organization).')
  expect(w.sets).toEqual([])
})

test('hub: the Team tab, the drift event (once, and again only when it changes), the policy fact and one notice', { plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await callsOf($, 'registerTab', PLUGIN)).toEqual([{ id: 'team', title: 'Team', order: 220, command: 'team' }])
  expect(await callsOf($, 'hello', PLUGIN)).toEqual([{ version: '1.0.0', publishes: ['x.team-hub.drift'], consumes: [] }])
  const published = await callsOf($, 'publish', PLUGIN)
  expect(published).toEqual([
    {
      topic: 'x.team-hub.drift',
      data: {
        count: 4,
        items: [
          { id: 'budget.sessionUsd', title: 'Session dollar budget', team: '$5', personal: '$10' },
          { id: 'guard', title: 'Guard level', team: 'strict', personal: 'guardian is not installed' },
        ],
        missingMods: ['guardian', 'token-budget'],
        disabledMods: [],
      },
    },
  ])
  const shared = (await callsOf($, 'share', PLUGIN)) as { name: string; value: { guardLevel: string; budget: unknown } }[]
  expect(shared).toHaveLength(1)
  expect(shared[0]).toMatchObject({ name: 'policy', value: { guardLevel: 'strict', budget: { sessionUsd: 5, dailyUsd: 20 } } })
  const notices = (await callsOf($, 'notify', PLUGIN)) as { level: string; title: string; audience: string }[]
  expect(notices).toEqual([expect.objectContaining({ level: 'info', audience: 'terminal', title: "Team rules: 2 settings differ from the team's rules; 2 recommended mods are missing." })])
  expect(w.toasts).toEqual([])
  // Nothing changed: nothing is published again.
  await w.clock.advance(5 * MINUTE)
  expect(await callsOf($, 'publish', PLUGIN)).toHaveLength(1)
  // The person fixes their budget: the drift shrinks and the event follows.
  w.rows.set('token-budget.budgetUsd', 5)
  await w.clock.advance(MINUTE)
  const after = (await callsOf($, 'publish', PLUGIN)) as { data: { count: number; items: unknown[] } }[]
  expect(after).toHaveLength(2)
  expect(after[1]?.data.count).toBe(3)
  expect(await callsOf($, 'notify', PLUGIN)).toHaveLength(1)
})

test('hub: notification routes and guardian\'s level are compared with the team\'s', { plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on, { installed: { 'secret-shield': { version: '1', enabled: true }, guardian: { version: '1', enabled: true }, 'token-budget': { version: '1', enabled: true } }, rows: { 'token-budget.budgetUsd': 5, 'daily-spend.dailyLimit': 20 } })
  await start($, w)
  expect(await callsOf($, 'publish', PLUGIN)).toEqual([expect.objectContaining({ data: expect.objectContaining({ count: 0 }) })])
  await setPrefs($, { routes: { info: 'terminal', success: 'away', warning: 'away', error: 'terminal', critical: 'always' } })
  await script($, 'read.guardian.policy', { level: 'standard' })
  await w.clock.advance(MINUTE)
  const published = (await callsOf($, 'publish', PLUGIN)) as { data: { items: { id: string; personal: string }[] } }[]
  expect(published.at(-1)?.data.items).toEqual([
    { id: 'route.error', title: 'Notifications: error', team: 'away', personal: 'terminal' },
    { id: 'guard', title: 'Guard level', team: 'strict', personal: 'standard' },
  ])
  expect(await team($, 'show')).toContain('⚠ Notifications: error: yours terminal, team away (/hub route error away)')
})

test('hub: the tab opens through the hub and draws on every surface; another tab is left alone', { plugins: [hubStandIn()] }, async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    const other = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await other.find({ text: /Acme Web Team/ })).toBeUndefined()
    await other.unmount()
  }
  expect(await team($)).toBe('Team panel opened.')
  expect(await callsOf($, 'showTab', PLUGIN)).toEqual([{ id: 'team' }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await ui.find({ text: '👥 Team · Acme Web Team' })).toBeDefined()
    expect(await ui.find({ key: 'team-install-guardian' })).toBeDefined()
    await ui.unmount()
  }
})

test('without the hub the same view opens in a pane of its own', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await team($)).toBe('Team panel opened.')
  expect(w.panes).toEqual(['team-hub'])
})

for (const surface of ALL_SURFACES) {
  test(`the pane on ${surface}: conventions, mods with Install buttons, the differences with Align, and Install all`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'team-hub', props: PANE })
    const shows = async (query: Parameters<typeof ui.find>[0]) => {
      if ((await ui.find(query)) === undefined) throw new Error(`the pane does not show ${JSON.stringify(query)} on ${surface}`)
    }
    await shows({ text: '👥 Team · Acme Web Team' })
    await shows({ text: '  - Write small commits.' })
    await shows({ text: /secret-shield 1\.0\.0/ })
    await shows({ key: 'team-install-guardian' })
    await shows({ key: 'team-install-token-budget' })
    await shows({ key: 'team-install-all' })
    await shows({ text: /Session dollar budget: yours \$10, team \$5/ })
    await shows({ key: 'team-align-budget.sessionUsd' })

    await ui.press({ key: 'team-align-budget.sessionUsd' })
    expect(w.sets).toEqual([{ key: 'token-budget.budgetUsd', value: 5 }])
    await ui.press({ key: 'team-install-all' })
    expect(w.installed.has('guardian') && w.installed.has('token-budget')).toBe(true)
    await shows({ text: /Installed guardian, token-budget\. Run \/reload-plugins/ })
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`the editor on ${surface}: edits make a working copy, nothing is written until Save, Cancel throws it away`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'team-hub', props: PANE })
    const typed = ui as unknown as { input: (query: { key: string; text: string }) => Promise<void> }
    const shows = async (query: Parameters<typeof ui.find>[0]) => {
      if ((await ui.find(query)) === undefined) throw new Error(`the editor does not show ${JSON.stringify(query)} on ${surface}`)
    }
    await ui.press({ key: 'team-edit' })
    await shows({ text: /nothing is written until you press Save/ })
    await typed.input({ key: 'team-add-convention', text: 'Review within a day' })
    await shows({ text: '  3. Review within a day' })
    await ui.press({ key: 'team-rm-convention-0' })
    await shows({ text: '  1. Run the tests before a pull request.' })
    await typed.input({ key: 'team-add-mod', text: 'test-watch' })
    await shows({ key: 'team-rm-mod-test-watch' })
    await typed.input({ key: 'team-add-mod', text: 'Not A Mod' })
    await shows({ text: /is not a mod name/ })
    await ui.press({ key: 'team-guard' })
    await shows({ key: 'team-guard', text: 'Guard level: off' })
    await typed.input({ key: 'team-budget-sessionUsd', text: '3' })
    await ui.press({ key: 'team-route-warning' })
    await shows({ key: 'team-route-warning', text: 'warning: terminal' })
    await typed.input({ key: 'team-add-owner', text: 'carol@acme.com' })
    await shows({ key: 'team-rm-owner-carol@acme.com' })
    expect(w.files.get(TEAM_PATH)).toBe(TEAM_TEXT)

    await ui.press({ key: 'team-cancel' })
    expect(w.files.get(TEAM_PATH)).toBe(TEAM_TEXT)
    await ui.press({ key: 'team-edit' })
    await typed.input({ key: 'team-add-convention', text: 'Review within a day' })
    await typed.input({ key: 'team-budget-dailyUsd', text: '' })
    await ui.press({ key: 'team-save' })
    expect(fileOf(w).conventions).toEqual(['Write small commits.', 'Run the tests before a pull request.', 'Review within a day'])
    expect(fileOf(w).budget).toEqual({ sessionUsd: 5 })
    await shows({ text: /Saved \.claude\/team\.json/ })
    await ui.unmount()
  })
}

test('the pane of someone who is not an owner has no Edit button and says why', async ($, on) => {
  const w = world(on, { email: 'eve@evil.com', name: 'Eve' })
  await start($, w)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'team-hub', props: PANE })
  expect(await ui.find({ key: 'team-edit' })).toBeUndefined()
  expect(await ui.find({ text: /Only the owners can edit this file \(you are eve@evil.com\)/ })).toBeDefined()
  await ui.unmount()
})

test('the pane without a team file offers to create one; with a broken one it says what is wrong', async ($, on) => {
  const w = world(on, { team: null })
  await start($, w)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE })
  expect(await ui.find({ key: 'team-create' })).toBeDefined()
  await ui.press({ key: 'team-create' })
  expect(fileOf(w).name).toBe('shop')
  expect(await ui.find({ text: /Created \.claude\/team\.json/ })).toBeDefined()
  expect(await ui.find({ text: '👥 Team · shop' })).toBeDefined()
  await ui.unmount()
})

test('the pane with a broken file says what is wrong and offers a reload', async ($, on) => {
  const w = world(on, { team: '{ "owners": ' })
  await start($, w)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'team-hub', props: PANE })
  expect(await ui.find({ text: /not valid JSON/ })).toBeDefined()
  w.touch(TEAM_PATH, TEAM_TEXT)
  await ui.press({ key: 'team-refresh' })
  expect(await ui.find({ text: '👥 Team · Acme Web Team' })).toBeDefined()
  await ui.unmount()
})

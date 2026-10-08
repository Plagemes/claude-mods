import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'
import { CONFIG, HOME, LOCAL_SETTINGS, mods, NOW, pane, PROJECT, SURFACES, TRANSCRIPTS, world } from './world'
import type { FakeFile, Install, WorldOptions } from './world'

const DAY = 24 * 60 * 60_000
const iso = (at: number) => new Date(at).toISOString()

type Spec = { category: string; commands?: string[]; signals?: Record<string, unknown> }
const SPECS: Record<string, Spec> = {
  'mod-store': { category: 'core', commands: ['/mods'], signals: { always: true } },
  'mods-hub': { category: 'core', commands: ['/hub'] },
  'secret-shield': { category: 'security' },
  'cost-meter': { category: 'cost', signals: { always: true } },
  'docker-lint': { category: 'devops', commands: ['/docker-lint'], signals: { files: ['Dockerfile', '**/Dockerfile'] } },
  'react-doctor': { category: 'stacks', signals: { files: ['**/*.jsx'], deps: ['react'] } },
  'sql-safety': { category: 'data', signals: { files: ['*.sql', '**/*.sql'] } },
  standup: { category: 'team', commands: ['/standup'] },
  'todo-pane': { category: 'productivity', commands: ['/todo'] },
  'done-chime': { category: 'notifications' },
  'quiz-me': { category: 'learning', commands: ['/quiz'] },
  'lighthouse-run': { category: 'frontend', commands: ['/lighthouse'] },
}
const PACKS = [
  { id: 'essentials', title: 'Essentials', tagline: 'The best general mods.', mods: ['mod-store', 'mods-hub', 'done-chime', 'todo-pane'] },
  { id: 'web', title: 'Web & Frontend', tagline: 'React and friends.', mods: ['react-doctor', 'docker-lint', 'lighthouse-run'] },
]

const pluginOf = (name: string, category: string) =>
  ({ name, source: `./mods/${name}`, description: `${name} does one thing well.`, version: '1.0.0', category, keywords: [] as string[] })
const specs = (extra = 0): Record<string, Spec> => ({
  ...SPECS,
  ...Object.fromEntries(Array.from({ length: extra }, (_, index) => [`extra-${index + 1}`, { category: 'productivity', commands: [`/extra-${index + 1}`] }])),
})
const dataOf = (all: Record<string, Spec>) => ({
  categories: [...new Set(Object.values(all).map(spec => spec.category))].map(id => ({ id, title: id, tagline: '' })),
  packs: PACKS,
  mods: Object.entries(all).map(([name, spec]) => ({ name, category: spec.category, tier: 'simple', since: '1.0.0', commands: spec.commands ?? [], signals: spec.signals ?? {} })),
})
const OLD = iso(NOW - 90 * DAY)
const installedOf = (names: readonly string[]): Record<string, Install> =>
  Object.fromEntries(names.map(name => [name, { version: '1.0.0', scope: 'user', enabled: true, installedAt: OLD }]))

/** A transcript line: a slash command typed `daysAgo` days ago. */
const ran = (command: string, daysAgo: number) =>
  JSON.stringify({ type: 'user', timestamp: iso(NOW - daysAgo * DAY), message: { role: 'user', content: `<command-name>/${command}</command-name>\n<command-args></command-args>` } })

const SETTINGS_BEFORE = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`
const PROJECT_FILES: Record<string, string | FakeFile> = {
  [`${PROJECT}/Dockerfile`]: 'FROM node:22',
  [`${PROJECT}/package.json`]: JSON.stringify({ dependencies: { react: '^19' } }),
  [`${PROJECT}/node_modules/pg/package.json`]: '{}',
  [`${PROJECT}/src/index.js`]: '',
  [LOCAL_SETTINGS]: SETTINGS_BEFORE,
  [`${TRANSCRIPTS}/s1.jsonl`]: { text: [ran('standup', 1), ran('hub', 1)].join('\n'), mtimeMs: NOW - DAY },
}

/** The world for plans: the catalog above, every mod but lighthouse-run installed, a project and its transcripts. */
function planWorld(on: Parameters<typeof world>[0], options: WorldOptions & { extra?: number } = {}) {
  const all = specs(options.extra)
  const installed = installedOf(Object.keys(all).filter(name => name !== 'lighthouse-run'))
  return world(on, {
    plugins: Object.entries(all).map(([name, spec]) => pluginOf(name, spec.category)),
    data: dataOf(all),
    installed,
    env: { HOME },
    files: PROJECT_FILES,
    ...options,
  })
}

const label = async (ui: { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string) =>
  (await ui.find({ key }))?.props.label

test('/mods profile reads the project, shows what it needs and why, and writes nothing until Apply', async ($, on) => {
  const w = planWorld(on)
  for (const surface of SURFACES) {
    const writes = w.writes.length
    const started = await mods($, 'profile')
    expect(started.text).toBe('◆ Reading this project to see which mods it needs. The lists open in the store; nothing changes until you press Apply.')
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe('◆ app needs 9 of 11 installed mods. Review, then Apply (/mods profile apply).')
    const ui = await $.ui.mount({ ...pane(40, 110), surface })
    expect(await ui.find({ type: 'Text', text: 'app needs 9 of 11 mods' })).toBeDefined()
    expect(await label(ui, 'tab:disable')).toBe('Not needed (2)')
    expect(await label(ui, 'plan:sql-safety')).toBe('☐ sql-safety')
    expect((await ui.find({ key: 'plan-row:sql-safety' }))?.text).toContain('no *.sql or similar here · turns off')
    expect((await ui.find({ key: 'plan-row:quiz-me' }))?.text).toContain('not used in this project')

    await ui.press({ key: 'tab:keep' })
    const reasons = Object.fromEntries(await Promise.all(['docker-lint', 'react-doctor', 'standup', 'mods-hub', 'secret-shield', 'done-chime'].map(async name =>
      [name, (await ui.find({ key: `plan-row:${name}` }))?.text ?? ''])))
    expect(reasons['docker-lint']).toContain('found Dockerfile')
    expect(reasons['react-doctor']).toContain('uses react')
    expect(reasons.standup).toContain('you ran /standup here')
    expect(reasons['mods-hub']).toContain('always on')
    expect(reasons['secret-shield']).toContain('safety guard')
    expect(reasons['done-chime']).toContain('Essentials pack')
    // node_modules is never walked: its pg manifest is not a dependency of the project.
    expect(w.writes).toHaveLength(writes)
    expect(w.calls.some(call => call.includes('plugin disable'))).toBe(false)

    // A flip keeps quiz-me on, in place; Apply then turns off only sql-safety.
    await ui.press({ key: 'tab:disable' })
    await ui.press({ key: 'plan:quiz-me' })
    expect(await label(ui, 'plan:quiz-me')).toBe('☑ quiz-me')
    expect(await label(ui, 'apply')).toBe('Apply (disable 1)')
    await ui.press({ key: 'apply' })
    await w.clock.settle()
    expect(JSON.parse(w.fileText(LOCAL_SETTINGS) ?? '')).toEqual({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'sql-safety@claude-mods': false } })
    expect(await ui.find({ type: 'Text', text: /Profile applied to app: disabled 1 mod\. Written to \.claude\/settings\.local\.json/ })).toBeDefined()
    expect(await ui.find({ key: 'reload' })).toBeDefined()
    expect(await ui.find({ key: 'apply' })).toBeUndefined()

    // Undo puts back exactly what was there.
    await ui.press({ key: 'undo' })
    await w.clock.settle()
    expect(w.fileText(LOCAL_SETTINGS)).toBe(`${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`)
    expect(w.toasts.at(-1)).toBe('✓ Undid the app profile. Reload plugins to apply.')
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'row:sql-safety' })).toBeDefined()
    await ui.unmount()
  }
})

test('the profile view in the store: Profile from the home view, the progress bar while reading, then the plan', async ($, on) => {
  const w = planWorld(on)
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(40, 110), surface: 'terminal' })
  await ui.press({ key: 'profile' })
  // The press only starts the job; the plan screen says it is reading until the lists arrive.
  expect(await ui.find({ type: 'Text', text: /^Reading… the lists appear here/ })).toBeDefined()
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: 'app needs 9 of 11 mods' })).toBeDefined()
  // All on keeps the whole tab: nothing would change, so there is no Apply.
  await ui.press({ key: 'plan-all-on' })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing to change: every mod is already as the plan says.' })).toBeUndefined()
  expect((await mods($, 'profile apply')).text).toBe('• Nothing to change: every mod is already as the plan says.')
  await ui.press({ key: 'plan-all-off' })
  expect((await mods($, 'profile apply')).text).toBe('◆ Applying 2 changes in the background.')
  await w.clock.settle()
  expect(JSON.parse(w.fileText(LOCAL_SETTINGS) ?? '').enabledPlugins).toEqual({ 'sql-safety@claude-mods': false, 'quiz-me@claude-mods': false })
  await ui.press({ key: 'back' })
  expect((await ui.find({ key: 'row:quiz-me' }))?.text).toContain('✓ Disabled')

  // /mods profile reset turns every mod back on here and keeps the rest of the file.
  expect((await mods($, 'profile reset')).text).toBe('◆ Enabling every mod in this project again, in the background.')
  await w.clock.settle()
  expect(JSON.parse(w.fileText(LOCAL_SETTINGS) ?? '')).toEqual({ permissions: { allow: ['Bash(ls)'] } })
  expect(w.toasts.at(-1)).toMatch(/Enabled 2 mods again in app/)
})

test('a malformed settings.local.json is never overwritten', async ($, on) => {
  const broken = '{ "permissions": { "allow": ["Bash(ls)"], }'
  const w = planWorld(on, { files: { ...PROJECT_FILES, [LOCAL_SETTINGS]: broken } })
  await mods($, 'profile')
  await w.clock.settle()
  expect((await mods($, 'profile apply')).text).toBe('◆ Applying 2 changes in the background.')
  await w.clock.settle()
  expect(w.fileText(LOCAL_SETTINGS)).toBe(broken)
  expect(w.writes).toEqual([])
  expect(w.toasts.at(-1)).toBe('✗ Left .claude/settings.local.json untouched: it is not valid JSON. Fix or move it, then apply again.')
  expect((await mods($, 'slim apply')).text).toBe('• Nothing to apply yet: run /mods slim to read the plan first.')
})

const SLIM_FILES: Record<string, string | FakeFile> = {
  ...PROJECT_FILES,
  [`${TRANSCRIPTS}/s1.jsonl`]: { text: ran('todo', 30), mtimeMs: NOW - 30 * DAY },
  [`${CONFIG}/projects/-other/a.jsonl`]: { text: [ran('quiz', 2), ran('mods', 2)].join('\n'), mtimeMs: NOW - 2 * DAY },
  // Over the 4 MiB read cap: read as its newest chunk through tail.
  [`${CONFIG}/projects/-big/b.jsonl`]: { text: `${'x'.repeat(4.5 * 1024 * 1024)}\n${ran('standup', 3)}`, mtimeMs: NOW - 3 * DAY },
}

test('/mods slim finds idle mods from recent transcripts, applies through the CLI at user scope, and Undo enables them', async ($, on) => {
  const w = planWorld(on, { files: SLIM_FILES })
  const started = await mods($, 'slim')
  expect(started.text).toBe('◆ Reading the last 14 days of use. The lists open in the store; nothing changes until you press Apply.')
  await w.clock.settle()
  expect(w.calls.filter(call => call.startsWith('tail'))).toEqual([`tail -c ${3 * 1024 * 1024} ${CONFIG}/projects/-big/b.jsonl`])
  expect(w.toasts.at(-1)).toBe('◆ 2 mods idle for 14 days. Review, then Apply (/mods slim apply).')
  const ui = await $.ui.mount({ ...pane(40, 110), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '2 mods idle for 14 days, of 11 enabled' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^From 2 transcripts covering 3 days/ })).toBeDefined()
  expect((await ui.find({ key: 'plan-row:todo-pane' }))?.text).toContain('no /todo in 14 d')
  expect((await ui.find({ key: 'plan-row:docker-lint' }))?.text).toContain('no /docker-lint in 14 d')
  await ui.press({ key: 'tab:keep' })
  expect((await ui.find({ key: 'plan-row:quiz-me' }))?.text).toContain('used /quiz 2 d ago')
  expect((await ui.find({ key: 'plan-row:standup' }))?.text).toContain('used /standup 3 d ago')
  expect((await ui.find({ key: 'plan-row:secret-shield' }))?.text).toContain('safety guard')
  expect((await ui.find({ key: 'plan-row:done-chime' }))?.text).toContain('works in the background')

  await ui.press({ key: 'apply' })
  await w.clock.settle()
  expect(w.calls).toEqual(expect.arrayContaining([
    'plugin disable docker-lint@claude-mods --scope user --json',
    'plugin disable todo-pane@claude-mods --scope user --json',
  ]))
  expect(w.writes).toEqual([])
  expect(w.installed.get('todo-pane')?.enabled).toBe(false)
  expect(w.toasts.at(-1)).toBe('✓ Disabled 2 idle mods everywhere (docker-lint, todo-pane). Reload plugins to apply.')
  await ui.press({ key: 'undo' })
  await w.clock.settle()
  expect(w.calls).toEqual(expect.arrayContaining([
    'plugin enable docker-lint@claude-mods --scope user --json',
    'plugin enable todo-pane@claude-mods --scope user --json',
  ]))
  expect(w.installed.get('todo-pane')?.enabled).toBe(true)
  expect((await mods($, 'undo')).text).toBe('◆ Undoing the last apply in the background.')
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('• There is nothing to undo.')

  // A second slim reads only what changed: the big transcript comes from the cache, not tail.
  await mods($, 'slim 14')
  await w.clock.settle()
  expect(w.calls.filter(call => call.startsWith('tail'))).toHaveLength(1)
})

test('the weekly slim tip: minutes after an interactive start, only with 30 idle mods, at most weekly, never in Silent', async ($, on) => {
  const w = planWorld(on, { files: SLIM_FILES, extra: 32 })
  const hub = fakeHub(on, { isSilent: true }, w.clock)
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(5 * 60_000)
  expect(w.toasts.filter(toast => toast.includes('unused'))).toEqual([])

  hub.mode = { ...hub.mode, isSilent: false }
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(5 * 60_000)
  expect(w.toasts.filter(toast => toast.includes('unused'))).toEqual([
    '◆ 34 mods unused for 14 days still load on every response · /mods slim to review · /mods slim off hides this tip',
  ])
  // Inside the week: no second tip; turned off: none at all.
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(5 * 60_000)
  expect((await mods($, 'slim off')).text).toBe('◆ The weekly slim tip is off. /mods slim on brings it back.')
  await w.clock.advance(8 * DAY)
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(5 * 60_000)
  expect(w.toasts.filter(toast => toast.includes('unused'))).toHaveLength(1)
})

test('packs: the home shelf, a pack page, Install missing and Enable here as background jobs, and /mods packs', async ($, on) => {
  const w = planWorld(on, {
    files: { ...PROJECT_FILES, [LOCAL_SETTINGS]: JSON.stringify({ enabledPlugins: { 'react-doctor@claude-mods': false } }) },
  })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(40, 110), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /PACKS · START HERE/ })).toBeDefined()
  expect(await label(ui, 'pack:essentials')).toBe('Essentials ✓')
  expect(await label(ui, 'pack:web')).toBe('Web & Frontend 2/3')
  await ui.press({ key: 'pack:web' })
  expect(await ui.find({ type: 'Text', text: 'Web & Frontend' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/3 installed/ })).toBeDefined()
  expect(await label(ui, 'pack-install')).toBe('Install 1 missing')
  expect(await label(ui, 'pack-enable')).toBe('Enable 1 here')

  await ui.press({ key: 'pack-enable' })
  await w.clock.settle()
  expect(JSON.parse(w.fileText(LOCAL_SETTINGS) ?? '').enabledPlugins).toEqual({ 'react-doctor@claude-mods': true })
  expect(w.toasts.at(-1)).toMatch(/^✓ Enabled 1 mod of Web & Frontend in app\. 1 mod of it is not installed/)
  await ui.press({ key: 'pack-install' })
  await w.clock.settle()
  expect(w.calls).toContain('plugin install lighthouse-run@claude-mods --scope user --json')
  expect(w.calls.filter(call => call.startsWith('plugin install'))).toHaveLength(1)
  expect(await ui.find({ key: 'pack-install' })).toBeUndefined()
  await ui.press({ key: 'member:docker-lint' })
  expect(await ui.find({ type: 'Text', text: 'docker-lint' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /3\/3 installed/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'row:docker-lint' })).toBeDefined()

  const listing = (await mods($, 'packs')).text
  expect(listing).toContain('- essentials: Essentials, 4 mods (4 installed). The best general mods.')
  expect(listing).toContain('- web: Web & Frontend, 3 mods (3 installed). React and friends.')
  expect((await mods($, 'pack nope install')).text).toBe('✗ There is no pack named nope. /mods packs lists them.')
})

test('Install all stays available but secondary, with a warning when it would add 50 or more mods', async ($, on) => {
  const w = planWorld(on, { installed: {}, extra: 50 })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(40, 110), surface: 'terminal' })
  expect((await ui.find({ key: 'install-all' }))?.props).toMatchObject({ label: 'Install all (62)', dimColor: true })
  expect(await ui.find({ type: 'Text', text: /^▲ Every enabled mod adds start-up work/ })).toBeDefined()
  await ui.press({ key: 'install-all' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /a profile keeps only what this project needs/ })).toBeDefined()
  await ui.press({ key: 'profile-now' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /^app needs \d+ of 62 mods$/ })).toBeDefined()
})

test('a catalog without project signals is not profiled: everything would read as not needed', async ($, on) => {
  const all = specs()
  const w = planWorld(on, { data: { ...dataOf(all), mods: dataOf(all).mods.map(({ signals: _signals, ...rest }) => rest) } })
  await mods($, 'profile')
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('• The catalog of plagemes/claude-mods@main has no project signals yet, so a profile cannot tell what this project needs. Run /mods refresh once it is updated.')
  expect(w.writes).toEqual([])
})

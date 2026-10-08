import { expect, test } from 'claude-code/testing'

import { fakeHub } from './hub'
import { BIN, CATALOG, DATA, FILES, HOME, MARKETPLACE, mods, NOW, pane, PLUGIN, RAW, SURFACES, world } from './world'

const OUTDATED = {
  'secret-shield': { version: '1.0.0', scope: 'user', enabled: true },
  'git-status-line': { version: '2.0.0', scope: 'project', enabled: true },
}

/** What the helpers below read of a mounted drawing, on any surface. */
type Mounted = {
  find: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ text: string } | undefined>
  findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ key?: string }[]>
}
const rowKeys = async (ui: Mounted) =>
  (await ui.findAll({ type: 'Button' })).map(found => found.key).filter((key): key is string => key?.startsWith('open:') === true)
/** The progress line's text, or undefined when no job runs. */
const progressText = async (ui: Mounted) => (await ui.find({ type: 'Text', text: /^(Installing|Updating|Uninstalling) / }))?.text

test('/mods opens the store and draws the catalog with installed, update and new badges', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const opened = await mods($)
  await w.clock.settle()
  expect(opened.text).toBe('◆ Opened the mod store.')
  expect(w.fetched).toContain(`${RAW}.claude-plugin/marketplace.json`)
  expect(w.fetched).toContain(`${RAW}docs/data/mods.json`)
  expect(w.fetched).not.toContain(`${RAW}catalog.json`)
  expect(w.calls).toContain('plugin list --json')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: 'Claude Mods' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6 available · 2 installed · 1 update' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /plagemes\/claude-mods@main · synced just now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Security & Guardrails$/ })).toBeDefined()
    expect((await ui.find({ key: 'row:secret-shield' }))?.text).toContain('↑ Update 1.2.0')
    expect((await ui.find({ key: 'row:git-status-line' }))?.text).toContain('✓ Installed')
    expect((await ui.find({ key: 'row:cost-meter' }))?.text).toContain('● New')
    expect((await ui.find({ key: 'row:rm-rf-guard' }))?.text).toContain('v1.0.0')
    expect((await ui.find({ key: 'open:mod-store' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true, plain: true })
    // One obvious action per row: Install where it is missing, Update where it is behind, none where it is current.
    expect((await ui.find({ key: 'act:cost-meter' }))?.props).toMatchObject({ label: 'Install' })
    expect((await ui.find({ key: 'act:secret-shield' }))?.props).toMatchObject({ label: 'Update', variant: 'primary' })
    expect(await ui.find({ key: 'act:git-status-line' })).toBeUndefined()
    expect(await ui.find({ key: 'update-all' })).toBeDefined()
    expect(await ui.find({ key: 'search' })).toBeDefined()
    expect(await ui.find({ key: 'category' })).toBeDefined()
    expect(await ui.find({ key: 'status' })).toBeDefined()
    // Terminal glyphs, desktop icons.
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 5 : 0)
    await ui.unmount()
  }
})

test('every surface draws the list and the detail view; mobile picks the status with buttons', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane(40, 50), surface })
    expect(await ui.find({ key: 'search' })).toEqual(surface === 'mobile' ? undefined : expect.objectContaining({ type: 'Input' }))
    expect(await ui.find({ key: 'status:installed' })).toEqual(surface === 'mobile' ? expect.objectContaining({ type: 'Button' }) : undefined)
    if (surface === 'terminal') expect((await ui.find({ key: 'row:cost-meter' }))?.text).not.toContain('Live session cost')
    await ui.press({ key: 'open:secret-shield' })
    expect(await ui.find({ key: 'update' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'row:secret-shield' })).toBeDefined()
    if (surface === 'mobile') {
      await ui.press({ key: 'status:updates' })
      expect(await rowKeys(ui)).toEqual(['open:secret-shield'])
      await ui.press({ key: 'status:all' })
    }
    await ui.unmount()
  }
})

test('search, the category picker and the status picker narrow the list, with an empty state', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    await mods($, 'search guard')
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await rowKeys(ui)).toEqual(['open:rm-rf-guard', 'open:secret-shield'])

    await ui.input({ key: 'search', text: 'status line', kind: 'change' })
    expect(await rowKeys(ui)).toEqual(['open:git-status-line', 'open:cost-meter'])

    await ui.input({ key: 'search', text: '' })
    await ui.select({ key: 'category', value: 'git' })
    expect(await rowKeys(ui)).toEqual(['open:git-status-line', 'open:branch-namer'])
    await ui.select({ key: 'status', value: 'new' })
    expect(await rowKeys(ui)).toEqual(['open:branch-namer'])
    expect((await ui.find({ key: 'status' }))?.props.options).toEqual([
      { value: 'all', label: 'All (2)' },
      { value: 'installed', label: 'Installed (1)' },
      { value: 'updates', label: 'Updates (0)' },
      { value: 'new', label: 'New in v2 (1)' },
    ])
    await ui.select({ key: 'category', value: 'all' })
    await ui.select({ key: 'status', value: 'updates' })
    expect(await rowKeys(ui)).toEqual(['open:secret-shield'])

    await ui.input({ key: 'search', text: 'kubernetes' })
    expect(await ui.find({ type: 'Text', text: 'Nothing matches “kubernetes”.' })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await rowKeys(ui)).toHaveLength(6)
    await ui.unmount()
  }
})

test('the home view features the new picks and, with mods-hub, what mod-advisor recommended', async ($, on) => {
  const extra = [
    { name: 'mods-hub', source: './mods/mods-hub', description: 'The platform.', version: '1.0.0', category: 'ecosystem', keywords: [] },
    { name: 'autopilot', source: './mods/autopilot', description: 'Runs a queue.', version: '1.0.0', category: 'agents', keywords: [] },
  ]
  const w = world(on, { plugins: [...MARKETPLACE.plugins, ...extra] })
  const hub = fakeHub(on, {}, w.clock)
  hub.events.push({ topic: 'mod.recommended', data: { name: 'rm-rf-guard', reason: 'shell-heavy project' }, at: NOW, source: 'mod-advisor' })
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: /NEW IN V2 · PICKS/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('feat:'))).toEqual(['feat:mods-hub', 'feat:autopilot'])
    expect(await ui.find({ type: 'Text', text: /RECOMMENDED FOR THIS PROJECT/ })).toBeDefined()
    await ui.press({ key: 'pick:rm-rf-guard' })
    expect(await ui.find({ type: 'Text', text: 'rm-rf-guard' })).toBeDefined()
    await ui.press({ key: 'back' })
    // A search is not the home view: no shelf.
    await ui.input({ key: 'search', text: 'guard' })
    expect(await ui.find({ key: 'feat:mods-hub' })).toBeUndefined()
    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('the detail view: breadcrumb, hero, commands, settings, README and related mods; installs and offers /reload-plugins', async ($, on) => {
  const w = world(on, { marketplaces: [] })
  await mods($)
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    await ui.press({ key: 'open:secret-shield' })
    await ui.press({ key: 'related:rm-rf-guard' })
    expect(await ui.find({ type: 'Text', text: 'rm-rf-guard' })).toBeDefined()
    await ui.press({ key: 'crumb-category' })
    expect(await rowKeys(ui)).toEqual(['open:secret-shield', 'open:rm-rf-guard'])
    await ui.select({ key: 'category', value: 'all' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'open:cost-meter' })

  expect((await ui.find({ key: 'back' }))?.props).toMatchObject({ label: '← Mods', hotkey: 'b' })
  expect((await ui.find({ key: 'crumb-category' }))?.props).toMatchObject({ label: 'Cost, Tokens & Context', hotkey: 'g' })
  expect(await ui.find({ type: 'Text', text: '● New in v2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Essential' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/cost' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/plugin install cost-meter@claude-mods/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'currency' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Shown after the amount.' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('## What it does\nShows the **cost** of the session.')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/plagemes/claude-mods/blob/main/mods/cost-meter/README.md')
  // The category and the version are said once each.
  expect(await ui.findAll({ type: 'Text', text: /Cost, Tokens & Context/ })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Text', text: /^v1\.1\.0$/ })).toHaveLength(1)

  await ui.press({ key: 'install' })
  await w.clock.settle()
  expect(w.calls).toEqual(expect.arrayContaining([
    'plugin marketplace list --json',
    'plugin marketplace add plagemes/claude-mods --json',
    'plugin install cost-meter@claude-mods --scope user --json',
  ]))
  expect(w.toasts).toContain('✓ Installed cost-meter 1.1.0. Run /reload-plugins to activate it.')
  expect(await ui.find({ type: 'Text', text: /✓ Installed · user/ })).toBeDefined()
  expect(await ui.find({ key: 'install' })).toBeUndefined()
  expect(await ui.find({ key: 'uninstall' })).toBeDefined()

  await ui.press({ key: 'reload' })
  expect(w.commands).toEqual(['reload-plugins'])
  expect(await ui.find({ key: 'reload' })).toBeUndefined()

  await ui.press({ key: 'back' })
  expect((await ui.find({ key: 'row:cost-meter' }))?.text).toContain('✓ Installed')
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
    expect(await ui.find({ type: 'Text', text: '↑ 1.0.0 → 1.2.0' })).toBeDefined()
    expect((await ui.find({ key: 'update' }))?.props).toMatchObject({ label: 'Update to 1.2.0', hotkey: 'u', variant: 'primary' })

    await ui.press({ key: 'update' })
    await w.clock.settle()
    expect(w.calls).toContain('plugin update secret-shield@claude-mods --scope project --json')
    expect(await ui.find({ type: 'Text', text: /Updated secret-shield 1\.0\.0 → 1\.2\.0/ })).toBeDefined()

    await ui.press({ key: 'uninstall' })
    await w.clock.settle()
    expect(w.calls).toContain('plugin uninstall secret-shield@claude-mods --scope project --json')
    expect(w.installed.has('secret-shield')).toBe(false)
    expect(await ui.find({ key: 'install' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a row\'s own Install and Update act on that mod from the list', async ($, on) => {
  const w = world(on, { installed: OUTDATED })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  await ui.press({ key: 'act:branch-namer' })
  await w.clock.settle()
  expect(w.calls).toContain('plugin install branch-namer@claude-mods --scope user --json')
  await ui.press({ key: 'act:secret-shield' })
  await w.clock.settle()
  expect(w.calls).toContain('plugin update secret-shield@claude-mods --scope user --json')
  expect((await ui.find({ key: 'row:branch-namer' }))?.text).toContain('✓ Installed')
  expect(await rowKeys(ui)).toHaveLength(6)
})

// ── Regression: Back during a long install-all ──────────────────────────────

test('Back from a mod page goes to the list and stays there while install-all runs, the bar still moving', async ($, on) => {
  const w = world(on, { slowMs: 1_000 })
  for (const surface of SURFACES) {
    await mods($)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...pane(60), surface })
    // The press only starts the job: it settles while the slow CLI is still on its first mod.
    await ui.press({ key: 'install-all' })
    await w.clock.settle()
    expect(await progressText(ui)).toBe('Installing mod-store · 1/6')
    expect((await ui.find({ key: 'stop' }))?.props).toMatchObject({ hotkey: 's' })

    await ui.press({ key: 'open:cost-meter' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await w.clock.advance(1_000)
    expect(await progressText(ui)).toBe('Installing secret-shield · 2/6')
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    expect(await ui.find({ key: 'row:cost-meter' })).toBeDefined()

    // Every later step writes only the job: the list stays, the bar moves on it.
    for (const [index, name] of ['rm-rf-guard', 'git-status-line', 'branch-namer', 'cost-meter'].entries()) {
      await w.clock.advance(1_000)
      expect(await ui.find({ key: 'back' })).toBeUndefined()
      expect(await progressText(ui)).toBe(`Installing ${name} · ${index + 3}/6`)
    }
    await w.clock.advance(1_000)
    expect(await progressText(ui)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /✓ Installed 6 mods/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    expect(await ui.find({ key: 'reload' })).toBeDefined()
    await ui.unmount()
    w.installed.clear()
    await mods($, 'refresh')
  }
})

test('searching, picking, paging and opening mods while a job runs are never undone by its progress', async ($, on) => {
  const w = world(on, { slowMs: 1_000 })
  await mods($)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(9), surface: 'desktop' })
  await ui.press({ key: 'install-all' })
  await w.clock.settle()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /^Page 2\// })).toBeDefined()
  await w.clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /^Page 2\// })).toBeDefined()
  await ui.input({ key: 'search', text: 'guard', kind: 'change' })
  await w.clock.advance(1_000)
  expect(await rowKeys(ui)).toEqual(['open:rm-rf-guard', 'open:secret-shield'])
  await ui.select({ key: 'category', value: 'security' })
  await w.clock.advance(1_000)
  expect((await ui.find({ key: 'category' }))?.props.value).toBe('security')
  await ui.press({ key: 'open:rm-rf-guard' })
  await w.clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: 'rm-rf-guard' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  // While it runs the page offers no second change.
  expect(await ui.find({ key: 'install' })).toBeUndefined()
  await w.clock.advance(10_000)
  expect(await progressText(ui)).toBeUndefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()
})

// ── Commands answer at once and run in the background ──────────────────────

test('/mods install-all answers at once, opens the store on its progress bar and installs in the background', async ($, on) => {
  const w = world(on, { installed: OUTDATED, marketplaces: [], slowMs: 1_000 })
  for (const surface of SURFACES) {
    w.installed.clear()
    for (const [name, one] of Object.entries(OUTDATED)) w.installed.set(name, one)
    await mods($, 'refresh')
    const before = w.calls.length
    const started = await mods($, 'install-all')
    expect(started.text).toBe('◆ Installing 4 mods in the background. Progress is in the store; s stops it.')
    expect(w.calls.slice(before).some(call => call.startsWith('plugin install'))).toBe(false)
    const ui = await $.ui.mount({ ...pane(), surface })
    await w.clock.settle()
    expect(await progressText(ui)).toBe('Installing mod-store · 1/4')
    expect(surface === 'terminal' ? await ui.find({ type: 'Raster' }) : await ui.find({ type: 'Svg', key: undefined })).toBeDefined()
    await w.clock.advance(1_000)
    expect(await progressText(ui)).toBe('Installing rm-rf-guard · 2/4')
    await w.clock.advance(3_000)
    expect(await progressText(ui)).toBeUndefined()
    const done = '✓ Installed 4 mods (mod-store, rm-rf-guard, branch-namer and 1 more). Run /reload-plugins to activate them.'
    expect(w.toasts).toContain(done)
    expect(await ui.find({ type: 'Text', text: done })).toBeDefined()
    expect(w.calls).toContain('plugin marketplace add plagemes/claude-mods --json')
    const marketplaceUpdate = w.calls.indexOf('plugin marketplace update claude-mods --json', before)
    const installs = w.calls.slice(before).filter(call => call.startsWith('plugin install'))
    expect(installs).toEqual([
      'plugin install mod-store@claude-mods --scope user --json',
      'plugin install rm-rf-guard@claude-mods --scope user --json',
      'plugin install branch-namer@claude-mods --scope user --json',
      'plugin install cost-meter@claude-mods --scope user --json',
    ])
    expect(w.calls.indexOf(installs[0]!, before)).toBeGreaterThan(marketplaceUpdate)

    const again = await mods($, 'install all')
    await w.clock.settle()
    expect(again.text).toBe('◆ Installing 0 mods in the background. Progress is in the store; s stops it.')
    expect(await ui.find({ type: 'Text', text: '• Every mod is already installed.' })).toBeDefined()
    await ui.unmount()
  }
})

test('a second install-all while one runs is refused, and /mods stop stops it after the current mod', async ($, on) => {
  const w = world(on, { slowMs: 1_000 })
  await mods($, 'refresh')
  await mods($, 'install-all')
  await w.clock.settle()
  const second = await mods($, 'install-all')
  expect(second.text).toBe('• Installing every mod not yet installed is still running. Wait for it, or stop it with s in the store or /mods stop.')
  expect((await mods($, 'update cost-meter')).text).toContain('is still running')
  expect((await mods($, 'stop')).text).toBe('◆ Stopping after the mod it is on.')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await progressText(ui)).toBe('Installing mod-store · 1/6 · stopping after this one')
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await w.clock.advance(5_000)
  expect(w.calls.filter(call => call.startsWith('plugin install'))).toEqual(['plugin install mod-store@claude-mods --scope user --json'])
  expect(await ui.find({ type: 'Text', text: '✓ Installed 1 mod (mod-store). Stopped with 5 mods left. Run /reload-plugins to activate it.' })).toBeDefined()
  expect((await mods($, 'stop')).text).toBe('• Nothing is running.')
})

test('the Stop button stops a job on both surfaces', async ($, on) => {
  const w = world(on, { slowMs: 1_000 })
  for (const surface of SURFACES) {
    const before = w.calls.length
    await mods($, 'refresh')
    const ui = await $.ui.mount({ ...pane(), surface })
    await ui.press({ key: 'install-all' })
    await w.clock.settle()
    await w.clock.advance(1_000)
    await ui.press({ key: 'stop' })
    await w.clock.advance(5_000)
    expect(w.calls.slice(before).filter(call => call.startsWith('plugin install'))).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /Installed 2 mods \(mod-store, secret-shield\)\. Stopped with 4 mods left\./ })).toBeDefined()
    await ui.unmount()
    w.installed.clear()
    await mods($, 'refresh')
  }
})

test('a failed or crashed install does not stop the rest: the summary names it and Retry installs it again', async ($, on) => {
  const w = world(on, { installed: OUTDATED, refuses: ['rm-rf-guard'], crashes: ['branch-namer'] })
  await mods($, 'refresh')
  await mods($, 'install-all')
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({
    type: 'Text',
    text: '✓ Installed 2 mods (mod-store, cost-meter). Failed: rm-rf-guard (Plugin rm-rf-guard failed validation); branch-namer (spawn claude EAGAIN). Run /reload-plugins to activate them.',
  })).toBeDefined()
  expect((await ui.find({ key: 'retry-failed' }))?.props).toMatchObject({ label: 'Retry 2 failed mods', hotkey: 't' })
  expect(await ui.find({ key: 'reload' })).toBeDefined()
  await ui.press({ key: 'retry-failed' })
  await w.clock.settle()
  expect(w.calls.filter(call => call === 'plugin install rm-rf-guard@claude-mods --scope user --json')).toHaveLength(2)
  expect(w.calls.filter(call => call.startsWith('plugin install mod-store'))).toHaveLength(1)
})

test('/mods update-all answers at once and updates every outdated mod after refreshing the marketplace', async ($, on) => {
  const w = world(on, {
    installed: {
      ...OUTDATED,
      'cost-meter': { version: '1.0.0', scope: 'user', enabled: true },
    },
    slowMs: 1_000,
  })
  await mods($, 'refresh')
  const started = await mods($, 'update-all')
  expect(started.text).toBe('◆ Updating 2 mods in the background. Progress is in the store; s stops it.')
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await w.clock.settle()
  expect(await progressText(ui)).toBe('Updating secret-shield · 1/2')
  await w.clock.advance(2_000)
  expect(w.toasts).toContain('✓ Updated secret-shield 1.0.0 → 1.2.0, cost-meter 1.0.0 → 1.1.0. Run /reload-plugins to apply.')
  const marketplaceUpdate = w.calls.indexOf('plugin marketplace update claude-mods --json')
  expect(marketplaceUpdate).toBeGreaterThan(-1)
  expect(w.calls.indexOf('plugin update secret-shield@claude-mods --scope user --json')).toBeGreaterThan(marketplaceUpdate)
  expect(w.calls).not.toContain('plugin update git-status-line@claude-mods --scope project --json')

  await mods($, 'update-all')
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe('• Every installed mod is up to date.')
})

test('/mods install <mod> runs in the background too, and still says at once when there is no such mod', async ($, on) => {
  const w = world(on, { marketplaces: [], slowMs: 1_000 })
  await mods($, 'refresh')
  expect((await mods($, 'install no-such-mod')).text).toBe('✗ There is no mod named no-such-mod in plagemes/claude-mods.')
  const started = await mods($, 'install cost-meter')
  expect(started.text).toBe('◆ Installing cost-meter in the background. Progress is in the store; s stops it.')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  await w.clock.settle()
  expect(await progressText(ui)).toBe('Installing cost-meter')
  await w.clock.advance(1_000)
  expect(w.toasts).toContain('✓ Installed cost-meter 1.1.0. Run /reload-plugins to activate it.')
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
  await ui.select({ key: 'category', value: 'git' })
  expect((await ui.find({ key: 'install-all' }))?.props).toMatchObject({ label: 'Install all (1)' })
  await ui.press({ key: 'install-all' })
  await w.clock.settle()
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
    expect((await ui.find({ key: 'refresh' }))?.props).toMatchObject({ label: 'Retry', hotkey: 'r' })
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
  // A catalog cached before the store knew releases has no New picker.
  expect((await ui.find({ key: 'status' }))?.props.options).toHaveLength(3)
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

test('without the site\'s data the store reads catalog.json', async ($, on) => {
  delete FILES['docs/data/mods.json']
  try {
    const w = world(on)
    await mods($, 'refresh')
    expect(w.fetched).toContain(`${RAW}catalog.json`)
    const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^Security & Guardrails$/ })).toBeDefined()
  } finally {
    FILES['docs/data/mods.json'] = JSON.stringify(DATA)
  }
})

test('the pane pages long lists and repeats the category heading', async ($, on) => {
  const w = world(on)
  await mods($)
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(9), surface })
    expect(await ui.find({ type: 'Text', text: 'Page 1/3' })).toBeDefined()
    expect(await ui.find({ key: 'prev' })).toBeUndefined()
    expect(await rowKeys(ui)).toEqual(['open:mod-store', 'open:secret-shield'])
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: 'Page 2/3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(continued)' })).toBeDefined()
    expect(await rowKeys(ui)).toEqual(['open:rm-rf-guard', 'open:git-status-line'])
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

test('commands report usage, and a listing when the pane could not be placed', async ($, on) => {
  const w = world(on, { isPlaced: false, installed: OUTDATED })
  const usage = await mods($, 'install')
  expect(usage.text).toContain('/mods install needs the name of one mod.')
  const listing = await mods($, 'search guard')
  expect(listing.text).toBe([
    '◆ 2 mods match "guard" (the store pane could not be shown here).',
    '- rm-rf-guard: Stops recursive deletes outside the project.',
    '- secret-shield [update 1.2.0]: Blocks reads of .env files and other secrets.',
  ].join('\n'))
  const started = await mods($, 'install cost-meter')
  expect(started.text).toBe('◆ Installing cost-meter in the background. A toast says when it is done; /mods stop stops it.')
  await w.clock.settle()
  expect(w.toasts).toContain('✓ Installed cost-meter 1.1.0. Run /reload-plugins to activate it.')
})

test('a repository setting that is not owner/repo is reported instead of fetched', { options: { repository: 'not a repo' } }, async ($, on) => {
  const w = world(on)
  const report = await mods($, 'refresh')
  expect(report.text).toBe('✗ Could not load the catalog: the repository setting "not a repo" is not owner/repo.')
  expect(w.fetched).toEqual([])
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /is not owner\/repo/ })).toBeDefined()
})

test('with mods-hub: says hello and publishes mod.installed for every install and update, with the version', async ($, on) => {
  const w = world(on, { marketplaces: [], installed: { 'secret-shield': { version: '1.0.0', scope: 'user', enabled: true } }, anyRead: '{"version":"1.0.0"}' })
  const hub = fakeHub(on, {}, w.clock)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  // The hello goes out after session.start returned (afterStart: within 1.35 s), never inside it.
  expect(hub.hellos).toEqual([])
  await w.clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['mod.installed'], consumes: ['mod.recommended'] }])

  await mods($, 'install cost-meter')
  await w.clock.settle()
  await mods($, 'update secret-shield')
  await w.clock.settle()
  await mods($, 'install-all')
  await w.clock.settle()
  expect(hub.published).toEqual([
    { topic: 'mod.installed', data: { name: 'cost-meter', version: '1.1.0' } },
    { topic: 'mod.installed', data: { name: 'secret-shield', version: '1.2.0' } },
    { topic: 'mod.installed', data: { name: 'mod-store', version: '1.0.0' } },
    { topic: 'mod.installed', data: { name: 'rm-rf-guard', version: '1.0.0' } },
    { topic: 'mod.installed', data: { name: 'git-status-line', version: '2.0.0' } },
    { topic: 'mod.installed', data: { name: 'branch-namer', version: '1.0.0' } },
  ])
})

test('with mods-hub: a failed install and an uninstall publish nothing', async ($, on) => {
  const w = world(on, { installed: { 'cost-meter': { version: '1.1.0', scope: 'user', enabled: true } }, refuses: ['branch-namer'] })
  const hub = fakeHub(on, {}, w.clock)
  await mods($, 'uninstall cost-meter')
  await w.clock.settle()
  await mods($, 'install branch-namer')
  await w.clock.settle()
  expect(hub.published).toEqual([])
  expect(w.toasts).toContain('✗ Could not install branch-namer: Plugin branch-namer failed validation')
})

test('without mods-hub installing works exactly as before', async ($, on) => {
  const w = world(on, { marketplaces: [] })
  await mods($, 'install cost-meter')
  await w.clock.settle()
  expect(w.toasts).toContain('✓ Installed cost-meter 1.1.0. Run /reload-plugins to activate it.')
  expect(w.installed.has('cost-meter')).toBe(true)
})

test('when the installed mods cannot be read, the store says so instead of counting zero', async ($, on) => {
  const w = world(on, { listFails: true })
  const report = await mods($, 'refresh')
  expect(report.text).toBe('◆ 6 mods in 4 categories, install status unavailable (spawn claude ENOENT).')
  await mods($, 'update-all')
  await w.clock.settle()
  expect(w.toasts).toContain('✗ Could not read the installed mods: spawn claude ENOENT')
  expect(w.calls.some(call => call.startsWith('plugin update'))).toBe(false)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'install status unknown' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /▲ Install status unavailable/ }))?.props).toMatchObject({ wrap: 'wrap' })
  expect(await ui.find({ type: 'Text', text: /0 installed/ })).toBeUndefined()
  expect(await ui.find({ key: 'act:cost-meter' })).toBeUndefined()
})

test('in the desktop app, where claude is not on PATH, the store runs the claude the app installed', async ($, on) => {
  // The macOS layout: its absolute paths read the same on every host the tests run on. The Windows layout
  // (%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe) is covered by the path helpers in catalog.test.ts.
  const root = `${HOME}/Library/Application Support/Claude/claude-code`
  const w = world(on, {
    installed: OUTDATED,
    desktop: {
      env: { HOME },
      version: '2.1.286',
      bin: `${root}/2.1.286/635c/claude`,
      folders: {
        [root]: [{ name: '2.1.284', kind: 'dir' }, { name: '2.1.286', kind: 'dir' }],
        [`${root}/2.1.284`]: [{ name: 'aaaa', kind: 'dir' }],
        [`${root}/2.1.284/aaaa`]: [{ name: 'claude', kind: 'file' }],
        [`${root}/2.1.286`]: [{ name: '635c', kind: 'dir' }],
        [`${root}/2.1.286/635c`]: [{ name: 'claude', kind: 'file' }],
      },
    },
  })
  const report = await mods($, 'refresh')
  expect(report.text).toBe('◆ 6 mods in 4 categories, 2 installed, 1 update available.')
  expect(w.calls).toContain('plugin list --json')
})

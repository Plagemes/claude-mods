import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { categoryOf, glyphOf } from '../hooks/icons'
import { ago, badge, controlLine, feedRow, fit, headerCounts, modePill, statusReport, statusText, tabLayout } from '../hooks/look'
import { DEFAULT_PREFS, deriveMode } from '../hooks/router'
import type { ModsControl, ModsInstalled, ModsNotice } from '../types'

const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()
const HERE = deriveMode(DEFAULT_PREFS, 'here', NOON, 12 * 60)
const EMPTY: ModsInstalled = { hello: [], plugins: [], listedAt: null }
const STOP: ModsControl = { id: 'c1', action: 'stop', scope: 'all', reason: 'STOP from the phone', by: 'owner', session: 's', source: 'whatsapp-bridge', at: NOON }

describe('look', () => {
  test('the mode pill: presence first, Silent and Night after it', () => {
    expect(modePill(HERE, NOON)).toEqual({ text: '● Here', tone: 'success' })
    expect(modePill({ ...HERE, presence: 'away' }, NOON)).toEqual({ text: '○ Away', tone: 'claude' })
    expect(modePill({ ...HERE, isSilent: true, silentUntil: NOON + 12 * 60_000, isNight: true }, NOON).text).toBe('● Here · Silent 12m · Night')
  })

  test('the status line says only what differs from a quiet afternoon', () => {
    expect(statusText(HERE, null, NOON)).toBeUndefined()
    expect(statusText({ ...HERE, isSilent: true, silentUntil: null, presence: 'away' }, STOP, NOON)).toBe('▪ silent · away · stopped')
    expect(controlLine(STOP)).toMatchObject({ isHalted: true, text: '⏹ Stopped by owner: STOP from the phone · every session' })
    expect(controlLine({ ...STOP, action: 'resume' }).isHalted).toBe(false)
  })

  test('feed rows have fixed columns: a three-cell time, the glyph, a padded badge', () => {
    const notice: ModsNotice = { id: 'n1', level: 'error', title: 'CI failed', body: 'acme/shop\nmain', source: 'ci-watch', at: NOON - 5 * 60_000, targets: ['toast', 'phone'], held: false }
    expect(feedRow(notice, NOON)).toEqual({ when: ' 5m', glyph: '✗', tone: 'error', source: 'ci-watch', text: 'CI failed — acme/shop main', where: '→ phone' })
    expect(feedRow({ ...notice, held: true }, NOON).where).toBe('held for the morning')
    expect(['now', '59m', '3h', '2d'].map(text => text.length <= 3)).toEqual([true, true, true, true])
    expect(ago(30_000)).toBe('now')
    expect(badge('a-very-long-mod-name', 10)).toBe('a-very-lo…')
    expect(badge('ci-watch', 10)).toBe('ci-watch  ')
  })

  test('/hub status is aligned rows under the header line', () => {
    const report = statusReport({ mode: HERE, modeLine: 'here · interaction auto', control: null, channels: [], tabs: [], installed: EMPTY })
    expect(report.split('\n')).toEqual([
      '▪▪▪ Claude Mods · Hub',
      'Mode      here · interaction auto',
      'Work      running',
      'Channels  none registered (install a bridge such as whatsapp-bridge or desktop-notify)',
      'Tabs      1: home',
      'Mods      0 mods · 0 on the bus',
    ])
    expect(headerCounts(EMPTY, [], [])).toBe('0 mods · 0 tabs · 0 channels')
  })

  test('a tab carries its owner category glyph; an unknown owner falls back to the Slot', () => {
    expect(categoryOf('cost-meter')).toBe('cost')
    expect(glyphOf(categoryOf('cost-meter'))).toBe('◔')
    expect(categoryOf('someone-elses-mod')).toBe('core')
  })
})

// ── The panel on every surface ──────────────────────────────────────────────────────────────────────

const probe: Plugin = {
  name: 'probe',
  register(on) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !String(e.command).startsWith('probe ')) return next(e)
      const call = JSON.parse(String(e.command).slice(6)) as { method: string; input: never }
      try {
        let value: unknown
        switch (call.method) {
          case 'notify': value = await $.mods.notify(call.input); break
          case 'registerTab': value = await $.mods.registerTab(call.input); break
          case 'registerChannel': value = await $.mods.registerChannel(call.input); break
          case 'setMode': value = await $.mods.setMode(call.input); break
        }
        return { result: JSON.stringify({ value }) }
      } catch (error) {
        return { result: JSON.stringify({ error: String(error) }) }
      }
    })
  },
}

/** A second stand-in mod with no tab of its own: `bare {json}` registers its channel. */
const bare: Plugin = {
  name: 'bare',
  register(on) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !String(e.command).startsWith('bare ')) return next(e)
      const call = JSON.parse(String(e.command).slice(5)) as { input: never }
      return { result: JSON.stringify({ value: await $.mods.registerChannel(call.input) }) }
    })
  },
}

function world(on: On) {
  const clock = mock.clock(on, { now: NOON })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, string>()
  const statuses: (string | undefined)[] = []
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  return { clock, files, statuses }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })

async function mods($: Engine, method: string, input: unknown = {}, as = 'probe'): Promise<{ value?: any; error?: string }> {
  const ran = await $.tool.call({ tool: 'Bash', command: `${as} ${JSON.stringify({ method, input })}` })
  return JSON.parse(String((ran as { result?: unknown }).result)) as { value?: any; error?: string }
}

const pane = (columns: number, rows = 40): RenderPropsOf['Pane'] => ({ title: 'Claude Mods', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} })

const SURFACES = [
  { surface: 'terminal', columns: 48, label: 'terminal, narrow' },
  { surface: 'terminal', columns: 160, label: 'terminal, wide' },
  { surface: 'desktop', columns: 120, label: 'desktop' },
  { surface: 'mobile', columns: 40, label: 'mobile' },
] as const

for (const { surface, columns, label } of SURFACES) {
  test(`the panel frame and Home on the ${label}`, { plugins: [probe] }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.settle()
    for (let i = 0; i < 11; i += 1) await mods($, 'registerTab', { id: `t${i}`, title: `Tab ${i}`, order: i })
    await mods($, 'registerChannel', { id: 'phone', title: 'WhatsApp', audience: 'me', delivery: 'push', status: 'connected' })
    await mods($, 'notify', { level: 'error', title: 'CI failed', body: 'acme/shop' })
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: pane(columns) })
    const isTerminal = surface === 'terminal'

    // Header: the name, the counts (when there is room) and the mode as a pill.
    expect(await ui.find({ type: 'Text', text: ' · Hub' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● Here' })).toBeDefined()
    const counts = await ui.find({ type: 'Text', text: '0 mods · 11 tabs · 1 channel' })
    if (columns >= 64) expect(counts).toBeDefined()
    else expect(counts).toBeUndefined()
    // The mark and the tab icons: glyphs in the terminal, Svg elsewhere.
    // The mark is the first Svg off the terminal; the terminal draws glyphs only.
    const mark = await ui.find({ type: 'Svg' })
    if (isTerminal) expect(mark).toBeUndefined()
    else expect(mark?.props).toMatchObject({ alt: 'Claude Mods' })
    const tabSlot = JSON.stringify(await ui.find({ key: 'slot-tab-t0' }))
    expect(tabSlot.includes('"type":"Svg"')).toBe(!isTerminal)

    // Tabs: digits 0-9 on the pinned row; the tenth tab on goes behind More (a menu on the desktop, a dim second row
    // on the terminal, a fold on the phone); the shown one is the primary.
    expect((await ui.find({ key: 'tab-home' }))?.props).toMatchObject({ hotkey: '0', variant: 'primary' })
    expect((await ui.find({ key: 'tab-t8' }))?.props).toMatchObject({ hotkey: '9', dimColor: true, label: isTerminal ? '▦ Tab 8' : 'Tab 8' })
    if (surface === 'desktop') {
      expect(await ui.find({ key: 'tab-t9' })).toBeUndefined()
      expect((await ui.find({ key: 'tab-more' }))?.props).toMatchObject({ value: '·more', options: [{ label: 'More · 2' }, { value: 't9' }, { value: 't10' }] })
    } else if (surface === 'mobile') {
      expect(await ui.find({ key: 'tab-t9' })).toBeUndefined()
      await ui.press({ key: 'tab-more' })
      expect(await ui.find({ key: 'tab-t9' })).toBeDefined()
      expect((await ui.find({ key: 'tab-t9' }))?.props.hotkey).toBeUndefined()
      await ui.press({ key: 'tab-more' })
    } else {
      const tenth = await ui.find({ key: 'tab-t9' })
      expect(tenth).toBeDefined()
      expect(tenth?.props.hotkey).toBeUndefined()
    }

    // Mode as segmented controls, the current value the primary.
    expect((await ui.find({ key: 'interaction-auto' }))?.props).toMatchObject({ variant: 'primary' })
    expect((await ui.find({ key: 'interaction-off' }))?.props).toMatchObject({ variant: 'secondary', dimColor: true })
    expect((await ui.find({ key: 'presence-here' }))?.props).toMatchObject({ variant: 'primary' })

    // Channels with a health dot; the feed row with its time, glyph and badge, one line each.
    expect(await ui.find({ type: 'Text', text: 'WhatsApp' })).toBeDefined()
    const dot = JSON.stringify(await ui.find({ key: 'dot-phone' }))
    expect(dot).toContain(isTerminal ? '●' : '"alt":"connected"')
    const row = await ui.find({ type: 'Text', text: 'CI failed — acme/shop' })
    expect(row?.props).toMatchObject({ wrap: 'truncate-end' })
    expect(await ui.find({ type: 'Text', text: 'now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗' })).toBeDefined()

    // The control strip: Pause holds the work in this session; the strip keeps its one line and offers Resume.
    await ui.press({ key: 'control-pause' })
    expect(await ui.find({ key: 'resume' })).toBeDefined()
    expect(await ui.find({ key: 'control-pause' })).toBeUndefined()
    expect(w.statuses.at(-1)).toBe('▪ paused')
    await ui.press({ key: 'resume' })
    expect(await ui.find({ key: 'control-pause' })).toBeDefined()
    expect(w.statuses.at(-1)).toBeUndefined()

    // A segment press changes the shared prefs; the pill follows Silent.
    await ui.press({ key: 'silent-on' })
    expect((await ui.find({ key: 'silent-on' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ type: 'Text', text: '● Here · Silent' })).toBeDefined()
    expect(w.statuses.at(-1)).toBe('▪ silent')
    await ui.unmount()
  })
}

test('empty states: no channels, nothing in Recent, a tab whose owner draws nothing', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'mods-hub', surface: 'desktop', component: 'Pane', requestId: 'claude-mods', props: pane(100) })
  expect(await ui.find({ type: 'Text', text: "Nothing yet. Notifications and other mods' toasts land here." })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No channels yet: whatsapp-bridge, telegram-bridge, slack-bridge or desktop-notify reach you away from the terminal.' })).toBeDefined()
  await mods($, 'registerTab', { id: 'quiet', title: 'Quiet', command: 'quiet' })
  await w.clock.settle()
  await ui.press({ key: 'tab-quiet' })
  expect(await ui.find({ type: 'Text', text: 'Quiet has nothing to show here yet.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/quiet opens it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'by probe · full view: /quiet' })).toBeDefined()
  await ui.unmount()
})

// ── Never past the edge: long hints, many tabs, long Recent rows ───────────────────────────────────

/** The 25 tabs of a full install, by the order convention (docs/ARCHITECTURE.md). */
const MANY_TABS = [
  'Advisor', 'Router', 'Mission Control', 'Autopilot', 'Workflows', 'Brain', 'Guardian', 'Channels', 'Cost', 'Context',
  'Tests', 'Errors', 'Slack', 'Discord', 'Issues', 'Telegram', 'Queue', 'Team', 'Calendar', 'Changes', 'Files', 'Tasks',
  'Timeline', 'Notes', 'Stats',
].map((title, index) => ({ id: title.toLowerCase().replace(/\s+/g, '-'), title, order: (index + 1) * 10 }))

const LONG_HINT = 'Set the sender address (`from`), for example "Acme Studio <digest@acme.studio>", and an API key in the plugin options, then run /email-digest test to send yourself one.'

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown }

/** Every element of a drawn tree, depth first, with the plain text each Text shows. */
function walk(tree: unknown, out: { type: string; props: Record<string, unknown>; text: string }[] = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) walk(child, out)
    return out
  }
  const node = tree as Node
  const textOf = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(textOf).join('') : value !== null && typeof value === 'object' ? textOf((value as Node).children) : ''
  out.push({ type: String(node.type), props: node.props ?? {}, text: node.type === 'Text' ? textOf(node.children) : '' })
  walk(node.children, out)
  return out
}

test('fit cuts to the cells with an ellipsis; the tab layout pins 0-9 and fits the terminal row', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('a  long\nline of text', 8)).toBe('a long…')
  expect([...fit('x'.repeat(500), 40)].length).toBe(40)
  const tabs = MANY_TABS.map(tab => ({ ...tab, owner: 'someone' }))
  for (const columns of [56, 96, 180]) {
    const layout = tabLayout(tabs, { currentId: 'stats', columns, isRow: true, labelOf: tab => `▦ ${tab.title}` })
    expect(layout.pinned.map(tab => tab.title)).toEqual(MANY_TABS.slice(0, 9).map(tab => tab.title))
    expect(layout.overflow).toHaveLength(16)
    // The second row and its `+N more ▾` fit; the shown tab (the last one) is always on it.
    const used = layout.shown.reduce((sum, tab, index) => sum + tab.title.length + 2 + (index === 0 ? 0 : 2), 0)
    expect(used + (layout.hidden.length === 0 ? 0 : 10)).toBeLessThanOrEqual(columns)
    expect(layout.shown.map(tab => tab.id)).toContain('stats')
    expect(layout.shown.length + layout.hidden.length).toBe(16)
  }
  const menu = tabLayout(tabs, { currentId: undefined, columns: 100, isRow: false, labelOf: tab => tab.title })
  expect(menu.shown).toEqual([])
  expect(menu.hidden).toHaveLength(16)
})

const WIDE = [
  { surface: 'desktop', columns: 96, label: 'desktop side panel (about 800px)' },
  { surface: 'terminal', columns: 56, label: 'terminal at 56 columns' },
  { surface: 'terminal', columns: 180, label: 'terminal at 180 columns' },
  { surface: 'mobile', columns: 40, label: 'phone' },
] as const

for (const { surface, columns, label } of WIDE) {
  test(`nothing runs past the edge on the ${label}: long channel hints, 25 tabs, long Recent rows`, { plugins: [probe, bare] }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.settle()
    for (const tab of MANY_TABS) await mods($, 'registerTab', tab)
    await mods($, 'registerChannel', { id: 'email', title: 'Email digest', audience: 'me', delivery: 'pull', status: 'unconfigured', detail: LONG_HINT }, 'bare')
    await mods($, 'registerChannel', { id: 'slack', title: 'Slack', audience: 'team', delivery: 'push', status: 'unconfigured', detail: 'No Slack credentials: set the botToken and channelId options, or run /slack-bridge setup to paste them.' })
    await mods($, 'registerChannel', { id: 'telegram', title: 'Telegram', audience: 'me', delivery: 'push', status: 'error', detail: 'The bot token was refused by api.telegram.org (401 Unauthorized); make a new one with @BotFather.' })
    await mods($, 'registerChannel', { id: 'desktop', title: 'Desktop', audience: 'me', delivery: 'push', status: 'connected' })
    const updated = Array.from({ length: 12 }, (_, i) => `mod-number-${i} 1.0.${i} → 1.0.${i + 1}`).join(', ')
    await mods($, 'notify', { level: 'success', title: `Updated ${updated}. Run /reload-plugins to apply.` })
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: pane(columns, 60) })

    const elements = walk(await ui.drawn())
    // Every one-line Text is cut to the pane; the texts that wrap do so on purpose and stay within two lines.
    for (const one of elements.filter(el => el.type === 'Text')) {
      const cells = [...one.text].length
      if (one.props.wrap === 'wrap') expect(cells).toBeLessThanOrEqual(2 * columns)
      else expect(cells).toBeLessThanOrEqual(columns)
    }
    // Every Box that grows into the rest of its row may shrink below its text (the desktop's flex needs minWidth 0).
    for (const box of elements.filter(el => el.type === 'Box' && el.props.flexGrow === 1)) expect(box.props.minWidth).toBe(0)

    // Channels: a short state in the row, the hint dim and wrapping under it, a switch drawn like the mode's segments.
    expect(await ui.find({ type: 'Text', text: 'Not set up' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Error$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Connected$/ })).toBeDefined()
    const hint = await ui.find({ type: 'Text', text: /^Set the sender address/ })
    expect(hint?.props).toMatchObject({ dimColor: true, wrap: 'wrap' })
    expect(await ui.find({ type: 'Button', text: /^\[o(n|ff)\]$/ })).toBeUndefined()
    expect((await ui.find({ key: 'channel-email-on' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ key: 'setup-email' })).toBeDefined()
    expect(await ui.find({ key: 'setup-telegram' })).toBeDefined()
    expect(await ui.find({ key: 'setup-desktop' })).toBeUndefined()
    await ui.press({ key: 'channel-email-off' })
    expect((await ui.find({ key: 'channel-email-off' }))?.props).toMatchObject({ variant: 'primary' })
    expect(JSON.parse(w.files.get('/home/me/.claude/claude-mods/hub/prefs.json') ?? '{}').channels?.email?.isEnabled).toBe(false)

    // Set up with no tab of the owner's: the whole hint unfolds with where the options live; again, it folds.
    await ui.press({ key: 'setup-email' })
    expect(await ui.find({ type: 'Text', text: LONG_HINT })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Its options: /plugin, then bare.' })).toBeDefined()
    await ui.press({ key: 'setup-email' })
    expect(await ui.find({ type: 'Text', text: 'Its options: /plugin, then bare.' })).toBeUndefined()

    // Recent: one line, cut with an ellipsis.
    const recent = await ui.find({ type: 'Text', text: /^Updated mod-number-0/ })
    expect(recent?.props).toMatchObject({ wrap: 'truncate-end' })
    expect(String(recent?.text).endsWith('…')).toBe(true)

    // Tabs: 0-9 pinned, the rest behind More.
    expect((await ui.find({ key: 'tab-cost' }))?.props).toMatchObject({ hotkey: '9' })
    expect((await ui.find({ key: 'tab-context' }))?.props.hotkey).toBeUndefined()
    if (surface === 'desktop') {
      expect(await ui.find({ key: 'tab-stats' })).toBeUndefined()
      await (ui as unknown as { select: (target: { key: string; value: string }) => Promise<unknown> }).select({ key: 'tab-more', value: 'stats' })
      expect((await ui.find({ key: 'tab-more' }))?.props).toMatchObject({ value: 'stats' })
      expect(await ui.find({ type: 'Text', text: 'Stats has nothing to show here yet.' })).toBeDefined()
    } else {
      if ((await ui.find({ key: 'tab-more' })) !== undefined) await ui.press({ key: 'tab-more' })
      expect(await ui.find({ key: 'tab-stats' })).toBeDefined()
      await ui.press({ key: 'tab-stats' })
      expect(await ui.find({ type: 'Text', text: 'Stats has nothing to show here yet.' })).toBeDefined()
      // A tab press folds More again; the shown tab stays on the bar (the terminal's second row, the phone's More).
      if (surface === 'terminal') expect((await ui.find({ key: 'tab-stats' }))?.props).toMatchObject({ variant: 'primary' })
      else expect((await ui.find({ key: 'tab-more' }))?.props).toMatchObject({ label: 'Stats ▾' })
    }
    // Set up of a channel whose owner has a tab opens that tab in the panel.
    await ui.press({ key: 'tab-home' })
    await ui.press({ key: 'setup-slack' })
    expect(await ui.find({ type: 'Text', text: 'CHANNELS' })).toBeUndefined()
    await ui.unmount()
  })
}

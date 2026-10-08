import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { categoryOf, glyphOf } from '../hooks/icons'
import { ago, badge, controlLine, feedRow, headerCounts, modePill, statusReport, statusText } from '../hooks/look'
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

async function mods($: Engine, method: string, input: unknown = {}): Promise<{ value?: any; error?: string }> {
  const ran = await $.tool.call({ tool: 'Bash', command: `probe ${JSON.stringify({ method, input })}` })
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

    // Tabs: digits 0-9 only, every tab still on the bar; the shown one is the primary.
    expect((await ui.find({ key: 'tab-home' }))?.props).toMatchObject({ hotkey: '0', variant: 'primary' })
    expect((await ui.find({ key: 'tab-t8' }))?.props).toMatchObject({ hotkey: '9', dimColor: true, label: isTerminal ? '▦ Tab 8' : 'Tab 8' })
    const tenth = await ui.find({ key: 'tab-t9' })
    expect(tenth).toBeDefined()
    expect(tenth?.props.hotkey).toBeUndefined()

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

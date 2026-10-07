import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, OPTIONS, configured, lead, pass, say, sends, OWNER, GROUP, world } from './fake'
import { hub, hubSet, hubState } from './mods-hub'

const plugins = [hub]
const PANE: RenderPropsOf['Pane'] = { title: 'Telegram', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const ownPane = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>(surface: S) => ({ plugin: 'telegram-bridge', surface, component: 'Pane' as const, requestId: 'telegram-bridge', props: PANE })
const hubPane = <S extends 'terminal' | 'desktop'>(surface: S) => ({ plugin: 'telegram-bridge', surface, component: 'Pane' as const, requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods', bodyColumns: 96 } })

const prefs = (seen: ReturnType<typeof world>) => JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}') as { paused?: boolean }

test('the status tab shows the connection, mode, sessions and recent messages, and its buttons act, on terminal and desktop', { plugins, options: OPTIONS }, async ($, on) => {
  const seen = world(on, { files: configured() })
  await lead($, seen)
  say(seen, { chatId: GROUP, fromId: OWNER, text: 'coda: una nota' })
  await pass(seen, 4_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(ownPane(surface))
    expect(await ui.find({ type: 'Text', text: /Connected/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /@claude_bot/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Interaction auto \(Claude may ask\)/ })).toBeDefined()
    expect(await ui.find({ key: 'sessions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#login shop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /← coda: una nota/ })).toBeDefined()
    await ui.press({ key: 'pause' })
    expect(prefs(seen).paused).toBe(true)
    await ui.press({ key: 'pause' })
    expect(prefs(seen).paused).toBe(false)
    await ui.press({ key: 'interaction' })
    expect((await hubState($)).mode.interaction).toBe('on')
    await hubSet($, { mode: { interaction: 'auto' } })
    await ui.press({ key: 'test' })
    await ui.unmount()
  }
  expect(sends(seen).filter(send => send.text.includes('Test from Claude Code'))).toHaveLength(2)
})

test('the same body is drawn inside the hub’s shared panel when Telegram is its tab, and left alone otherwise', { plugins, options: OPTIONS }, async ($, on) => {
  const seen = world(on, { files: configured() })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  await lead($, seen)
  const other = await $.ui.mount(hubPane('terminal'))
  expect(await other.find({ key: 'telegram-tab' })).toBeUndefined()
  await other.unmount()
  await hubSet($, { tab: 'telegram' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(hubPane(surface))
    expect(await ui.find({ key: 'telegram-tab' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Telegram · Connected/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the tab says what is missing and offers setup; vscode and mobile draw it too', { plugins, options: { botToken: '' } }, async ($, on) => {
  const seen = world(on)
  await lead($, seen)
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(ownPane(surface))
    expect(await ui.find({ type: 'Text', text: /Not set up/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /@BotFather/ })).toBeDefined()
    expect(await ui.find({ key: 'setup' })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.tg.calls).toEqual([])
})

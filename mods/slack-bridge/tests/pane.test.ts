import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, OPTIONS, OWNER, WEBHOOK, configured, lead, pass, posts, say, world } from './fake'
import { hub, hubSet, hubState } from './mods-hub'

const plugins = [hub]
const PANE: RenderPropsOf['Pane'] = { title: 'Slack', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const ownPane = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>(surface: S) => ({ plugin: 'slack-bridge', surface, component: 'Pane' as const, requestId: 'slack-bridge', props: PANE })
const hubPane = <S extends 'terminal' | 'desktop'>(surface: S) => ({ plugin: 'slack-bridge', surface, component: 'Pane' as const, requestId: 'claude-mods', props: { ...PANE, title: 'Claude Mods', bodyColumns: 96 } })

const prefs = (seen: ReturnType<typeof world>) => JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}') as { paused?: boolean }

test('the status tab shows the connection, mode, sessions and recent messages, and its buttons act, on terminal and desktop', { plugins, options: OPTIONS }, async ($, on) => {
  const seen = world(on, { files: configured() })
  await lead($, seen)
  say(seen, { user: OWNER, text: 'coda: una nota' })
  await pass(seen, 8_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(ownPane(surface))
    expect(await ui.find({ type: 'Text', text: /Connected/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /@claude/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Interaction auto \(Claude may ask\)/ })).toBeDefined()
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
  expect(posts(seen).filter(post => post.text.includes('Test from Claude Code'))).toHaveLength(2)
})

test('the same body is drawn inside the hub’s shared panel when Slack is its tab, and left alone otherwise', { plugins, options: OPTIONS }, async ($, on) => {
  const seen = world(on, { files: configured() })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  await lead($, seen)
  const other = await $.ui.mount(hubPane('terminal'))
  expect(await other.find({ key: 'slack-tab' })).toBeUndefined()
  await other.unmount()
  await hubSet($, { tab: 'slack' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(hubPane(surface))
    expect(await ui.find({ key: 'slack-tab' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Slack · Connected/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the tab says what is missing, shows push-only for a webhook, and vscode and mobile draw it too', { plugins, options: { pollSeconds: 3 } }, async ($, on) => {
  const seen = world(on)
  await lead($, seen)
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(ownPane(surface))
    expect(await ui.find({ type: 'Text', text: /Not set up/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No Slack credentials/ })).toBeDefined()
    expect(await ui.find({ key: 'setup' })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.slack.calls).toEqual([])
})

test('a webhook alone is shown as post-only', { plugins, options: { webhookUrl: WEBHOOK } }, async ($, on) => {
  const seen = world(on)
  await lead($, seen)
  const ui = await $.ui.mount(ownPane('desktop'))
  expect(await ui.find({ type: 'Text', text: /Post only/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cannot read the channel/ })).toBeDefined()
  await ui.unmount()
})

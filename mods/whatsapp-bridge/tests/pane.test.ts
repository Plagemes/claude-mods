import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, configured, pass, sends, start, startDesktop, world } from './fake'
import { fakeHub } from './hub'

const PANE: RenderPropsOf['Pane'] = {
  title: 'WhatsApp',
  isFocused: true,
  bodyColumns: 52,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const mountOn = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>(surface: S) => ({ plugin: 'whatsapp-bridge', surface, component: 'Pane' as const, requestId: 'whatsapp-bridge', props: PANE })

test('the pane shows the connection, the QR as an image on the terminal and a dashboard link elsewhere', async ($, on) => {
  const seen = world(on, { status: 'qr_ready', files: configured() })
  await start($)
  await pass(seen, 2_000, 1_000)
  const terminal = await $.ui.mount(mountOn('terminal'))
  expect(await terminal.find({ type: 'Image' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /Waiting for QR scan/ })).toBeDefined()
  await terminal.unmount()
  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount(mountOn(surface))
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ key: 'qr-fallback' })).toBeDefined()
    await ui.unmount()
  }
})

test('quick actions, interaction switch and update toggles write the shared prefs, on terminal and desktop', async ($, on) => {
  const seen = world(on, { files: configured() })
  await start($)
  await pass(seen, 2_000, 1_000)
  const prefs = () => JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}') as { interaction?: string; events?: Record<string, boolean>; paused?: boolean }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(mountOn(surface))
    await ui.press({ key: 'tab:status' })
    expect(await ui.find({ key: 'sessions' })).toBeDefined()
    await ui.press({ key: 'tab:settings' })
    await ui.press({ key: 'interact:on' })
    await ui.press({ key: 'tab:status' })
    expect(prefs().interaction).toBe('on')
    await ui.press({ key: 'interaction' })
    expect(prefs().interaction).toBe('off')
    await ui.press({ key: 'interaction' })
    expect(prefs().interaction).toBe('on')
    await ui.press({ key: 'tab:settings' })
    const before = prefs().events?.tests ?? true
    await ui.press({ key: 'event:tests' })
    expect(prefs().events?.tests).toBe(!before)
    await ui.press({ key: 'interact:off' })
    expect(prefs().interaction).toBe('off')
    await ui.press({ key: 'tab:status' })
    await ui.press({ key: 'test' })
    await ui.unmount()
  }
  expect(sends(seen).filter(send => send.text.includes('Test from Claude Code'))).toHaveLength(2)
})

test('privacy shows the allowlist and a redaction preview; chat sends a reply; mobile draws without fields', async ($, on) => {
  const seen = world(on, { files: configured() })
  await start($)
  await pass(seen, 2_000, 1_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  await ui.press({ key: 'tab:privacy' })
  expect(await ui.find({ type: 'Text', text: /Claude · shop/ })).toBeDefined()
  await ui.input({ key: 'sample', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB costs $3' })
  expect(await ui.find({ type: 'Text', text: /\[REDACTED:github-token\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /To members: .*\[figure omitted\]/ })).toBeDefined()
  await ui.press({ key: 'tab:chat' })
  await ui.input({ key: 'reply', text: 'back in 10 minutes' })
  expect(sends(seen).at(-1)?.text).toBe('back in 10 minutes')
  await ui.unmount()

  const mobile = await $.ui.mount(mountOn('mobile'))
  expect(await mobile.find({ key: 'tab:settings' })).toBeDefined()
  await mobile.press({ key: 'tab:settings' })
  expect(await mobile.find({ type: 'Text', text: /Quiet hours 23-8/ })).toBeDefined()
  await mobile.unmount()
})

const label = async (ui: { find: (query: { key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string): Promise<string> => String((await ui.find({ key }))?.props.label ?? '')

test('every quick action flips when pressed after a timer tick, and a quiet tick redraws nothing (no state write)', async ($, on) => {
  const seen = world(on, { files: configured({ [`${DIR}/groups.json`]: '{}' }) })
  await start($)
  await pass(seen, 30_000)
  const prefs = () => JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}') as { interaction?: string; presence?: string; paused?: boolean }
  const config = () => JSON.parse(seen.files.get(`${DIR}/config.json`) ?? '{}') as { autoStart?: boolean }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(mountOn(surface))
    // A press lands on the drawing the click was made on: ticks in between must not have redrawn it.
    seen.stateWrites.length = 0
    await pass(seen, 30_000)
    expect(seen.stateWrites.filter(write => write.startsWith('whatsapp-bridge.'))).toEqual([])

    const presence = await label(ui, 'presence')
    await seen.clock.advance(10_000)
    await ui.press({ key: 'presence' })
    expect(await label(ui, 'presence')).not.toBe(presence)
    expect(prefs().presence).toBe(presence === 'I am here' ? 'here' : 'away')

    const paused = prefs().paused === true
    await seen.clock.advance(10_000)
    await ui.press({ key: 'pause' })
    expect(prefs().paused).toBe(!paused)
    expect(await label(ui, 'pause')).toBe(paused ? 'Pause all' : 'Resume all')

    const interaction = await label(ui, 'interaction')
    await seen.clock.advance(10_000)
    await ui.press({ key: 'interaction' })
    expect(await label(ui, 'interaction')).not.toBe(interaction)
    await seen.clock.advance(10_000)
    await ui.press({ key: 'interaction' })
    expect(await label(ui, 'interaction')).toBe(interaction)

    await seen.clock.advance(10_000)
    await ui.press({ key: 'night' })
    expect(await label(ui, 'night')).toBe('Night mode: ON')
    expect(prefs().interaction).toBe('night')
    await seen.clock.advance(10_000)
    await ui.press({ key: 'night' })
    expect(await label(ui, 'night')).toBe('Night mode')

    const autoStart = config().autoStart === true
    await seen.clock.advance(10_000)
    await ui.press({ key: 'autostart' })
    expect(config().autoStart).toBe(!autoStart)
    await ui.unmount()
  }
  const ui = await $.ui.mount(mountOn('desktop'))
  await seen.clock.advance(10_000)
  await ui.press({ key: 'grp-create-btn' })
  expect(await ui.find({ key: 'grp-create-btn' })).toBeUndefined()
  expect(seen.files.get(`${DIR}/groups.json`)).toContain('Claude · shop')
  await ui.unmount()
})

test('with mods-hub on the desktop app: Interaction, I am away and Night change the hub’s mode, and the buttons show it', async ($, on) => {
  const seen = world(on, { files: configured() })
  const hub = fakeHub(on, {}, seen.clock)
  await startDesktop($, seen)
  await pass(seen, 12_000)
  const ui = await $.ui.mount(mountOn('desktop'))
  expect(await label(ui, 'interaction')).toBe('Interaction: OFF')
  await seen.clock.advance(10_000)
  await ui.press({ key: 'interaction' })
  expect(hub.modes.at(-1)).toEqual({ interaction: 'on' })
  expect(await label(ui, 'interaction')).toBe('Interaction: ON')

  await seen.clock.advance(10_000)
  await ui.press({ key: 'presence' })
  expect(hub.presences.at(-1)?.presence).toBe('away')
  expect(await label(ui, 'presence')).toBe('I am here')

  await seen.clock.advance(10_000)
  await ui.press({ key: 'night' })
  expect(hub.modes.at(-1)).toEqual({ isNightOn: true })
  expect(await label(ui, 'night')).toBe('Night mode: ON')
  // The real hub's night holds questions (canAsk false while interaction is on): the switch still reads ON, and why.
  hub.mode = { ...hub.mode, canAsk: false }
  await pass(seen, 12_000)
  expect(await label(ui, 'interaction')).toBe('Interaction: ON (night)')
  await seen.clock.advance(10_000)
  await ui.press({ key: 'night' })
  expect(hub.modes.at(-1)).toEqual({ isNightOn: false })
  // The bridge's own prefs were never the ones changed.
  expect(seen.files.get(`${DIR}/prefs.json`)).not.toContain('"interaction": "on"')
  await ui.unmount()
})

import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, configured, pass, sends, start, world } from './fake'

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

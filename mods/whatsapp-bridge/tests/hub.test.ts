import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

import { DIR, GROUP, OWNER_CHAT, arrive, configured, lead, pass, sends, wa, world } from './fake'
import { fakeHub } from './hub'

/** The bridge's own prefs say "away"; with mods-hub installed, the hub's mode decides instead. */
const noConfirm = () => configured({ [`${DIR}/prefs.json`]: JSON.stringify({ presence: 'away', events: { confirmPrompts: false } }) })

const NOTIFY = 'mcp__whatsapp-bridge__notify' as const

const HUB_PANE: RenderPropsOf['Pane'] = { title: 'Claude Mods', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('with mods-hub: says hello with the Channels tab and registers the whatsapp channel, then reports it connected', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, {}, seen.clock)
  await lead($, seen)
  expect(hub.hellos).toEqual([
    {
      version: 'unknown',
      publishes: ['channel.inbound', 'approval.answered'],
      consumes: ['session.idle', 'session.away', 'session.back', 'test.result', 'ci.result', 'budget.threshold'],
    },
  ])
  expect(hub.tabs).toEqual([{ id: 'channels', title: 'Channels', order: 80, command: 'wa' }])
  expect(hub.channels).toMatchObject([{ id: 'whatsapp', title: 'WhatsApp', audience: 'me', delivery: 'pull' }])
  expect([hub.channels[0]?.status, ...hub.statuses.map(one => one.status)].at(-1)).toBe('connected')
})

test('with mods-hub: another mod\'s notification routed to WhatsApp is drained and sent, even while the hub says here', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, {}, seen.clock)
  await lead($, seen)
  hub.outbox.push({
    id: 'n1',
    level: 'error',
    title: '❌ CI failed on main: test (failure)',
    url: 'https://github.com/acme/shop/actions/runs/8',
    source: 'ci-watch',
    at: seen.clock.now(),
    targets: ['whatsapp'],
    held: false,
  })
  await pass(seen, 4_000)
  const sent = sends(seen).at(-1)
  expect(sent?.chatId).toBe(GROUP)
  expect(sent?.text).toContain('❌ *ci-watch*: ❌ CI failed on main: test (failure)')
  expect(sent?.text).toContain('https://github.com/acme/shop/actions/runs/8')
  // The next drain acknowledges it (a cursor: at least once), and it is not sent again.
  await pass(seen, 4_000)
  expect(hub.outbox).toEqual([])
  expect(sends(seen).filter(one => one.text.includes('CI failed on main'))).toHaveLength(1)
})

test('with mods-hub: a hub notice whose WhatsApp send failed stays queued and goes out on a later drain, once', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, {}, seen.clock)
  await lead($, seen)
  seen.wa.failSends = 2
  hub.outbox.push(
    { id: 'n1', level: 'error', title: 'Deploy failed', source: 'deploy-checklist', at: seen.clock.now(), targets: ['whatsapp'], held: false },
    { id: 'n2', level: 'warning', title: 'Budget at 80%', source: 'token-budget', at: seen.clock.now(), targets: ['whatsapp'], held: false },
  )
  /** What reached WhatsApp: the rows OpenWA stored for the bot's sends that it took. */
  const delivered = () => seen.wa.rows.filter(row => row.direction === 'outgoing').map(row => row.body)
  await pass(seen, 3_000, 1_000)
  expect(seen.wa.failSends).toBe(1)
  expect(delivered().filter(text => text.includes('Deploy failed'))).toHaveLength(0)
  expect(hub.outbox.map(one => one.id)).toEqual(['n1', 'n2'])
  await pass(seen, 12_000, 1_000)
  const texts = delivered()
  expect(texts.filter(text => text.includes('Deploy failed'))).toHaveLength(1)
  expect(texts.filter(text => text.includes('Budget at 80%'))).toHaveLength(1)
  expect(texts.findIndex(text => text.includes('Deploy failed'))).toBeLessThan(texts.findIndex(text => text.includes('Budget at 80%')))
  expect(hub.outbox).toEqual([])
})

test('with mods-hub: its presence replaces the bridge\'s own: here holds updates, away lets them out', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'here' }, seen.clock)
  await lead($, seen)
  expect(String((await $.tool.call({ tool: NOTIFY, text: 'Migration finished', priority: 'normal' })).result)).toContain('keyboard')
  expect(sends(seen)).toEqual([])

  expect(await wa($, 'away')).toBe('Marked away in every session (mods-hub): updates go to WhatsApp.')
  expect(hub.presences).toEqual([{ presence: 'away', reason: 'manual' }])
  expect(String((await $.tool.call({ tool: NOTIFY, text: 'Migration finished', priority: 'normal' })).result)).toContain('Sent')
  expect(sends(seen).at(-1)?.text).toContain('Migration finished')
  // The bridge's own prefs are left alone: they are the fallback for a session without the hub.
  expect(JSON.parse(seen.files.get(`${DIR}/prefs.json`) ?? '{}').presence).toBe('away')
})

test('with mods-hub: interaction and night from /wa and the phone change the hub\'s mode; the hub\'s canAsk gates questions', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'away', canAsk: false, interaction: 'off' }, seen.clock)
  await lead($, seen)
  expect(String((await $.tool.call({ tool: 'mcp__whatsapp-bridge__ask', question: 'Keep the old API?' })).result)).toMatch(/^unavailable/)

  expect(await wa($, 'interact on')).toContain('Interaction: on (mods-hub: away · interaction on)')
  expect(hub.modes).toEqual([{ interaction: 'on' }])
  expect(await wa($, 'night')).toContain('Night mode on in mods-hub')
  expect(hub.modes.at(-1)).toEqual({ isNightOn: true })

  arrive(seen, { chatId: OWNER_CHAT, body: 'interact off' })
  await pass(seen, 12_000)
  expect(hub.modes.at(-1)).toEqual({ interaction: 'off' })
  expect(seen.files.get(`${DIR}/prefs.json`) ?? '').not.toContain('"interaction"')
})

test('with mods-hub: what the owner writes is published as channel.inbound; a test-watch run that turns red is reported', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'away' }, seen.clock)
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'run the linter' })
  await pass(seen, 12_000)
  expect(hub.published).toContainEqual({ topic: 'channel.inbound', data: { channel: 'whatsapp', from: 'owner', text: 'run the linter', isOwner: true } })

  const at = seen.clock.now()
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 3, failed: 0 }, at: at + 1, source: 'test-watch' })
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 2, failed: 1 }, at: at + 2, source: 'test-watch' })
  await pass(seen, 12_000)
  expect(sends(seen).some(send => send.text.includes('tests went red (vitest, test-watch)'))).toBe(true)
})

test('with mods-hub: /wa opens the Channels tab, drawn under the hub strip with the hub\'s mode and no Close', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'away', canAsk: true, interaction: 'auto' }, seen.clock)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  await lead($, seen)
  await wa($, '')
  expect(hub.shown).toEqual(['channels'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'whatsapp-bridge', surface, component: 'Pane', requestId: 'claude-mods', props: HUB_PANE })
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.press({ key: 'tab:settings' })
    expect(await ui.find({ type: 'Text', text: /mods-hub: away · interaction auto/ })).toBeDefined()
    expect(await ui.find({ key: 'quiet' })).toBeUndefined()
    await ui.unmount()
  }
})

test('with mods-hub: STOP from the phone raises control.stop for this session, STOP ALL for every session', async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'away' }, seen.clock)
  await lead($, seen)
  await $.turn.start({ text: 'refactor the cart', turnId: 'turn-1' })
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: 'stop' })
  await pass(seen, 12_000)
  expect(seen.aborted).toEqual(['turn-1'])
  expect(hub.controls).toMatchObject([{ action: 'stop', scope: 'session', by: 'owner via whatsapp', reason: 'STOP from WhatsApp' }])

  arrive(seen, { chatId: OWNER_CHAT, author: OWNER_CHAT, body: 'STOP ALL' })
  await pass(seen, 12_000)
  expect(hub.controls.find(control => control.scope === 'all')).toMatchObject({ action: 'stop', reason: 'STOP ALL from WhatsApp' })
})

test('with mods-hub: the PIN of a phone slash command never reaches the log or the bus', { options: { pin: '4321' } }, async ($, on) => {
  const seen = world(on, { files: noConfirm() })
  const hub = fakeHub(on, { presence: 'away' }, seen.clock)
  await lead($, seen)
  arrive(seen, { chatId: GROUP, author: OWNER_CHAT, body: '/compact 4321' })
  await pass(seen, 12_000)
  expect(hub.published).toContainEqual({ topic: 'channel.inbound', data: { channel: 'whatsapp', from: 'owner', text: '/compact', isOwner: true } })
  expect(JSON.stringify(hub.published)).not.toContain('4321')
  const logs = [...seen.files.entries()].filter(([path]) => path.startsWith(`${DIR}/log/`)).map(([, text]) => text)
  expect(logs.join('\n')).toContain('/compact')
  expect(logs.join('\n')).not.toContain('4321')
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

/** Wednesday 7 October 2026, noon local time: outside the default quiet hours. */
const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()
const MINUTE = 60_000
const PREFS_FILE = '/home/me/.claude/claude-mods/hub/prefs.json'
const PANE: RenderPropsOf['Pane'] = { title: 'Claude Mods', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

/**
 * Another mod, written inline, standing for any mod that uses the hub. A Bash command `probe <json>` makes it call
 * `$.mods.<method>(input)` and answer with what came back; it also subscribes to test.result, owns a push channel
 * `phone`, and draws a tab `router` in the shared panel the way MOD_CONTRACT.md says.
 */
const probe: Plugin = {
  name: 'probe',
  register(on) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !String(e.command).startsWith('probe ')) return next(e)
      const call = JSON.parse(String(e.command).slice(6)) as { method: string; input: never }
      try {
        let value: unknown
        switch (call.method) {
          case 'publish': value = await $.mods.publish(call.input); break
          case 'recent': value = await $.mods.recent(call.input); break
          case 'latest': value = await $.mods.latest(call.input); break
          case 'notify': value = await $.mods.notify(call.input); break
          case 'mode': value = await $.mods.mode(); break
          case 'setPresence': value = await $.mods.setPresence(call.input); break
          case 'setMode': value = await $.mods.setMode(call.input); break
          case 'drain': value = await $.mods.drain(call.input); break
          case 'stop': value = await $.mods.stop(call.input); break
          case 'registerTab': value = await $.mods.registerTab(call.input); break
          case 'registerChannel': value = await $.mods.registerChannel(call.input); break
          case 'hello': value = await $.mods.hello(call.input); break
          case 'share': value = await $.mods.share(call.input); break
          case 'read': value = await $.mods.read(call.input); break
          case 'toast': $.ui.toast('probe says hi'); value = 'ok'; break
        }
        return { result: JSON.stringify({ value }) }
      } catch (error) {
        return { result: JSON.stringify({ error: String(error) }) }
      }
    })
    on('mods.publish', { topic: 'test.result' }, ($, e, next) => {
      $.ui.toast(`probe saw ${e.topic}`)
      return next(e)
    })
    on('mods.deliver', { channel: 'phone' }, ($, e) => {
      $.ui.toast(`phone got: ${e.notice.title} | ${e.notice.body ?? ''}`)
      return { value: { isDelivered: true } }
    })
    on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
      const { value: tab } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
      if (tab !== 'router') return next(e)
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {await next(e)}
          <Text>ROUTER BODY</Text>
          <Button key="probe-btn" label="Route" onPress={() => $.ui.toast('router pressed')} />
        </Box>
      )
    })
  },
}

/** Stands for the engine beneath the plugins: files, the home folder, the session, the screen. */
function world(on: On) {
  const clock = mock.clock(on, { now: NOON })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, string>()
  const toasts: string[] = []
  const sounds: string[] = []
  const statuses: (string | undefined)[] = []
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = [...files.keys()].filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: names.map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify([{ id: 'mods-hub@claude-mods', version: '1.0.0', enabled: true }, { id: 'probe@claude-mods', version: '1.0.0', enabled: true }]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => {
    sounds.push('played')
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('tool.call', ($, e) => {
    const command = e.tool === 'Bash' ? String(e.command) : ''
    if (command.includes('vitest')) {
      return { isError: true as const, result: 'Exit code 1', text: ' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)\n' }
    }
    if (command.startsWith('false')) return { isError: true as const, result: 'Exit code 1', text: 'boom' }
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  return { clock, files, toasts, sounds, statuses }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })

/** Makes the probe call `$.mods.<method>(input)`; answers `{ value }` or `{ error }`. */
async function mods($: Engine, method: string, input: unknown = {}): Promise<{ value?: any; error?: string }> {
  const ran = await $.tool.call({ tool: 'Bash', command: `probe ${JSON.stringify({ method, input })}` })
  return JSON.parse(String((ran as { result?: unknown }).result)) as { value?: any; error?: string }
}

const hub = ($: Engine, args: string) =>
  $.command.run({ command: 'hub', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('a mod publishes on the bus: subscribers see it, the hub stamps and keeps it, bad payloads are refused', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()

  const ok = await mods($, 'publish', { topic: 'test.result', data: { runner: 'jest', outcome: 'passed', passed: 4, failed: 0 } })
  // session, load (a hot reload restarts the sequence, never the ids), sequence
  expect(ok.value.id).toMatch(/^sess-123-[a-z0-9]{1,4}-\d+$/)
  expect(w.toasts).toContain('probe saw test.result')

  const recent = await mods($, 'recent', { topic: 'test.result' })
  expect(recent.value.at(-1)).toMatchObject({ topic: 'test.result', source: 'probe', session: 'sess-1234abcd', data: { runner: 'jest', passed: 4 } })

  expect((await mods($, 'publish', { topic: 'test.result', data: { runner: 'jest', outcome: 'green' } })).error).toContain('test.result.outcome')
  expect((await mods($, 'publish', { topic: 'made.up', data: {} })).error).toContain('x.<mod>.<name>')
  expect((await mods($, 'publish', { topic: 'x.probe.ping', data: { n: 1 } })).value.id).toBeDefined()

  const fact = await mods($, 'share', { name: 'policy', value: { tier: 'deep' } })
  expect(fact.value).toMatchObject({ key: 'probe.policy', owner: 'probe' })
  expect((await mods($, 'read', { key: 'probe.policy' })).value.value).toEqual({ tier: 'deep' })
})

test('built-in sensors: a failing test run becomes test.result, a third identical failure error.repeated', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await w.clock.settle()
  const latest = await mods($, 'latest', { topic: 'test.result' })
  expect(latest.value).toMatchObject({ source: 'mods-hub', data: { runner: 'vitest', outcome: 'failed', passed: 10, failed: 2 } })
  expect(w.toasts).toContain('probe saw test.result')

  for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'false --flag 1' })
  await w.clock.settle()
  expect((await mods($, 'latest', { topic: 'error.repeated' })).value.data).toMatchObject({ count: 3, tool: 'Bash' })
})

test('notifications: terminal while here, your channel (secrets masked) while away, nothing on screen while silent', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await mods($, 'registerChannel', { id: 'phone', title: 'WhatsApp', audience: 'me', delivery: 'push', status: 'connected' })

  const here = await mods($, 'notify', { level: 'success', title: 'Deploy done', body: 'shop → production' })
  expect(here.value).toMatchObject({ targets: ['toast'], held: false })
  expect(w.toasts).toContain('✓ probe: Deploy done — shop → production')

  await mods($, 'setPresence', { presence: 'away', reason: 'channel' })
  const token = `ghp_${'a1'.repeat(18)}`
  const away = await mods($, 'notify', { level: 'error', title: 'CI failed', body: `token ${token} leaked in logs` })
  expect(away.value.targets).toEqual(['toast', 'phone'])
  await w.clock.settle()
  expect(w.toasts).toContain('phone got: CI failed | token [REDACTED:github-token] leaked in logs')

  const question = await mods($, 'notify', { level: 'warning', title: 'Deploy to prod?', kind: 'question' })
  expect(question.value.targets).toEqual(['toast', 'phone'])

  expect(String((await hub($, 'silent 15')).text)).toContain('Silent for 15 min')
  expect(JSON.parse(w.files.get(PREFS_FILE) ?? '{}')).toMatchObject({ isSilent: true, silentUntil: NOON + 15 * MINUTE })
  const before = w.toasts.length
  const quiet = await mods($, 'notify', { level: 'warning', title: 'Lint warnings' })
  expect(quiet.value.targets).toEqual([])
  await mods($, 'toast')
  expect(w.toasts.length).toBe(before)

  await w.clock.advance(16 * MINUTE)
  await mods($, 'toast')
  expect(w.toasts).toContain('probe says hi')
})

test('presence: quiet for 30 minutes is away, your next prompt is back', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(31 * MINUTE)
  expect((await mods($, 'mode')).value).toMatchObject({ presence: 'away', canAsk: true })
  expect((await mods($, 'latest', { topic: 'session.away' })).value).not.toBeNull()

  await $.prompt.submit({ text: 'hello again', wait: false, origin: { kind: 'composer' } })
  expect((await mods($, 'mode')).value.presence).toBe('here')
  expect((await mods($, 'latest', { topic: 'session.back' })).value.data.reason).toBe('activity')
})

test('the shared panel: Home on every surface, a mod draws its own tab and keeps its own buttons', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  await mods($, 'registerTab', { id: 'router', title: 'Router', command: 'router' })
  await mods($, 'registerChannel', { id: 'phone', title: 'WhatsApp', audience: 'me', delivery: 'push', status: 'connected' })
  expect((await mods($, 'registerTab', { id: 'home', title: 'Mine' })).error).toContain('not "home"')
  expect(String((await hub($, '')).text)).toBe('Claude Mods panel opened.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mods-hub', surface, component: 'Pane', requestId: 'claude-mods', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'CHANNELS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'WhatsApp' })).toBeDefined()
    expect(await ui.find({ key: 'tab-router' })).toBeDefined()
    // The tab buttons are plain with their digit, so the terminal draws `0: Home` and `1: Router`.
    // In the terminal each tab carries its owner's category glyph (`0: ▦ Home`); elsewhere the icon is drawn beside it.
    const glyph = surface === 'terminal' ? '▦ ' : ''
    expect((await ui.find({ key: 'tab-home' }))?.props).toMatchObject({ plain: true, hotkey: '0', label: `${glyph}Home`, variant: 'primary' })
    expect((await ui.find({ key: 'tab-router' }))?.props).toMatchObject({ plain: true, hotkey: '1', label: `${glyph}Router`, dimColor: true })

    await ui.press({ key: surface === 'terminal' ? 'interaction-on' : 'interaction-off' })
    expect(JSON.parse(w.files.get(PREFS_FILE) ?? '{}').interaction).toBe(surface === 'terminal' ? 'on' : 'off')

    await ui.press({ key: 'tab-router' })
    expect(await ui.find({ type: 'Text', text: 'ROUTER BODY' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CHANNELS' })).toBeUndefined()
    await ui.press({ plugin: 'probe', key: 'probe-btn' })
    expect(w.toasts).toContain('router pressed')

    await ui.press({ key: 'tab-home' })
    expect(await ui.find({ type: 'Text', text: 'ROUTER BODY' })).toBeUndefined()
    await ui.unmount()
  }
})

test('discovery and status: who said hello, what is installed, /hub status', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const hello = await mods($, 'hello', { version: '1.2.0', publishes: ['x.probe.ping'], consumes: ['test.result'] })
  expect(hello.value.installed.hello).toEqual([{ name: 'probe', version: '1.2.0', publishes: ['x.probe.ping'], consumes: ['test.result'] }])
  expect(hello.value.installed.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(['mods-hub', 'probe'])
  const status = String((await hub($, 'status')).text)
  expect(status).toContain('▪▪▪ Claude Mods · Hub')
  expect(status).toContain('Mode      here · interaction auto')
  expect(status).toContain('Channels  none registered')
  expect(status).toContain('Mods      2 mods (2 enabled) · 1 on the bus')
  expect(String((await hub($, 'route error loud')).text)).toContain('Usage: /hub')
})

test('mode: Silent with no end, the Night schedule and the presence minutes are in the mode', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  expect((await mods($, 'mode')).value).toMatchObject({ isNightOn: true, isNight: false, idleMinutes: 10, awayMinutes: 30 })

  expect((await mods($, 'setMode', { isSilent: true })).value).toMatchObject({ isSilent: true, silentUntil: null })
  await w.clock.advance(90 * MINUTE)
  expect((await mods($, 'mode')).value.isSilent).toBe(true)
  expect((await mods($, 'setMode', { isSilent: true, silentMinutes: 20 })).value.silentUntil).toBe(NOON + 90 * MINUTE + 20 * MINUTE)
  expect((await mods($, 'setMode', { isSilent: false })).value).toMatchObject({ isSilent: false, silentUntil: null })
  // The first contract still works: minutes on, null off.
  expect((await mods($, 'setMode', { silentMinutes: 5 })).value.isSilent).toBe(true)
  expect((await mods($, 'setMode', { silentMinutes: null })).value.isSilent).toBe(false)
  expect((await mods($, 'setMode', { isNightOn: false })).value).toMatchObject({ isNightOn: false })
})

test('pull channels: drain with a cursor is at-least-once; without one it hands over and forgets', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await mods($, 'registerChannel', { id: 'mail', title: 'Mail', audience: 'me', delivery: 'pull', status: 'connected' })
  await mods($, 'setPresence', { presence: 'away', reason: 'manual' })
  for (const title of ['one', 'two', 'three']) await mods($, 'notify', { level: 'error', title })
  await w.clock.settle()

  const first = (await mods($, 'drain', { channel: 'mail', after: null })).value as { id: string; title: string }[]
  expect(first.map(notice => notice.title)).toEqual(['one', 'two', 'three'])
  expect(new Set(first.map(notice => notice.id)).size).toBe(3)
  // Not acknowledged yet: a second drainer (or a retry after a crash) gets them again.
  expect((await mods($, 'drain', { channel: 'mail', after: null })).value).toHaveLength(3)
  const rest = (await mods($, 'drain', { channel: 'mail', after: first[1]?.id })).value as { title: string }[]
  expect(rest.map(notice => notice.title)).toEqual(['three'])
  // An id it no longer knows acknowledges nothing: everything still waiting comes back.
  expect((await mods($, 'drain', { channel: 'mail', after: 'n-gone-1' })).value).toHaveLength(1)

  expect((await mods($, 'drain', { channel: 'mail' })).value.map((notice: { title: string }) => notice.title)).toEqual(['three'])
  expect((await mods($, 'drain', { channel: 'mail', after: null })).value).toEqual([])
  expect((await mods($, 'drain', { channel: 'phone', after: null })).error).toContain('no channel "phone" of yours')
})

test('stop, pause, resume: control.* on the bus and in state, all sessions through control.json, never published directly', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const CONTROL_FILE = '/home/me/.claude/claude-mods/hub/control.json'
  const OWN_CONTROL_FILE = '/home/me/.claude/claude-mods/hub/control/sess-1234abcd.json'

  const stopped = await mods($, 'stop', { scope: 'all', reason: 'STOP ALL from the phone', by: 'owner via whatsapp' })
  expect(stopped.value).toMatchObject({ action: 'stop', scope: 'all', by: 'owner via whatsapp', source: 'probe', session: 'sess-1234abcd' })
  expect((await mods($, 'latest', { topic: 'control.stop' })).value).toMatchObject({ source: 'probe', data: { scope: 'all', reason: 'STOP ALL from the phone' } })
  // One writer per file: this session's controls go to its own file, never the shared one.
  expect(JSON.parse(w.files.get(OWN_CONTROL_FILE) ?? '{}').controls).toHaveLength(1)
  expect(w.files.has(CONTROL_FILE)).toBe(false)
  expect(String((await hub($, 'status')).text)).toContain('Work      ⏹ Stopped by owner via whatsapp: STOP ALL from the phone · every session')

  expect((await mods($, 'publish', { topic: 'control.stop', data: { id: 'x', scope: 'all', reason: 'r', by: 'b', session: 's' } })).error).toContain('$.mods.stop')
  expect((await mods($, 'stop', { reason: '' })).error).toContain('needs a reason')

  // Another session resumes everything (from its own file): this one picks it up within 5 seconds.
  const other = { id: 'c-other-1', action: 'resume', scope: 'all', reason: 'back at it', by: 'you', session: 'sess-other', source: 'mods-hub', at: NOON + 1_000 }
  w.files.set('/home/me/.claude/claude-mods/hub/control/sess-other.json', JSON.stringify({ controls: [other] }))
  await w.clock.advance(6_000)
  expect((await mods($, 'latest', { topic: 'control.resume' })).value).toMatchObject({ data: { id: 'c-other-1', session: 'sess-other' } })
  await w.clock.advance(6_000)
  expect((await mods($, 'recent', { topic: 'control.resume' })).value).toHaveLength(1)

  expect(String((await hub($, 'pause')).text)).toContain('Pause sent to this session')
  expect((await mods($, 'latest', { topic: 'control.pause' })).value.data.scope).toBe('session')
  const ui = await $.ui.mount({ plugin: 'mods-hub', surface: 'terminal', component: 'Pane', requestId: 'claude-mods', props: PANE })
  await ui.press({ key: 'resume' })
  expect((await mods($, 'latest', { topic: 'control.resume' })).value.data.session).toBe('sess-1234abcd')
  await ui.unmount()
})

test('/hub away, then /hub status and /hub test: looking does not end the away you just set to try the routing', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  await mods($, 'registerChannel', { id: 'phone', title: 'WhatsApp', audience: 'me', delivery: 'push', status: 'connected' })
  await hub($, 'away')
  expect(String((await hub($, 'status')).text)).toContain('Mode      away')
  expect(String((await hub($, 'test error')).text)).toContain('Routed to toast, phone')
  await w.clock.settle()
  expect(w.toasts).toContain('phone got: Test notification | Sent with /hub test')
  // A change made from the terminal is the person at the keyboard: away ends.
  await hub($, 'interaction on')
  expect((await mods($, 'mode')).value.presence).toBe('here')
})

test('notifications: an identical one within 30 s is dropped, one with a different body is not; a body must be text', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  await start($)
  const first = await mods($, 'notify', { level: 'error', title: 'CI failed', body: 'acme/shop' })
  const again = await mods($, 'notify', { level: 'error', title: 'CI failed', body: 'acme/shop' })
  const other = await mods($, 'notify', { level: 'error', title: 'CI failed', body: 'acme/api' })
  expect(first.value.targets).toEqual(['toast'])
  expect(again.value).toMatchObject({ targets: [], reason: 'a repeat of the last 30 seconds' })
  expect(other.value.targets).toEqual(['toast'])
  expect(w.toasts.filter(text => text.startsWith('✗ probe: CI failed'))).toHaveLength(2)
  expect((await mods($, 'notify', { level: 'info', title: 'x', body: 42 })).error).toContain('body is text')
})

test('shared files, one writer each: two sessions beating at once both stay in sessions.json, an ended one is not written back, and a prefs change made elsewhere survives', { plugins: [probe] }, async ($, on) => {
  const w = world(on)
  const HUB = '/home/me/.claude/claude-mods/hub'
  await start($)
  await w.clock.settle()
  // Another session beats from its own file; the shared view this session last read did not have it yet.
  w.files.set(`${HUB}/sessions/sess-other.json`, JSON.stringify({ id: 'sess-other', project: 'api', cwd: '/work/api', startedAt: NOON, lastSeen: NOON, presence: 'here', turns: 2, usd: 0.1, events: [] }))
  w.files.set(`${HUB}/sessions.json`, JSON.stringify({}))
  await w.clock.advance(61_000)
  const merged = JSON.parse(w.files.get(`${HUB}/sessions.json`) ?? '{}') as Record<string, unknown>
  expect(Object.keys(merged).sort()).toEqual(['sess-1234abcd', 'sess-other'])
  expect(JSON.parse(w.files.get(`${HUB}/sessions/sess-1234abcd.json`) ?? '{}')).toMatchObject({ id: 'sess-1234abcd', project: 'shop' })

  // The other session ends: its own file says so, and this session's next beat does not bring it back.
  w.files.set(`${HUB}/sessions/sess-other.json`, JSON.stringify({ id: 'sess-other', lastSeen: NOON + 60_000, ended: true }))
  w.files.set(`${HUB}/sessions.json`, JSON.stringify({ 'sess-other': { id: 'sess-other', lastSeen: NOON + 60_000 }, 'sess-1234abcd': {} }))
  await w.clock.advance(61_000)
  expect(Object.keys(JSON.parse(w.files.get(`${HUB}/sessions.json`) ?? '{}'))).toEqual(['sess-1234abcd'])

  // Another session turned Night off a moment ago (this one has not re-read the file yet); a route changed here keeps it.
  w.files.set(PREFS_FILE, JSON.stringify({ ...JSON.parse(w.files.get(PREFS_FILE) ?? '{}'), isNightOn: false }))
  await hub($, 'route warning always')
  expect(JSON.parse(w.files.get(PREFS_FILE) ?? '{}')).toMatchObject({ isNightOn: false, routes: { warning: 'always' } })
})

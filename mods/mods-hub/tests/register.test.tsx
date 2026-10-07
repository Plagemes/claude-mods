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
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
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
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('tool.call', ($, e) => {
    const command = e.tool === 'Bash' ? String(e.command) : ''
    if (command.includes('vitest')) {
      return { isError: true as const, result: 'Exit code 1', text: ' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)\n' }
    }
    if (command.startsWith('false')) return { isError: true as const, result: 'Exit code 1', text: 'boom' }
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  return { clock, files, toasts, sounds }
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
  expect(ok.value.id).toMatch(/^sess-123-\d+$/)
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
    expect(await ui.find({ type: 'Text', text: 'Channels' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'WhatsApp' })).toBeDefined()
    expect(await ui.find({ key: 'tab-router' })).toBeDefined()

    await ui.press({ key: 'interaction' })
    expect(JSON.parse(w.files.get(PREFS_FILE) ?? '{}').interaction).toBe(surface === 'terminal' ? 'on' : 'off')

    await ui.press({ key: 'tab-router' })
    expect(await ui.find({ type: 'Text', text: 'ROUTER BODY' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Channels' })).toBeUndefined()
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
  expect(status).toContain('Mode: here · interaction auto')
  expect(status).toContain('Channels: none registered')
  expect(String((await hub($, 'route error loud')).text)).toContain('Usage: /hub')
})

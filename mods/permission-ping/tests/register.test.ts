import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const PING_ASSET = 'assets/ping.wav'

const listen = (on: On, isAnswered = false) => {
  const toasts: string[] = []
  const clips: unknown[] = []
  // The engine's side of the two classic events: no settings hook answers, unless the test says one does.
  on('classic.PermissionRequest', () => (isAnswered ? { decision: { behavior: 'allow' } } : {}))
  on('classic.Notification', () => ({}))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })
  return { toasts, clips }
}

test('toasts and plays the chime when a permission dialog opens', async ($, on) => {
  startClock = mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Bash')
  expect(toasts[0]).toContain('rm -rf build')
  expect(clips).toEqual([{ asset: PING_ASSET }])
})

test('pings once per request even when the notification follows the request', async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(toasts).toHaveLength(1)
  expect(clips).toHaveLength(1)

  await clock.advance(10_000)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(toasts).toHaveLength(2)
})

test('pings from a permission notification alone and ignores other notifications', async ($, on) => {
  startClock = mock.clock(on)
  const { toasts } = listen(on)

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(toasts).toHaveLength(0)

  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('approval')
})

test('stays quiet when another hook already answered the request', async ($, on) => {
  startClock = mock.clock(on)
  const { toasts, clips } = listen(on, true)

  await $.classic.PermissionRequest({ tool_name: 'Read', tool_input: { file_path: 'README.md' } })

  expect(toasts).toHaveLength(0)
  expect(clips).toHaveLength(0)
})

test('options can silence the sound', { options: { sound: false, toast: true } }, async ($, on) => {
  startClock = mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

  expect(toasts).toHaveLength(1)
  expect(clips).toHaveLength(0)
})

test('options can silence the toast', { options: { toast: false, sound: true } }, async ($, on) => {
  startClock = mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

  expect(toasts).toHaveLength(0)
  expect(clips).toHaveLength(1)
})

test('with mods-hub: publishes approval.requested and notifies a question instead of toasting', async ($, on) => {
  startClock = mock.clock(on, { now: 5_000 })
  const { toasts, clips } = listen(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['approval.requested'], consumes: [] }])

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })

  expect(hub.published).toEqual([
    { topic: 'approval.requested', data: { id: 'permission-6500', question: '🔔 Approval needed: Bash — rm -rf build', tool: 'Bash' } },
  ])
  expect(hub.notified).toEqual([
    { level: 'warning', kind: 'question', title: '🔔 Approval needed: Bash — rm -rf build', topic: 'approval.requested' },
  ])
  expect(toasts).toEqual([])
  expect(clips).toEqual([{ asset: PING_ASSET }])
})

test('with mods-hub: the request and its notification pair make one event, and the toast option still rules', { options: { toast: false } }, async ($, on) => {
  const clock = (startClock = mock.clock(on))
  const { clips } = listen(on)
  const hub = fakeHub(on)

  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(hub.published).toHaveLength(1)

  await clock.advance(10_000)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(hub.published).toHaveLength(2)
  expect(hub.published[1]?.data).toMatchObject({ question: '🔔 Claude is waiting for your approval' })
  expect(hub.published[1]?.data).not.toHaveProperty('tool')
  expect(hub.notified).toEqual([])
  expect(clips).toHaveLength(2)
})

import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Bash')
  expect(toasts[0]).toContain('rm -rf build')
  expect(clips).toEqual([{ asset: PING_ASSET }])
})

test('pings once per request even when the notification follows the request', async ($, on) => {
  const clock = mock.clock(on)
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
  mock.clock(on)
  const { toasts } = listen(on)

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(toasts).toHaveLength(0)

  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('approval')
})

test('stays quiet when another hook already answered the request', async ($, on) => {
  mock.clock(on)
  const { toasts, clips } = listen(on, true)

  await $.classic.PermissionRequest({ tool_name: 'Read', tool_input: { file_path: 'README.md' } })

  expect(toasts).toHaveLength(0)
  expect(clips).toHaveLength(0)
})

test('options can silence the sound', { options: { sound: false, toast: true } }, async ($, on) => {
  mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

  expect(toasts).toHaveLength(1)
  expect(clips).toHaveLength(0)
})

test('options can silence the toast', { options: { toast: false, sound: true } }, async ($, on) => {
  mock.clock(on)
  const { toasts, clips } = listen(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

  expect(toasts).toHaveLength(0)
  expect(clips).toHaveLength(1)
})

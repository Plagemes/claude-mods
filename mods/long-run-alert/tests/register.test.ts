import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands for the engine: a Bash call that takes `ms` of mocked time, and a toast recorder.
const engine = (on: On, runMs: number) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('tool.call', async () => {
    await clock.sleep(runMs)
    return { result: { stdout: 'done', stderr: '', interrupted: false }, text: 'done' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts }
}

test('toasts the command once it runs past the threshold', async ($, on) => {
  const { clock, toasts } = engine(on, 90_000)

  const call = $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await clock.advance(59_000)
  expect(toasts).toHaveLength(0)

  await clock.advance(2_000)
  expect(toasts).toEqual(['⏱ still running (1m): npm run build'])

  await clock.advance(60_000)
  await call
  expect(toasts).toHaveLength(1)
})

test('a command that finishes in time raises no alert, and its timer is cancelled', async ($, on) => {
  const { clock, toasts } = engine(on, 5_000)

  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(5_000)
  await call
  await clock.advance(300_000)

  expect(toasts).toHaveLength(0)
})

test('seconds sets the threshold and long commands are shortened', { options: { seconds: 10, repeat: false } }, async ($, on) => {
  const { clock, toasts } = engine(on, 30_000)
  const command = `echo ${'x'.repeat(200)}`

  const call = $.tool.call({ tool: 'Bash', command })
  await clock.advance(11_000)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('still running (10s): echo xxx')
  expect(toasts[0]?.endsWith('…')).toBe(true)
  await clock.advance(30_000)
  await call
})

test('repeat alerts again each interval until the command ends', { options: { seconds: 30, repeat: true } }, async ($, on) => {
  const { clock, toasts } = engine(on, 100_000)

  const call = $.tool.call({ tool: 'Bash', command: 'make all' })
  await clock.advance(95_000)
  expect(toasts).toEqual([
    '⏱ still running (30s): make all',
    '⏱ still running (1m): make all',
    '⏱ still running (1m 30s): make all',
  ])

  await clock.advance(10_000)
  await call
  await clock.advance(120_000)
  expect(toasts).toHaveLength(3)
})

test('ignores commands started in the background', async ($, on) => {
  const { clock, toasts } = engine(on, 1_000)

  const call = $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await clock.advance(1_000)
  await call
  await clock.advance(300_000)

  expect(toasts).toHaveLength(0)
})

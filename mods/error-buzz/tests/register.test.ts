import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const BUZZ_ASSET = 'assets/buzz.wav'

type Outcome = { isError?: true; text?: string }

// Stands for the engine: answers Bash with the outcome the test sets, and records every clip played.
const engine = (on: On, outcome: Outcome) => {
  const clips: unknown[] = []
  on('tool.call', () =>
    outcome.isError === true
      ? { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true as const, text: outcome.text ?? 'Exit code 1' }
      : { result: { stdout: outcome.text ?? 'ok', stderr: '', interrupted: false }, text: outcome.text ?? 'ok' },
  )
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })
  return clips
}

test('buzzes when a Bash command fails', async ($, on) => {
  mock.clock(on)
  const clips = engine(on, { isError: true })

  await $.tool.call({ tool: 'Bash', command: 'ls /nope' })

  expect(clips).toEqual([{ asset: BUZZ_ASSET }])
})

test('stays quiet when the command succeeds', async ($, on) => {
  mock.clock(on)
  const clips = engine(on, {})

  await $.tool.call({ tool: 'Bash', command: 'echo hi' })

  expect(clips).toHaveLength(0)
})

test('buzzes at most once per cooldown', async ($, on) => {
  const clock = mock.clock(on)
  const clips = engine(on, { isError: true })

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(9_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(clips).toHaveLength(1)

  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(clips).toHaveLength(2)
})

test('buzzes for a test runner that reports failures but exits 0', async ($, on) => {
  const clock = mock.clock(on)
  const clips = engine(on, { text: 'Tests: 2 failed, 8 passed, 10 total' })

  await $.tool.call({ tool: 'Bash', command: 'npx jest || true' })
  expect(clips).toHaveLength(1)

  await clock.advance(11_000)
  await $.tool.call({ tool: 'Bash', command: 'echo "2 failed"' })
  expect(clips).toHaveLength(1)
})

test('does not read a clean run as a failure', async ($, on) => {
  mock.clock(on)
  const clips = engine(on, { text: 'Tests: 0 failed, 10 passed, 10 total' })

  await $.tool.call({ tool: 'Bash', command: 'npx jest' })

  expect(clips).toHaveLength(0)
})

test('onlyTests ignores failing commands that are not test runs', { options: { onlyTests: true, cooldownSeconds: 10 } }, async ($, on) => {
  mock.clock(on)
  const clips = engine(on, { isError: true })

  await $.tool.call({ tool: 'Bash', command: 'ls /nope' })
  expect(clips).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'pytest -x' })
  expect(clips).toHaveLength(1)
})

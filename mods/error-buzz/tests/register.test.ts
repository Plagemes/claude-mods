import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

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

test('regression: onlyTests does not count a command that merely names a runner', { options: { onlyTests: true, cooldownSeconds: 0 } }, async ($, on) => {
  mock.clock(on)
  const clips = engine(on, { isError: true })

  for (const command of ['cat jest.config.js', 'npm i -D vitest', 'git commit -m "add jest"', 'grep -r pytest .']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(clips).toHaveLength(0)

  for (const command of ['cd web && npx vitest run', 'python -m pytest -q', 'npm run test:unit', 'bundle exec rspec', 'go test ./...']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(clips).toHaveLength(5)
})

const SETTLE_MS = 250

/**
 * With mods-hub: a Bash call that exits 0 with `text`, after which the hub (as its sensors do, from a timer)
 * records `events` for the command that just ran.
 */
const hubbed = (on: On, text: string, events: { topic: string; data: Record<string, unknown> }[] = []) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hub = fakeHub(on)
  const clips: unknown[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: text, stderr: '', interrupted: false }, text }))
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })
  const publish = (command: string) => {
    for (const event of events) hub.events.push({ ...event, data: { ...event.data, command }, at: clock.now(), source: 'mods-hub' })
  }
  return { clock, hub, clips, publish }
}

test('with mods-hub: says hello and buzzes on the hub\'s failed test.result, without reading the output', async ($, on) => {
  const { clock, hub, clips, publish } = hubbed(on, 'all good, nothing parseable here', [
    { topic: 'test.result', data: { runner: 'jest', outcome: 'failed', passed: 8, failed: 2 } },
  ])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['test.result', 'error.repeated'] }])

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  publish('npm test')
  expect(clips).toEqual([])

  await clock.advance(SETTLE_MS)
  expect(clips).toEqual([{ asset: BUZZ_ASSET }])
})

test('with mods-hub: a passing test.result outranks output that looks like failures', async ($, on) => {
  const { clock, clips, publish } = hubbed(on, 'Tests: 1 failed (expected, snapshot), 9 passed', [
    { topic: 'test.result', data: { runner: 'jest', outcome: 'passed', passed: 10, failed: 0 } },
  ])

  await $.tool.call({ tool: 'Bash', command: 'npx jest' })
  publish('npx jest')
  await clock.advance(SETTLE_MS)
  expect(clips).toEqual([])
})

test('with mods-hub but no test.result for the call: the output is read as without it', async ($, on) => {
  const { clock, clips } = hubbed(on, 'Tests: 2 failed, 8 passed, 10 total')

  await $.tool.call({ tool: 'Bash', command: 'npx jest || true' })
  await clock.advance(SETTLE_MS)

  expect(clips).toHaveLength(1)
})

test('with mods-hub: a test.result of another run (test-watch, an earlier call) is not this call\'s verdict', async ($, on) => {
  const { clock, hub, clips } = hubbed(on, 'Tests: 10 passed, 10 total')
  hub.events.push({ topic: 'test.result', data: { runner: 'jest', outcome: 'failed', passed: 1, failed: 9, command: 'npx jest' }, at: 999_000, source: 'mods-hub' })
  hub.events.push({ topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 1, failed: 9, command: 'vitest run src/a.test.ts' }, at: 1_000_500, source: 'test-watch' })

  await $.tool.call({ tool: 'Bash', command: 'npx jest' })
  await clock.advance(SETTLE_MS)

  expect(clips).toEqual([])
})

test('with mods-hub: a command that keeps failing (error.repeated) buzzes once even inside the cooldown', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hub = fakeHub(on)
  const clips: unknown[] = []
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true as const, text: 'Exit code 1' }))
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })

  await $.tool.call({ tool: 'Bash', command: 'make deploy' })
  await clock.advance(SETTLE_MS)
  expect(clips).toHaveLength(1)

  await $.tool.call({ tool: 'Bash', command: 'make deploy' })
  await clock.advance(SETTLE_MS)
  expect(clips).toHaveLength(1) // inside the 10 s cooldown

  await $.tool.call({ tool: 'Bash', command: 'make deploy' })
  hub.events.push({ topic: 'error.repeated', data: { signature: 'make deploy', count: 3, tool: 'Bash', command: 'make deploy' }, at: clock.now(), source: 'mods-hub' })
  await clock.advance(SETTLE_MS)
  expect(clips).toHaveLength(2)

  await $.tool.call({ tool: 'Bash', command: 'make deploy' })
  await clock.advance(SETTLE_MS)
  expect(clips).toHaveLength(2) // the same event does not buzz twice
})

test('with mods-hub, onlyTests still ignores failing commands that are not test runs', { options: { onlyTests: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  fakeHub(on)
  const clips: unknown[] = []
  on('tool.call', () => ({ result: { stdout: '', stderr: 'no', interrupted: false }, isError: true as const, text: 'Exit code 2' }))
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })

  await $.tool.call({ tool: 'Bash', command: 'ls /nope' })
  await clock.advance(SETTLE_MS)

  expect(clips).toEqual([])
})

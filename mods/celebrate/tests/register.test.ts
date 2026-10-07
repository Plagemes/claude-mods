import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const FANFARE_ASSET = 'assets/celebrate.wav'

type Outcome = 'pass' | 'fail' | 'pass-with-failures'

// Stands for the engine: answers each Bash call with the next outcome, records toasts and clips.
const engine = (on: On, outcomes: Outcome[]) => {
  const toasts: string[] = []
  const clips: unknown[] = []
  const clock = mock.clock(on)
  on('tool.call', () => {
    const outcome = outcomes.shift() ?? 'pass'
    if (outcome === 'fail') {
      return { result: { stdout: '', stderr: '1 test failed', interrupted: false }, isError: true as const, text: 'Exit code 1' }
    }
    const text = outcome === 'pass' ? 'Tests: 10 passed, 10 total' : 'Tests: 2 failed, 8 passed, 10 total'
    return { result: { stdout: text, stderr: '', interrupted: false }, text }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })
  return { toasts, clips, clock }
}

test('celebrates when a failing test run goes green', async ($, on) => {
  const { toasts, clips, clock } = engine(on, ['fail', 'pass'])

  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(toasts).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  expect(toasts).toEqual(['🎉 All green: vitest passes again'])
  await clock.advance(1)
  expect(clips).toEqual([{ asset: FANFARE_ASSET }])
})

test('stays quiet for runs that were never red, and celebrates only once', async ($, on) => {
  const { toasts } = engine(on, ['pass', 'pass', 'fail', 'fail', 'pass', 'pass'])

  for (let run = 0; run < 6; run += 1) await $.tool.call({ tool: 'Bash', command: 'pytest' })

  expect(toasts).toHaveLength(1)
})

test('keeps each runner on its own, and ignores commands that are not test runs', async ($, on) => {
  const { toasts } = engine(on, ['fail', 'pass', 'pass', 'pass'])

  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  await $.tool.call({ tool: 'Bash', command: 'cargo test' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(toasts).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  expect(toasts).toEqual(['🎉 All green: go test passes again'])
})

test('treats a run that prints failures but exits 0 as red', async ($, on) => {
  const { toasts } = engine(on, ['pass-with-failures', 'pass'])

  await $.tool.call({ tool: 'Bash', command: 'npm run test | tail' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(toasts).toEqual(['🎉 All green: npm test passes again'])
})

test('the sound can be switched off', { options: { sound: false } }, async ($, on) => {
  const { toasts, clips, clock } = engine(on, ['fail', 'pass'])

  await $.tool.call({ tool: 'Bash', command: 'jest' })
  await $.tool.call({ tool: 'Bash', command: 'jest' })
  await clock.advance(1)

  expect(toasts).toHaveLength(1)
  expect(clips).toHaveLength(0)
})

test('regression: commands that only mention a runner are no test runs, so they neither go red nor celebrate', async ($, on) => {
  const { toasts } = engine(on, ['fail', 'pass', 'fail', 'pass', 'pass'])

  await $.tool.call({ tool: 'Bash', command: 'grep -rn jest src' })
  await $.tool.call({ tool: 'Bash', command: 'cat jest.config.js' })
  await $.tool.call({ tool: 'Bash', command: 'ls .pytest_cache' })
  await $.tool.call({ tool: 'Bash', command: 'pip install pytest' })
  expect(toasts).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'cd web && CI=1 npx jest --watch=false' })
  expect(toasts).toHaveLength(0)
})

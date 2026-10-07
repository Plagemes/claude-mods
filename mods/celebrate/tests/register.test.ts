import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fakeHub } from './hub'

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

const SETTLE_MS = 250

type Output = 'fail' | 'pass'
type Verdict = 'passed' | 'failed' | 'error' | undefined

/** With mods-hub: Bash calls whose output says nothing, and a hub that records the next verdict (if any) just after each. */
const hubbed = (on: On, mode: Parameters<typeof fakeHub>[1] = {}, outputs: Output[] = []) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hub = fakeHub(on, mode)
  const clips: unknown[] = []
  const toasts: string[] = []
  const verdicts: Verdict[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () =>
    outputs.shift() === 'fail'
      ? { result: { stdout: '', stderr: '1 test failed', interrupted: false }, isError: true as const, text: 'Exit code 1' }
      : { result: { stdout: 'done', stderr: '', interrupted: false }, text: 'done' },
  )
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    clips.push(e.clip)
    return { value: undefined }
  })
  /** Runs `command`; the hub's sensor then publishes `verdict` for it, and the mod's settle delay passes. */
  const run = async ($: Engine, command: string) => {
    await $.tool.call({ tool: 'Bash', command })
    const verdict = verdicts.shift()
    if (verdict !== undefined) hub.events.push({ topic: 'test.result', data: { runner: 'jest', outcome: verdict, passed: 1, failed: 0, command }, at: clock.now(), source: 'mods-hub' })
    await clock.advance(SETTLE_MS)
  }
  return { clock, hub, clips, toasts, verdicts, run }
}

test('with mods-hub: follows the hub\'s test.result, notifies success instead of toasting, and plays the fanfare', async ($, on) => {
  const { hub, clips, toasts, verdicts, run } = hubbed(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['test.result'] }])

  verdicts.push('failed', 'passed')
  await run($, 'npx jest') // the output says nothing: only the hub knows it was red
  expect(hub.notified).toEqual([])
  await run($, 'npx jest')

  expect(hub.notified).toEqual([{ level: 'success', title: '🎉 All green: jest passes again', topic: 'test.result' }])
  expect(toasts).toEqual([])
  expect(clips).toEqual([{ asset: FANFARE_ASSET }])
})

test('with mods-hub: an errored run (the tests did not run) is red, not green', async ($, on) => {
  const { hub, verdicts, run } = hubbed(on)

  verdicts.push('failed', 'error', 'passed')
  await run($, 'pytest')
  await run($, 'pytest')
  expect(hub.notified).toEqual([])
  await run($, 'pytest')
  expect(hub.notified).toHaveLength(1)
})

test('with mods-hub in Silent or Night mode: the toast goes to the hub (which holds it) but no fanfare is started', async ($, on) => {
  const { hub, clips, verdicts, run } = hubbed(on, { isNight: true })

  verdicts.push('failed', 'passed')
  await run($, 'cargo test')
  await run($, 'cargo test')

  expect(hub.notified.map(notice => notice.title)).toEqual(['🎉 All green: cargo test passes again'])
  expect(clips).toEqual([])
})

test('with mods-hub but no test.result for the call: the output is read as without it', async ($, on) => {
  const { hub, clips, run } = hubbed(on, {}, ['fail', 'pass'])

  await run($, 'go test ./...')
  expect(hub.notified).toEqual([])
  await run($, 'go test ./...')

  expect(hub.notified.map(notice => notice.title)).toEqual(['🎉 All green: go test passes again'])
  expect(clips).toHaveLength(1)
})

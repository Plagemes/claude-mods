import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

const MINUTE = 60_000

type World = {
  toasts: string[]
  porcelain: { stdout: string; exitCode: number }
  advance: (ms: number) => Promise<void>
  gitCalls: () => number
}

const answerEngine = (on: On): World => {
  const clock = mock.clock(on)
  let gitCalls = 0
  const world: World = {
    toasts: [],
    porcelain: { stdout: ' M src/a.ts\n?? notes.md\n', exitCode: 0 },
    advance: clock.advance,
    gitCalls: () => gitCalls,
  }
  on('process.run', () => {
    gitCalls += 1
    return {
      value: { ...world.porcelain, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  return world
}

const start = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
const prompt = ($: Engine) => $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
const finishedTurn = async ($: Engine) => {
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
}

test('toasts once after 20 idle minutes with uncommitted files', async ($, on) => {
  const world = answerEngine(on)
  await start($)

  await world.advance(19 * MINUTE)
  expect(world.toasts).toHaveLength(0)
  expect(world.gitCalls()).toBe(0)

  await world.advance(2 * MINUTE)
  expect(world.toasts).toEqual(['idle-nudge: you have 2 uncommitted files (idle 20 min)'])

  await world.advance(30 * MINUTE)
  expect(world.toasts).toHaveLength(1)
})

test('a prompt resets the idle time and allows a later nudge', async ($, on) => {
  const world = answerEngine(on)
  await start($)

  await world.advance(15 * MINUTE)
  await prompt($)
  await world.advance(10 * MINUTE)
  expect(world.toasts).toHaveLength(0)

  await world.advance(11 * MINUTE)
  expect(world.toasts).toHaveLength(1)

  await prompt($)
  await world.advance(21 * MINUTE)
  expect(world.toasts).toHaveLength(2)
})

test('stays quiet in a clean repo, outside a repo, and while a turn is running', async ($, on) => {
  const world = answerEngine(on)
  await start($)

  world.porcelain = { stdout: '', exitCode: 0 }
  await world.advance(25 * MINUTE)
  world.porcelain = { stdout: 'fatal: not a git repository', exitCode: 128 }
  await world.advance(10 * MINUTE)
  expect(world.toasts).toHaveLength(0)

  world.porcelain = { stdout: ' M a.ts\n', exitCode: 0 }
  await $.turn.start({ text: 'long job', turnId: 'long' })
  await world.advance(60 * MINUTE)
  expect(world.toasts).toHaveLength(0)

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'long' })
  await world.advance(10 * MINUTE)
  expect(world.toasts).toHaveLength(0)
  await world.advance(11 * MINUTE)
  expect(world.toasts).toEqual(['idle-nudge: you have 1 uncommitted file (idle 20 min)'])
})

test('the idle time comes from the configuration', { options: { idleMinutes: 5 } }, async ($, on) => {
  const world = answerEngine(on)
  await start($)
  await finishedTurn($)

  await world.advance(6 * MINUTE)
  expect(world.toasts).toHaveLength(1)
})

test('with mods-hub: no nudge while you are active in another session, and the nudge is a hub notice', async ($, on) => {
  const world = answerEngine(on)
  const hub = fakeHub(on)
  await start($)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['session.idle'] }])

  // Idle here for 20 minutes, but typing in another session: the hub says you are here.
  await world.advance(21 * MINUTE)
  expect(hub.notified).toEqual([])

  hub.mode = { ...hub.mode, presence: 'idle' }
  await world.advance(MINUTE)
  expect(world.toasts).toEqual([])
  expect(hub.notified).toEqual([{ level: 'info', title: 'idle-nudge: you have 2 uncommitted files (idle 22 min)', topic: 'session.idle' }])

  await world.advance(10 * MINUTE)
  expect(hub.notified).toHaveLength(1)
})

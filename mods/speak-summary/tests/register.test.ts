import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, TurnCompleteInput } from 'claude-code'

import { fakeHub } from './hub'

const LONG_TURN: TurnCompleteInput = {
  answer: 'I fixed the **flaky** login test in `auth.spec.ts` and all 42 tests now pass. Details follow.',
  durationMs: 45_000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
}

/** A slash command as the person types it at a terminal prompt. */
const typed = (args: string): CommandRunInput => ({
  command: 'speak',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

type World = { spoken: string[]; prompts: string[]; toasts: string[] }

/** Stands in for the engine beneath the plugin: model, speech, toasts, commands. */
const world = (on: On, reply: string | null, canSpeak = true): World => {
  const seen: World = { spoken: [], prompts: [], toasts: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    seen.prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return {
      value:
        reply === null
          ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage }
          : { isAnswered: true, text: reply, usage },
    }
  })
  on('audio.speak', ($, e) => {
    if (!canSpeak) throw new Error('no speech synthesizer')
    seen.spoken.push(e.text)
    return { value: { via: 'system' } }
  })
  mock.store(on)
  return seen
}

test('speaks a short model summary after a long turn', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, '"Fixed the **flaky** login test; all tests pass now."')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const result = await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(result.text).toBe(LONG_TURN.answer)
  expect(seen.prompts[0]).toContain('flaky')
  expect(seen.spoken).toEqual(['Fixed the flaky login test; all tests pass now.'])
})

test('stays quiet for short, aborted and subagent turns', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Did a thing.')

  await $.turn.complete({ ...LONG_TURN, durationMs: 3_000 })
  await $.turn.complete({ ...LONG_TURN, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...LONG_TURN, agentId: 'agent-7' })
  await clock.advance(0)

  expect(seen.spoken).toEqual([])
})

test('falls back to the first sentence, capped at 15 words, when the model fails', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, null)
  const rambling = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. Second.'

  await $.turn.complete({ ...LONG_TURN, answer: rambling })
  await clock.advance(0)

  expect(seen.spoken).toEqual(['One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.'])
})

test('/speak off silences it and /speak on brings it back', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Done and dusted.')

  const off = await $.command.run(typed('off'))
  await $.turn.complete(LONG_TURN)
  await clock.advance(0)
  expect(off.text).toContain('off')
  expect(seen.spoken).toEqual([])

  await $.command.run(typed('on'))
  await $.turn.complete(LONG_TURN)
  await clock.advance(0)
  expect(seen.spoken).toEqual(['Done and dusted.'])

  const status = await $.command.run(typed(''))
  expect(status.text).toContain('on')
})

test('respects the configured threshold and warns once when speech is unavailable', { options: { minDurationSec: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false)

  await $.turn.complete({ ...LONG_TURN, durationMs: 6_000 })
  await clock.advance(0)
  await $.turn.complete({ ...LONG_TURN, durationMs: 6_000 })
  await clock.advance(0)

  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('cannot speak')
})

test('with mods-hub: says hello, speaks on a quiet afternoon, and routes the cannot-speak warning through the hub', async ($, on) => {
  const clock = mock.clock(on)
  const hub = fakeHub(on)
  const seen = world(on, 'Ran the build.', false)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.toasts).toEqual([])
  expect(hub.notified).toHaveLength(1)
  expect(hub.notified[0]).toMatchObject({ level: 'info', audience: 'terminal' })
  expect(hub.notified[0]?.title).toContain('cannot speak here')
})

test('with mods-hub in Silent or Night mode: neither a summary call nor speech is started', async ($, on) => {
  const clock = mock.clock(on)
  const hub = fakeHub(on, { isSilent: true })
  const seen = world(on, 'Did a thing.')

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)
  hub.mode = { ...hub.mode, isSilent: false, isNight: true }
  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.prompts).toEqual([])
  expect(seen.spoken).toEqual([])

  hub.mode = { ...hub.mode, isNight: false }
  await $.turn.complete(LONG_TURN)
  await clock.advance(0)
  expect(seen.spoken).toEqual(['Did a thing.'])
})

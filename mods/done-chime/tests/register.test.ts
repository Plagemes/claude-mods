import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { fakeHub } from './hub'

type Played = { asset?: string; gain?: number }

/** Stands in for the engine: a mocked clock, the turn's answer, and the clips that were played. */
const engine = (on: On, playback: 'works' | 'fails' = 'works') => {
  const played: Played[] = []
  const clock = mock.clock(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('audio.play', (_$, e) => {
    played.push({ asset: e.clip.asset, gain: e.gain })
    return playback === 'works' ? { value: undefined } : { deny: 'no audio player' }
  })
  return { played, clock }
}

type Turn = { durationMs: number; reason?: 'answer' | 'aborted' | 'error'; agentId?: string }

const complete = ($: Engine, { durationMs, reason = 'answer', agentId }: Turn) =>
  $.turn.complete({ answer: 'Done.', durationMs, reason, isAborted: reason === 'aborted', turnId: 'turn-1', agentId })

const finishTurn = async ($: Engine, clock: { settle: () => Promise<void> }, turn: Turn) => {
  const result = await complete($, turn)
  await clock.settle()
  return result
}

test('plays the bundled chime when a turn took longer than the threshold', async ($, on) => {
  const { played, clock } = engine(on)

  const result = await finishTurn($, clock, { durationMs: 45_000 })

  expect(result.text).toBe('Done.')
  expect(played).toEqual([{ asset: 'assets/chime.wav', gain: 1 }])
})

test('stays silent for short turns, interrupted turns, errors and subagents', async ($, on) => {
  const { played, clock } = engine(on)

  await finishTurn($, clock, { durationMs: 20_000 }) // not longer than 20 s
  await finishTurn($, clock, { durationMs: 90_000, reason: 'aborted' })
  await finishTurn($, clock, { durationMs: 90_000, reason: 'error' })
  await finishTurn($, clock, { durationMs: 90_000, agentId: 'agent-7' })

  expect(played).toEqual([])
})

test('reads the threshold and volume from the options', { options: { seconds: 5, volume: 0.4 } }, async ($, on) => {
  const { played, clock } = engine(on)

  await finishTurn($, clock, { durationMs: 4_000 })
  expect(played).toEqual([])

  await finishTurn($, clock, { durationMs: 6_000 })
  expect(played).toEqual([{ asset: 'assets/chime.wav', gain: 0.4 }])
})

test('does not hold up the end of the turn, and a machine that cannot play audio is no problem', async ($, on) => {
  const { played, clock } = engine(on, 'fails')

  const result = await complete($, { durationMs: 60_000 })
  expect(result.text).toBe('Done.')
  expect(played).toEqual([]) // the timer has not fired yet: the turn did not wait for the sound

  await clock.settle()
  expect(played).toHaveLength(1) // it tried, was refused, and nothing broke
})

test('volume 0 mutes the chime', { options: { volume: 0 } }, async ($, on) => {
  const { played, clock } = engine(on)

  await finishTurn($, clock, { durationMs: 60_000 })

  expect(played).toEqual([])
})

test('with mods-hub: says hello once, and still chimes on a quiet afternoon', async ($, on) => {
  const { played, clock } = engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  await finishTurn($, clock, { durationMs: 45_000 })
  expect(played).toEqual([{ asset: 'assets/chime.wav', gain: 1 }])
  expect(hub.notified).toEqual([])
})

test('with mods-hub in Silent or Night mode: no chime is even started', async ($, on) => {
  const { played, clock } = engine(on)
  const hub = fakeHub(on, { isSilent: true })

  await finishTurn($, clock, { durationMs: 45_000 })
  expect(played).toEqual([])

  hub.mode = { ...hub.mode, isSilent: false, isNight: true }
  await finishTurn($, clock, { durationMs: 45_000 })
  expect(played).toEqual([])

  hub.mode = { ...hub.mode, isNight: false }
  await finishTurn($, clock, { durationMs: 45_000 })
  expect(played).toHaveLength(1)
})

test('without mods-hub: session start is a no-op and nothing changes', async ($, on) => {
  const { played, clock } = engine(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await finishTurn($, clock, { durationMs: 45_000 })

  expect(played).toHaveLength(1)
})

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

type Run = { argv: readonly string[]; stdin: string | undefined; env: Record<string, string> | undefined; timeoutMs: number | undefined }
type World = { spoken: string[]; prompts: string[]; toasts: string[]; logs: string[]; runs: Run[]; speakCalls: number }
type Host = { os?: 'Windows_NT' | 'Linux' | 'Darwin'; exit?: number; missing?: readonly string[] }

/** Stands in for the engine beneath the plugin: model, speech, toasts, commands. */
const world = (on: On, reply: string | null, canSpeak = true, host: Host = {}): World => {
  const seen: World = { spoken: [], prompts: [], toasts: [], logs: [], runs: [], speakCalls: 0 }
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'OS' && host.os === 'Windows_NT' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    const [bin = ''] = e.argv
    if (bin === 'uname') return { value: { exitCode: 0, stdout: `${host.os ?? 'Linux'}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    seen.runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env, timeoutMs: e.init?.timeoutMs })
    if (host.missing?.includes(bin)) throw new Error(`failed to start: ENOENT ${bin}`)
    return { value: { exitCode: host.exit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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
    seen.speakCalls += 1
    if (!canSpeak) throw new Error('$.audio.speak: no speech synthesizer on windows')
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

test('respects the configured threshold', { options: { minDurationSec: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.')

  await $.turn.complete({ ...LONG_TURN, durationMs: 4_000 })
  await clock.advance(0)
  expect(seen.spoken).toEqual([])
  await $.turn.complete({ ...LONG_TURN, durationMs: 6_000 })
  await clock.advance(0)
  expect(seen.spoken).toEqual(['Ran the build.'])
})

test('Windows: falls back to SAPI through powershell with the text on stdin', { options: { voice: 'Microsoft Zira' } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Windows_NT' })

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.toasts).toEqual([])
  expect(seen.runs).toHaveLength(1)
  const run = seen.runs[0]
  expect(run?.argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(run?.argv[4]).toContain('System.Speech')
  expect(run?.argv[4]).toContain('[Console]::In.ReadToEnd()')
  expect(run?.stdin).toBe('Ran the build.')
  expect(run?.env).toEqual({ SPEAK_SUMMARY_VOICE: 'Microsoft Zira' })
  expect(run?.timeoutMs).toBeGreaterThan(0)
})

test('hostile text (quotes, $(), backticks, newlines) travels only on stdin', async ($, on) => {
  const clock = mock.clock(on)
  const hostile = 'He said "hi" and \'bye\'\n$(calc.exe); `whoami` ; Remove-Item *\nnext line'
  const seen = world(on, hostile, false, { os: 'Windows_NT' })

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.runs).toHaveLength(1)
  const run = seen.runs[0]
  expect(run?.stdin).toContain('$(calc.exe)')
  expect(run?.stdin).toContain('"hi"')
  expect(run?.stdin).not.toContain('\n')
  const command = (run?.argv ?? []).join(' ')
  for (const fragment of ['calc.exe', 'whoami', 'Remove-Item', 'hi', 'bye']) expect(command).not.toContain(fragment)
})

test('unavailable everywhere: one quiet log line, no toast, no repeats, off for the session', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Windows_NT', exit: 1 })

  for (let i = 0; i < 3; i += 1) {
    await $.turn.complete(LONG_TURN)
    await clock.advance(0)
  }

  expect(seen.toasts).toEqual([])
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toContain('speaking is off for this session')
  expect(seen.speakCalls).toBe(1)
  expect(seen.runs).toHaveLength(1)
  const status = await $.command.run(typed('status'))
  expect(status.text).toContain('unavailable')
})

test('a missing binary counts as unavailable, Linux tries spd-say then espeak', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Linux', missing: ['spd-say', 'espeak'] })

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.runs.map(run => run.argv[0])).toEqual(['spd-say', 'espeak'])
  expect(seen.logs).toHaveLength(1)
  expect(seen.toasts).toEqual([])
})

test('macOS fallback uses say with stdin only when the engine cannot speak', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Darwin' })

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.runs.map(run => [run.argv, run.stdin])).toEqual([[['say'], 'Ran the build.']])
})

test('the working method is probed once and cached', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Windows_NT' })

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)
  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.runs).toHaveLength(2)
  expect(seen.speakCalls).toBe(1)
  const status = await $.command.run(typed(''))
  expect(status.text).toContain('speech: powershell')
})

test('with mods-hub: says hello, speaks on a quiet afternoon, and never notifies when speech is unavailable', async ($, on) => {
  const clock = mock.clock(on)
  const hub = fakeHub(on)
  const seen = world(on, 'Ran the build.', false, { os: 'Linux', missing: ['spd-say', 'espeak'] })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  await $.turn.complete(LONG_TURN)
  await clock.advance(0)

  expect(seen.toasts).toEqual([])
  expect(hub.notified).toEqual([])
  expect(seen.logs).toHaveLength(1)
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

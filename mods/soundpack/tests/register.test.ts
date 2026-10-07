import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Played = { asset?: string; gain?: number }
type Reply = { text: string; isError?: true }

/** The engine under the plugin: a mocked clock, the clips that were played, and Bash answering `reply`. */
const world = (on: On, reply: Reply = { text: 'ok' }, playback: 'works' | 'fails' = 'works', kernel = 'Darwin') => {
  const clock = mock.clock(on)
  const played: Played[] = []
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: 'out', ...reply }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${kernel}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  on('audio.play', (_$, e) => {
    played.push({ asset: e.clip.asset, gain: e.gain })
    return playback === 'works' ? { value: undefined } : { deny: 'no audio player' }
  })
  return { clock, played }
}

const bash = async ($: Engine, clock: { settle: () => Promise<void> }, command: string, extra: { run_in_background?: true } = {}) => {
  const result = await $.tool.call({ tool: 'Bash', command, ...extra })
  await clock.settle()
  return result
}

const endTurn = async ($: Engine, clock: { settle: () => Promise<void> }, durationMs: number, extra: { agentId?: string; reason?: 'answer' | 'aborted' | 'error' } = {}) => {
  const reason = extra.reason ?? 'answer'
  await $.turn.complete({ answer: 'Done.', durationMs, reason, isAborted: reason === 'aborted', turnId: 't1', agentId: extra.agentId })
  await clock.settle()
}

const soundpack = ($: Engine, args = '') =>
  $.command.run({ command: 'soundpack', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a long turn plays the done sound of the pack; short, interrupted and subagent turns stay silent', async ($, on) => {
  const { clock, played } = world(on)

  await endTurn($, clock, 20_000) // not longer than 20 s
  await endTurn($, clock, 90_000, { reason: 'aborted' })
  await endTurn($, clock, 90_000, { agentId: 'agent-1' })
  expect(played).toEqual([])

  await endTurn($, clock, 45_000)
  expect(played).toEqual([{ asset: 'assets/minimal/done.wav', gain: 1 }])
})

test('a failing command plays the error sound, at most once per 8 seconds', async ($, on) => {
  const { clock, played } = world(on, { text: 'Exit code 1\nboom', isError: true })

  await bash($, clock, 'make build')
  await clock.advance(3000)
  await bash($, clock, 'make build')
  expect(played).toEqual([{ asset: 'assets/minimal/error.wav', gain: 1 }])

  await clock.advance(6000)
  await bash($, clock, 'make build')
  expect(played).toHaveLength(2)
})

test('a passing test run plays the green sound; other successful commands are silent', async ($, on) => {
  const { clock, played } = world(on, { text: '12 passed in 1.2s' })

  await bash($, clock, 'ls')
  expect(played).toEqual([])

  await bash($, clock, 'pytest -q')
  expect(played).toEqual([{ asset: 'assets/minimal/green.wav', gain: 1 }])
})

test('a failing test run plays the error sound, not the green one', async ($, on) => {
  const failed = world(on, { text: 'Tests: 2 failed, 10 passed', isError: true })
  await bash($, failed.clock, 'npm test')
  expect(failed.played.map(clip => clip.asset)).toEqual(['assets/minimal/error.wav'])
})

test('a test runner that printed failures but exited 0 is an error too', async ($, on) => {
  const { clock, played } = world(on, { text: ' Test Files  1 failed | 2 passed (3)\n      Tests  3 failed | 9 passed (12)' })

  await bash($, clock, 'npm test || true')

  expect(played.map(clip => clip.asset)).toEqual(['assets/minimal/error.wav'])
})

test('a background test run makes no sound', async ($, on) => {
  const { clock, played } = world(on, { text: '3 passed' })

  await bash($, clock, 'pytest', { run_in_background: true })
  expect(played).toEqual([])
})

test('a permission prompt plays once, however many events announce it, and not when a hook already answered', async ($, on) => {
  const { clock, played } = world(on)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  await clock.settle()
  expect(played).toEqual([{ asset: 'assets/minimal/permission.wav', gain: 1 }])

  await clock.advance(5000)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  await clock.settle()
  expect(played).toHaveLength(2)
})

test('the pack option picks the folder the sounds come from', { options: { pack: 'retro' } }, async ($, on) => {
  const { clock, played } = world(on, { text: 'boom', isError: true })

  await bash($, clock, 'make')
  await endTurn($, clock, 60_000)
  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
  await clock.settle()

  expect(played.map(clip => clip.asset)).toEqual(['assets/retro/error.wav', 'assets/retro/done.wav', 'assets/retro/permission.wav'])
})

test('an unknown pack falls back to minimal', { options: { pack: 'jazz' } }, async ($, on) => {
  const { clock, played } = world(on)

  await endTurn($, clock, 60_000)

  expect(played[0]?.asset).toBe('assets/minimal/done.wav')
})

test('each sound has its own switch', { options: { done: false, error: false, permission: false, green: true } }, async ($, on) => {
  const { clock, played } = world(on, { text: '3 passed' })

  await endTurn($, clock, 60_000)
  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' })
  await bash($, clock, 'pytest')

  expect(played.map(clip => clip.asset)).toEqual(['assets/minimal/green.wav'])
})

test('volume sets the gain, 0 mutes, and the long-turn limit is configurable', { options: { volume: 0.4, longTurnSeconds: 5 } }, async ($, on) => {
  const { clock, played } = world(on)

  await endTurn($, clock, 4_000)
  expect(played).toEqual([])
  await endTurn($, clock, 6_000)
  expect(played).toEqual([{ asset: 'assets/minimal/done.wav', gain: 0.4 }])
})

test('volume 0 mutes every sound', { options: { volume: 0 } }, async ($, on) => {
  const { clock, played } = world(on, { text: 'boom', isError: true })

  await bash($, clock, 'make')
  await endTurn($, clock, 60_000)

  expect(played).toEqual([])
})

test('sounds never hold up the call, and a machine that cannot play audio is no problem', async ($, on) => {
  const { clock, played } = world(on, { text: 'boom', isError: true }, 'fails')

  const result = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(result.isError).toBe(true)
  expect(played).toEqual([]) // the timer has not fired: the call did not wait for the sound

  await clock.settle()
  expect(played).toHaveLength(1) // it tried, was refused, and nothing broke
})

test('/soundpack plays the four sounds of the pack one after another and shows the settings', async ($, on) => {
  const { clock, played } = world(on)

  const shown = await soundpack($)
  expect(played.map(clip => clip.asset)).toEqual(['assets/minimal/done.wav'])
  await clock.advance(1700)
  await clock.advance(1700)
  await clock.advance(1700)

  expect(played.map(clip => clip.asset)).toEqual(['done', 'error', 'permission', 'green'].map(event => `assets/minimal/${event}.wav`))
  expect(shown.text).toContain('Playing the minimal pack: done, error, permission, green.')
  expect(shown.text).toContain('Pack: minimal (minimal, retro, nature; change it in /config). Volume: 1.')
  expect(shown.text).toContain('error      on   when a command fails')
  expect(shown.text).toContain('This is macOS: sounds play through afplay.')
})

test('/soundpack <pack> previews another pack and /soundpack <event> plays one sound', async ($, on) => {
  const { clock, played } = world(on)

  await soundpack($, 'nature')
  await clock.advance(6000)
  expect(played.map(clip => clip.asset)).toEqual(['done', 'error', 'permission', 'green'].map(event => `assets/nature/${event}.wav`))

  played.length = 0
  const one = await soundpack($, 'green')
  await clock.advance(6000)
  expect(played.map(clip => clip.asset)).toEqual(['assets/minimal/green.wav'])
  expect(one.text).toContain('Playing green from the minimal pack.')
})

test('/soundpack says why when nothing can play, and shows the usage for anything else', async ($, on) => {
  world(on, { text: 'ok' }, 'fails')

  const failed = await soundpack($)
  expect(failed.text).toContain('Could not play the minimal pack: done, error, permission, green: ')
  expect(failed.text).toContain('no audio player.\nPack: minimal')

  const usage = await soundpack($, 'disco')
  expect(usage.text).toBe('Usage: /soundpack [minimal | retro | nature | done | error | permission | green]. With no argument it plays the four sounds of the current pack.')
})

test('/soundpack says plainly that nothing is heard where afplay does not exist', async ($, on) => {
  world(on, { text: 'ok' }, 'works', 'Linux')

  const shown = await soundpack($)

  expect(shown.text).toContain('which only macOS has, so nothing is heard on this Linux machine.')
})

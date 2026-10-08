import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, ProcessRunResult } from 'claude-code'

import { fakeHub } from './hub'

const SHA = 'abc1234def5678'
const OLD_SHA = '0000000aaaaaaa'

type Run = { databaseId: number; status: string; conclusion: string; name: string; workflowName: string; event: string; url: string; headSha: string }
type World = {
  runs: Run[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  sounds: string[]
  prompts: string[]
  ghCalls: number
}

const run = (id: number, workflowName: string, status: string, conclusion = '', headSha = SHA): Run => ({
  databaseId: id,
  status,
  conclusion,
  name: workflowName,
  workflowName,
  event: 'push',
  url: `https://github.com/acme/shop/actions/runs/${id}`,
  headSha,
})

const typed = (args: string): CommandRunInput => ({
  command: 'ci-watch',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'error: something broke', isStdoutTruncated: false, isStderrTruncated: false },
})

/** A git repo on `main`, pushed at SHA, whose `gh run list` answers `seen.runs`. */
function world(on: On, options: { hasGh?: boolean; isRepo?: boolean } = {}): World {
  const seen: World = { runs: [], statuses: [], toasts: [], logs: [], sounds: [], prompts: [], ghCalls: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.repo', () => ({
    value: options.isRepo === false ? null : { root: '/home/me/shop', remote: null, internal: false, name: null },
  }))
  on('process.run', ($, e) => {
    const [tool, ...args] = e.argv
    if (tool === 'gh') {
      if (options.hasGh === false) return { deny: 'spawn gh ENOENT' }
      seen.ghCalls += 1
      return ok(JSON.stringify(seen.runs))
    }
    if (args.includes('--abbrev-ref')) return ok('main\n')
    if (args.includes('origin/main')) return ok(`${SHA}\n`)
    return ok('', 1)
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    seen.sounds.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  return seen
}

test('follows a running run and announces the pass with toast, log and chime', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.runs = [run(2, 'build', 'in_progress'), run(3, 'lint', 'queued'), run(1, 'build', 'completed', 'failure', OLD_SHA)]

  const started = await $.command.run(typed(''))
  expect(started.text).toContain('watching CI on main @ abc1234')
  expect(seen.statuses.at(-1)).toBe('⏳ CI running on main @ abc1234 · 0/2 done · build')

  seen.runs = [run(2, 'build', 'completed', 'success'), run(3, 'lint', 'in_progress')]
  await clock.advance(30_000)
  expect(seen.statuses.at(-1)).toBe('⏳ CI running on main @ abc1234 · 1/2 done · lint')

  seen.runs = [run(2, 'build', 'completed', 'success'), run(3, 'lint', 'completed', 'skipped')]
  await clock.advance(30_000)
  expect(seen.toasts).toEqual(['✅ CI passed on main · 2 workflows'])
  expect(seen.logs[0]).toContain('actions/runs/2')
  expect(seen.sounds).toEqual(['assets/pass.wav'])
  expect(seen.statuses.at(-1)).toBeUndefined()

  const calls = seen.ghCalls
  await clock.advance(120_000)
  expect(seen.ghCalls).toBe(calls)
})

test('a failure plays the low tone and, with autoFix, asks Claude to investigate', { options: { autoFix: true, sound: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.runs = [run(7, 'test', 'in_progress')]

  await $.command.run(typed('main'))
  seen.runs = [run(7, 'test', 'completed', 'failure')]
  await clock.advance(30_000)

  expect(seen.toasts).toEqual(['❌ CI failed on main: test (failure)'])
  expect(seen.sounds).toEqual(['assets/fail.wav'])
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('CI failed: investigate')
  expect(seen.prompts[0]).toContain('gh run view 7 --log-failed')
})

test('waits for the pushed commit when only older runs exist', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.runs = [run(1, 'build', 'completed', 'success', OLD_SHA)]

  await $.command.run(typed(''))
  expect(seen.statuses.at(-1)).toBe('🕒 CI: waiting for a run on main @ abc1234')

  seen.runs = [run(2, 'build', 'queued'), ...seen.runs]
  await clock.advance(30_000)
  expect(seen.statuses.at(-1)).toContain('⏳ CI running')
})

test('reports a run that already finished without polling', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.runs = [run(4, 'deploy', 'completed', 'success')]

  const result = await $.command.run(typed(''))
  await clock.advance(60_000)

  expect(result.text).toContain('✅ CI passed on main · deploy (already finished)')
  expect(seen.ghCalls).toBe(1)
})

test('/ci-watch stop cancels polling and clears the status line', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.runs = [run(5, 'build', 'in_progress')]

  await $.command.run(typed(''))
  const stopped = await $.command.run(typed('stop'))
  await clock.advance(90_000)

  expect(stopped.text).toBe('ci-watch: stopped watching main.')
  expect(seen.ghCalls).toBe(1)
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('explains a missing gh', async ($, on) => {
  world(on, { hasGh: false })
  const noGh = await $.command.run(typed(''))
  expect(noGh.text).toContain('GitHub CLI (gh) is not installed')
})

test('says so outside a git repository', async ($, on) => {
  world(on, { isRepo: false })
  const result = await $.command.run(typed(''))
  expect(result.text).toBe('ci-watch: this folder is not a git repository.')
})

test('with mods-hub: follows the branch just pushed, publishes ci.result and notifies instead of toasting', { options: { autoFix: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = world(on)
  const hub = fakeHub(on)
  hub.events.push({ topic: 'git.push', data: { remote: 'origin', branch: 'feature/cart', isForce: false }, at: 1_000_000 - 60_000, source: 'force-push-guard' })
  seen.runs = [run(8, 'test', 'in_progress')]

  await $.session.start({ cwd: '/home/me/shop', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['ci.result'], consumes: ['git.push'] }])

  expect((await $.command.run(typed(''))).text).toContain('watching CI on feature/cart')
  seen.runs = [run(8, 'test', 'completed', 'failure')]
  await clock.advance(30_000)

  expect(hub.published).toEqual([
    {
      topic: 'ci.result',
      data: { provider: 'github', workflow: 'test', outcome: 'failed', branch: 'feature/cart', url: 'https://github.com/acme/shop/actions/runs/8', durationMs: 30_000 },
      scope: 'global',
    },
  ])
  expect(hub.notified).toEqual([
    { level: 'error', title: '❌ CI failed on feature/cart: test (failure)', topic: 'ci.result', url: 'https://github.com/acme/shop/actions/runs/8' },
  ])
  expect(seen.toasts).toEqual([])
  expect(seen.sounds).toEqual(['assets/fail.wav'])
})

test('with mods-hub in Silent or Night mode: no chime of its own', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  const hub = fakeHub(on, { isNight: true })
  seen.runs = [run(9, 'build', 'in_progress')]

  await $.command.run(typed('main'))
  seen.runs = [run(9, 'build', 'completed', 'success')]
  await clock.advance(30_000)

  expect(hub.notified.map(notice => notice.level)).toEqual(['success'])
  expect(seen.sounds).toEqual([])
})

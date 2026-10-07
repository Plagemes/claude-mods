import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

import { fakeHub } from './hub'

const DIRTY = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head feat/x',
  '# branch.upstream origin/feat/x',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts',
  '1 A. N... 000000 100644 100644 0000 cccc src/b.ts',
  '? notes.txt',
].join('\n')

type Git = { stdout: string; exitCode?: number }

/** Records the status lines and the git calls; `git` is read at every call, so a test can change it. */
function world(on: On, git: Git) {
  const lines: Array<string | undefined> = []
  const calls: string[][] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return {
      value: { exitCode: git.exitCode ?? 0, stdout: git.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { lines, calls }
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

test('shows branch, ahead/behind and the dirty count when the session starts', async ($, on) => {
  const clock = mock.clock(on)
  const { lines } = world(on, { stdout: DIRTY })
  await $.session.start(START)
  await clock.advance(10)
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3'])
})

test('debounces a burst of tool calls into one git status', async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = world(on, { stdout: DIRTY })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/b', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'git add -A' })
  await clock.advance(500)
  expect(calls).toHaveLength(0)
  await clock.advance(200)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
})

test('only updates the line when the text changes, and shows a clean tree and a detached HEAD', async ($, on) => {
  const clock = mock.clock(on)
  const git: Git = { stdout: DIRTY }
  const { lines } = world(on, git)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(700)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(700)

  git.stdout = ['# branch.oid abcdef0123456789', '# branch.head (detached)'].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'git checkout abcdef0' })
  await clock.advance(700)
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3', '⎇ (abcdef0) ✓'])
})

test('is silent outside a git repository and clears a line it showed before', async ($, on) => {
  const clock = mock.clock(on)
  const git: Git = { stdout: DIRTY }
  const { lines } = world(on, git)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(700)

  git.exitCode = 128
  git.stdout = ''
  await $.tool.call({ tool: 'Bash', command: 'cd / ' })
  await clock.advance(700)
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3', undefined])
})

test('showUntracked: false leaves untracked files out of git status', { options: { showUntracked: false, debounceMs: 100 } }, async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = world(on, { stdout: DIRTY })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(150)
  expect(calls[0]).toContain('--untracked-files=no')
})

const MANIFEST = '{"version":"1.0.0"}'
const TURN = { answer: 'ok', durationMs: 900, isAborted: false, turnId: 't', reason: 'answer' } as const

test('with mods-hub: says hello, shares the branch as a fact and refreshes when a commit lands on the bus', async ($, on) => {
  const clock = mock.clock(on)
  const git: Git = { stdout: DIRTY }
  const { lines, calls } = world(on, git)
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: MANIFEST }))

  await $.session.start(START)
  await clock.advance(10)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['git.commit', 'git.push'] }])
  expect(hub.facts.get('branch')).toEqual({ branch: 'feat/x', ahead: 2, behind: 0, dirty: 3, isDetached: false })
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3'])

  // commit-composer commits through $.process, not through a tool call: only the hub's event tells.
  git.stdout = ['# branch.oid 2222222', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +3 -0'].join('\n')
  await clock.advance(1000)
  hub.events.push({ topic: 'git.commit', data: { sha: 'abc', message: 'x', branch: 'feat/x', files: 3 }, at: 500, source: 'commit-composer' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(calls).toHaveLength(2)
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3', '⎇ feat/x ↑3 ↓0 ✓'])
  expect(hub.facts.get('branch')).toEqual({ branch: 'feat/x', ahead: 3, behind: 0, dirty: 0, isDetached: false })
})

test('with mods-hub but no git event, a finished turn does not run git', async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = world(on, { stdout: DIRTY })
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: MANIFEST }))
  await $.session.start(START)
  await clock.advance(10)
  hub.events.push({ topic: 'test.result', data: {}, at: 5, source: 'x' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(calls).toHaveLength(1)
})

test('without mods-hub nothing is shared and a finished turn changes nothing', async ($, on) => {
  const clock = mock.clock(on)
  const { calls, lines } = world(on, { stdout: DIRTY })
  await $.session.start(START)
  await clock.advance(10)
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(calls).toHaveLength(1)
  expect(lines).toEqual(['⎇ feat/x ↑2 ↓0 ●3'])
})

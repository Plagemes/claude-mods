import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'auto-checkpoint'
const PANE_PROPS = {
  title: 'Checkpoints',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** A fake repository: `worktree` is the tree `write-tree` reports; every git call is recorded. */
const fakeGit = (on: On, options: { isRepo?: boolean } = {}) => {
  const repo = { worktree: 'tree-a', refs: new Map<string, string>(), calls: [] as string[], statuses: [] as (string | undefined)[] }
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    const line = args.join(' ')
    repo.calls.push(line)
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return options.isRepo === false ? answer('', 128) : answer('/work/app\n')
    if (line.startsWith('rev-parse --git-path')) return answer('.git/claude-checkpoint.index\n')
    if (line === 'rev-parse --verify -q HEAD') return answer('head0\n')
    if (line === 'write-tree') return answer(`${repo.worktree}\n`)
    if (args[0] === 'commit-tree') return answer(`commit-${args[1]}\n`)
    if (args[0] === 'update-ref' && args[1] === '-d') {
      repo.refs.delete(args[2] as string)
      return answer('')
    }
    if (args[0] === 'update-ref') {
      repo.refs.set(args[1] as string, args[2] as string)
      return answer('')
    }
    if (line.startsWith('read-tree -m -u')) repo.worktree = args[4] as string
    return answer('')
  })
  on('ui.status', ($, e) => {
    repo.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  return repo
}

const startTurn = ($: Engine, turnId: string, text: string) => $.turn.start({ turnId, text })
const edit = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
const runCommand = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('checkpoints once, before the first edit of a turn, without touching the real index', async ($, on) => {
  const repo = fakeGit(on)
  await startTurn($, 't1', 'fix the login bug')
  await edit($)
  await edit($)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })

  expect([...repo.refs.entries()]).toEqual([['refs/claude-checkpoints/1', 'commit-tree-a']])
  expect(repo.calls.filter(call => call === 'write-tree')).toHaveLength(1)
  expect(repo.calls).toContain('read-tree --reset HEAD')
  expect(repo.calls.some(call => call.startsWith('commit-tree tree-a -p head0 -m checkpoint #1: fix the login bug'))).toBe(true)
  expect(repo.statuses.at(-1)).toBe('checkpoint #1 saved · /checkpoints')
})

test('skips read-only Bash, and an unchanged tree makes no new checkpoint', async ($, on) => {
  const repo = fakeGit(on)
  await startTurn($, 't1', 'look around')
  await $.tool.call({ tool: 'Bash', command: 'ls -la src' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(repo.calls).toHaveLength(0)

  await edit($)
  await startTurn($, 't2', 'same tree again')
  await edit($)
  expect(repo.refs.size).toBe(1)

  repo.worktree = 'tree-b'
  await startTurn($, 't3', 'now it changed')
  await $.tool.call({ tool: 'Bash', command: 'echo hi > notes.txt' })
  expect(repo.refs.get('refs/claude-checkpoints/2')).toBe('commit-tree-b')
})

test('stays silent outside a git repository', async ($, on) => {
  const repo = fakeGit(on, { isRepo: false })
  await startTurn($, 't1', 'edit something')
  const result = await edit($)
  expect(result.result).toBe('ok')
  expect(repo.calls).toEqual(['rev-parse --show-toplevel'])
  expect(repo.statuses).toHaveLength(0)
})

test('keeps only the newest checkpoints', { options: { keep: 2 } }, async ($, on) => {
  const repo = fakeGit(on)
  for (const tree of ['tree-a', 'tree-b', 'tree-c']) {
    repo.worktree = tree
    await startTurn($, tree, `turn on ${tree}`)
    await edit($)
  }
  expect([...repo.refs.keys()]).toEqual(['refs/claude-checkpoints/2', 'refs/claude-checkpoints/3'])
})

test('/checkpoints lists them and rolls back after confirmation, saving the current state first', async ($, on) => {
  const repo = fakeGit(on)
  await startTurn($, 't1', 'add the settings page')
  await edit($)
  repo.worktree = 'tree-b'
  await startTurn($, 't2', 'refactor the router')
  await edit($)
  repo.worktree = 'tree-c'
  expect((await runCommand($, 'checkpoints')).text).toBe('Checkpoints pane opened.')

  const cases = [
    { surface: 'terminal', target: 1, expected: 'read-tree -m -u tree-c tree-a', savedAs: 3 },
    { surface: 'desktop', target: 2, expected: 'read-tree -m -u tree-a tree-b', savedAs: 4 },
  ] as const
  for (const { surface, target, expected, savedAs } of cases) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'checkpoints', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'refactor the router' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button', text: 'Roll back' })).length).toBeGreaterThanOrEqual(2)

    await ui.press({ key: `rollback-${target}` })
    expect((await ui.find({ key: 'confirm' }))?.text).toBe(`Roll back to #${target}`)
    await ui.press({ key: 'confirm' })

    expect(repo.calls).toContain(expected)
    expect((await ui.find({ key: 'notice' }))?.text).toBe(`Rolled back to #${target}. The state before is saved as #${savedAs}.`)
    await ui.unmount()
  }
  expect(repo.worktree).toBe('tree-b')
})

test('/rollback checks its argument and asks for confirmation in the pane', async ($, on) => {
  fakeGit(on)
  await startTurn($, 't1', 'first')
  await edit($)
  expect((await runCommand($, 'rollback', 'seven')).text).toBe('Usage /rollback <n>. Checkpoints: #1.')
  expect((await runCommand($, 'rollback', '#1')).text).toBe('Confirm the rollback to #1 in the Checkpoints pane.')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'checkpoints', props: PANE_PROPS })
  expect(await ui.find({ key: 'confirm' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
})

test('regression: a snapshot that times out pauses checkpoints for the session instead of slowing every turn', async ($, on) => {
  const calls: string[] = []
  const statuses: (string | undefined)[] = []
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    calls.push(line)
    if (line.startsWith('add -A')) return { deny: 'aborted: still running after 20000ms' }
    const stdout = line === 'rev-parse --show-toplevel' ? '/work/app\n' : line.startsWith('rev-parse --git-path') ? '.git/claude-checkpoint.index\n' : 'head0\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))

  await startTurn($, 't1', 'first')
  expect((await edit($)).isError).not.toBe(true)
  expect(calls.filter(line => line.startsWith('add -A'))).toHaveLength(1)
  expect(statuses.at(-1)).toContain('paused')

  await startTurn($, 't2', 'second')
  await edit($)
  expect(calls.filter(line => line.startsWith('add -A'))).toHaveLength(1)
})

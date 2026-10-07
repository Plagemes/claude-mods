import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseConflicts } from '../hooks/conflicts'
import { fakeHub } from './hub'

const PLUGIN = 'conflict-helper'
const PANE_PROPS = {
  title: 'Conflicts',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const CONFLICTED = [
  'import { a } from "./a"',
  '<<<<<<< HEAD',
  'const retries = 3',
  '=======',
  'const retries = 5',
  '>>>>>>> feature/retry',
  'export const x = 1',
  '<<<<<<< HEAD',
  'log("ours")',
  '=======',
  'log("theirs")',
  '>>>>>>> feature/retry',
  '',
].join('\n')

type Repo = {
  unmerged: Set<string>
  files: Record<string, string>
  operation: string | null
  calls: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  submitted: { text: string; asUser?: boolean }[]
}

const world = (on: On, overrides: Partial<Repo> = {}): Repo => {
  const repo: Repo = {
    unmerged: new Set(),
    files: { 'src/client.ts': CONFLICTED },
    operation: null,
    calls: [],
    statuses: [],
    toasts: [],
    submitted: [],
    ...overrides,
  }
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    const line = args.join(' ')
    repo.calls.push(line)
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return answer('/work/app\n')
    if (args[0] === 'rev-parse' && args[1] === '--git-path') {
      return answer(['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(name => `.git/${name}`).join('\n'))
    }
    if (line.startsWith('diff --name-only --diff-filter=U')) return answer([...repo.unmerged].map(path => `${path}\0`).join(''))
    if (args[0] === 'checkout') {
      repo.files[args[3] as string] = args[1] === '--ours' ? 'const retries = 3\n' : 'const retries = 5\n'
      return answer('')
    }
    if (args[0] === 'add') repo.unmerged.delete(args[2] as string)
    return answer('')
  })
  on('fs.exists', ($, e) => ({ value: repo.operation !== null && e.path === `/work/app/.git/${repo.operation}` }))
  on('fs.read', ($, e) => {
    const text = repo.files[e.path.replace('/work/app/', '')]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.status', ($, e) => {
    repo.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    repo.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => {
    repo.submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('tool.call', () => ({ result: 'ok' }))
  return repo
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const openConflicts = ($: Engine) =>
  $.command.run({ command: 'conflicts', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'conflicts', props: PANE_PROPS })
const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude', promptModel: 'claude', surfaces: [], tools: [], outputStyle: null, traits: [] })

test('notices conflicts after a merge and lists their blocks in /conflicts', async ($, on) => {
  const repo = world(on, { operation: 'MERGE_HEAD' })
  repo.unmerged.add('src/client.ts')
  await bash($, 'git merge feature/retry')
  expect(repo.statuses.at(-1)).toBe('conflicts: 1 file · /conflicts')
  expect(repo.toasts.at(-1)).toBe('conflict-helper: 1 conflicted file. Run /conflicts to resolve.')

  expect((await openConflicts($)).text).toBe('conflict-helper: 1 file, 2 conflict blocks.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Merge conflicts · 1 file, 2 blocks' })).toBeDefined()
    expect((await ui.find({ key: 'row:src/client.ts' }))?.text).toContain('2 blocks')
    expect(await ui.find({ key: 'ask:src/client.ts' })).toBeDefined()
    await ui.unmount()
  }
})

test('Ask Claude submits both sides of every block with precise rules', async ($, on) => {
  const repo = world(on)
  repo.unmerged.add('src/client.ts')
  await openConflicts($)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'ask:src/client.ts' })

  const [ask] = repo.submitted
  expect(ask?.asUser).toBe(true)
  expect(ask?.text).toContain('Resolve the merge conflicts in `src/client.ts` (2 blocks).')
  expect(ask?.text).toContain('ours (HEAD):\n```\nconst retries = 3\n```')
  expect(ask?.text).toContain('theirs (feature/retry):\n```\nconst retries = 5\n```')
  expect(ask?.text).toContain('block 2 at line 8')
  expect(ask?.text).toContain('stage it with `git add <file>`')
  expect((await ui.find({ key: 'notice' }))?.text).toBe('Asked Claude to resolve src/client.ts.')
})

test('Ours and Theirs check out a side, stage it, and clear the status once all are resolved', async ($, on) => {
  const repo = world(on)
  repo.unmerged.add('src/client.ts')
  await openConflicts($)
  for (const surface of ['terminal', 'desktop'] as const) {
    repo.unmerged.add('src/client.ts')
    repo.files['src/client.ts'] = CONFLICTED
    await bash($, 'git merge feature/retry')
    const ui = await mountPane($, surface)
    await ui.press({ key: surface === 'terminal' ? 'theirs:src/client.ts' : 'ours:src/client.ts' })
    const side = surface === 'terminal' ? 'theirs' : 'ours'
    expect(repo.calls).toContain(`checkout --${side} -- src/client.ts`)
    expect(repo.calls).toContain('add -- src/client.ts')
    expect((await ui.find({ key: 'notice' }))?.text).toBe(`Took ${side} for src/client.ts and staged it.`)
    expect(await ui.find({ key: 'clean' })).toBeDefined()
    expect(repo.statuses.at(-1)).toBeUndefined()
    expect(repo.toasts.at(-1)).toBe('conflict-helper: all conflicts resolved')
    await ui.unmount()
  }
})

test('explains which side is which during a rebase', async ($, on) => {
  const repo = world(on, { operation: 'rebase-merge' })
  repo.unmerged.add('src/client.ts')
  await openConflicts($)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Rebase conflicts · 1 file, 2 blocks' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ours is the branch you are rebasing onto' })).toBeDefined()
})

test('refuses writes that leave conflict markers, but not ones that remove them', async ($, on) => {
  world(on)
  const denied = await $.tool.call({ tool: 'Write', file_path: '/work/app/a.ts', content: CONFLICTED })
  expect(denied.deny).toContain('conflict-helper: this write leaves git conflict markers')

  const sneaky = await $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'x', new_string: '<<<<<<< HEAD\ny' })
  expect(sneaky.deny).toBeDefined()

  const resolving = await $.tool.call({
    tool: 'Edit',
    file_path: '/work/app/a.ts',
    old_string: '<<<<<<< HEAD\nconst retries = 3\n=======\nconst retries = 5\n>>>>>>> feature/retry',
    new_string: 'const retries = 5',
  })
  expect(resolving.deny).toBeUndefined()
  const underline = await $.tool.call({ tool: 'Write', file_path: '/work/app/README.rst', content: 'Title\n=======\n' })
  expect(underline.deny).toBeUndefined()
})

test('the guard can be turned off', { options: { guard: false } }, async ($, on) => {
  world(on)
  expect((await $.tool.call({ tool: 'Write', file_path: '/work/app/fixture.txt', content: CONFLICTED })).deny).toBeUndefined()
})

test('reminds the model in the system prompt only while conflicts exist', async ($, on) => {
  const repo = world(on)
  expect((await compose($)).sections.map(section => section.id)).toEqual(['intro'])
  repo.unmerged.add('src/client.ts')
  await bash($, 'git pull --no-rebase')
  const sections = (await compose($)).sections
  expect(sections.map(section => section.id)).toEqual(['intro', 'conflict-helper:markers'])
  expect(sections[1]?.text).toContain('in progress in: src/client.ts')
})

test('parses conflict blocks, diff3 bases included', () => {
  const diff3 = '<<<<<<< ours\na\n||||||| base\nb\n=======\nc\n>>>>>>> theirs\n'
  expect(parseConflicts(diff3)).toEqual([{ line: 1, oursLabel: 'ours', theirsLabel: 'theirs', ours: 'a', theirs: 'c' }])
  expect(parseConflicts(CONFLICTED)).toHaveLength(2)
  expect(parseConflicts('no conflicts\n=======\n')).toEqual([])
})

test('with mods-hub: says hello, publishes x.conflict-helper.found once, and sends the notices through notify instead of toasts', async ($, on) => {
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const repo = world(on, { operation: 'MERGE_HEAD' })
  repo.unmerged.add('src/client.ts')

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['x.conflict-helper.found'], consumes: [] }])

  await bash($, 'git merge feature/retry')
  await bash($, 'git status')
  expect(hub.published).toEqual([{ topic: 'x.conflict-helper.found', data: { files: 1, hunks: 2, operation: 'merge', paths: ['src/client.ts'] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'conflict-helper: 1 conflicted file. Run /conflicts to resolve.' }])

  repo.unmerged.clear()
  await bash($, 'git add -A')
  expect(hub.notified.at(-1)).toEqual({ level: 'info', title: 'conflict-helper: all conflicts resolved' })
  expect(repo.toasts).toEqual([])
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

import { barCells, cutDiff, parseTracked } from '../hooks/parse'

const PLUGIN = 'diff-pane'
const PANE_PROPS = {
  title: 'Changes',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const AUTH_DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\nindex 1..2 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n'

type Repo = {
  tracked: string[][]
  untracked: Record<string, string>
  calls: string[]
  copies: unknown[]
  isOpen: boolean
  /** The hub's panel is open. */
  isHubPanelOpen: boolean
  clock: ReturnType<typeof mock.clock>
}

/** A repository whose changes the test sets; `tracked` rows are [status, adds, dels, path]. */
const world = (on: On, isRepo = true): Repo => {
  const repo: Repo = {
    tracked: [
      ['M', '3', '1', 'src/auth.ts'],
      ['D', '0', '12', 'src/old.ts'],
      ['A', '-', '-', 'assets/logo.png'],
    ],
    untracked: { 'notes/todo.md': 'one\ntwo\nthree\n' },
    calls: [],
    copies: [],
    isOpen: false,
    isHubPanelOpen: false,
    clock: mock.clock(on),
  }
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    repo.calls.push(line)
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'rev-parse --show-toplevel') return isRepo ? answer('/work/app\n') : answer('', 128)
    if (line === 'rev-parse --verify -q HEAD') return answer('abc\n')
    if (line.startsWith('diff HEAD --numstat')) return answer(repo.tracked.map(([, a, d, p]) => `${a}\t${d}\t${p}\0`).join(''))
    if (line.startsWith('diff HEAD --name-status')) return answer(repo.tracked.map(([s, , , p]) => `${s}\0${p}\0`).join(''))
    if (line.startsWith('ls-files --others')) return answer(Object.keys(repo.untracked).map(p => `${p}\0`).join(''))
    if (line === 'diff HEAD --no-color --no-ext-diff -- src/auth.ts') return answer(AUTH_DIFF)
    return answer('')
  })
  on('fs.stat', ($, e) => {
    const text = repo.untracked[e.path.replace('/work/app/', '')]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = repo.untracked[e.path.replace('/work/app/', '')]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.open', () => {
    repo.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [
      ...(repo.isOpen ? [{ id: 'changes', title: 'Changes', isShown: true, isFocused: false, isPlaced: true }] : []),
      ...(repo.isHubPanelOpen ? [{ id: 'claude-mods', title: 'Claude Mods', isShown: true, isFocused: false, isPlaced: true }] : []),
    ],
  }))
  on('ui.copy', ($, e) => {
    repo.copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return repo
}

const openChanges = ($: Engine) =>
  $.command.run({ command: 'changes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'changes', props: PANE_PROPS })

test('/changes lists changed and untracked files with counts, bars and totals', async ($, on) => {
  world(on)
  expect((await openChanges($)).text).toBe('Changes pane opened.')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const row = await ui.find({ key: 'row:src/auth.ts' })
    expect(row?.text).toContain('M')
    expect(row?.text).toContain('+3 −1')
    expect(row?.text).toContain('+++-')
    expect((await ui.find({ key: 'row:assets/logo.png' }))?.text).toContain('binary')
    expect((await ui.find({ key: 'row:notes/todo.md' }))?.text).toContain('+3 −0')
    const totals = (await ui.find({ key: 'totals' }))?.text
    expect(totals).toContain('4 files changed')
    expect(totals).toContain('+6 −13')
    await ui.unmount()
  }
})

test('refreshes shortly after edits while the pane is open, and only then', async ($, on) => {
  const repo = world(on)
  const { clock } = repo
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(1000)
  expect(repo.calls).toHaveLength(0)

  await openChanges($)
  const ui = await mountPane($, 'terminal')
  repo.tracked.push(['A', '20', '0', 'src/new.ts'])
  await $.tool.call({ tool: 'Write', file_path: '/work/app/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'npm run lint -- --fix' })
  const scansBefore = repo.calls.filter(call => call.startsWith('ls-files')).length
  await clock.advance(400)
  expect(repo.calls.filter(call => call.startsWith('ls-files')).length).toBe(scansBefore + 1)
  expect((await ui.find({ key: 'row:src/new.ts' }))?.text).toContain('+20 −0')
})

test('Diff shows the file as a diff from its first hunk, and Copy copies the path', async ($, on) => {
  const repo = world(on)
  await openChanges($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'diff:src/auth.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(code?.text.startsWith('@@ -1,2 +1,3 @@')).toBe(true)
    await ui.press({ key: 'diff:src/auth.ts' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.press({ key: 'copy:src/auth.ts' })
    expect(repo.copies.at(-1)).toEqual({ text: 'src/auth.ts', surface })
    await ui.unmount()
  }
})

test('says so outside a git repository', async ($, on) => {
  world(on, false)
  expect((await openChanges($)).text).toBe('diff-pane: not in a git repository.')
})

test('parses numstat, splits bars and cuts long diffs at a hunk', () => {
  const files = parseTracked('5\t2\ta.ts\0-\t-\timg.png\0', 'M\0a.ts\0A\0img.png\0')
  expect(files).toEqual([
    { path: 'a.ts', status: 'M', adds: 5, dels: 2, isBinary: false },
    { path: 'img.png', status: 'A', adds: 0, dels: 0, isBinary: true },
  ])
  expect(barCells(5, 5, 10, 10)).toEqual({ plus: 5, minus: 5 })
  expect(barCells(1, 99, 100, 10)).toEqual({ plus: 1, minus: 9 })
  expect(barCells(0, 0, 10, 10)).toEqual({ plus: 0, minus: 0 })
  const long = `@@ -1 +1 @@\n${'+x\n'.repeat(10)}@@ -20 +20 @@\n${'+y\n'.repeat(10)}`
  const cut = cutDiff(long, 45)
  expect(cut.isCut).toBe(true)
  expect(cut.text.endsWith('+x\n')).toBe(true)
})

const HUB_PANE_PROPS = { ...PANE_PROPS, title: 'Claude Mods' }
const mountHubPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'claude-mods', props: HUB_PANE_PROPS })
const TURN = { answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer' } as const

/** The engine with the hub installed: its tab strip is what the plugin's tab is drawn beneath. */
const hubbed = async ($: Engine, on: On, repo: Repo) => {
  const hub = fakeHub(on, {}, repo.clock)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['HUB STRIP'] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  return hub
}

test('with mods-hub: registers the Changes tab, scans at start, /changes opens the tab and the list is drawn under the hub strip', async ($, on) => {
  const repo = world(on)
  const hub = await hubbed($, on, repo)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['git.commit'] }])
  expect(hub.tabs).toEqual([{ id: 'changes', title: 'Changes', order: 250, command: 'changes' }])
  expect(repo.calls.some(call => call.startsWith('ls-files --others'))).toBe(true)

  expect((await openChanges($)).text).toBe('Changes tab opened.')
  expect(hub.shown).toEqual(['changes'])
  expect(repo.isOpen).toBe(false)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountHubPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
    expect((await ui.find({ key: 'row:src/auth.ts' }))?.text).toContain('+3 −1')
    expect((await ui.find({ key: 'totals' }))?.text).toContain('4 files changed')
    await ui.press({ key: 'diff:src/auth.ts' })
    expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
    await ui.press({ key: 'diff:src/auth.ts' })
    await ui.unmount()
  }
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  const repo = world(on)
  const hub = await hubbed($, on, repo)
  hub.tab = 'cost'
  const ui = await mountHubPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'HUB STRIP' })).toBeDefined()
  expect(await ui.find({ key: 'totals' })).toBeUndefined()
  await ui.unmount()
})

test('with mods-hub: edits rescan while the panel shows the Changes tab, and not while it shows another', async ($, on) => {
  const repo = world(on)
  const hub = await hubbed($, on, repo)
  repo.isHubPanelOpen = true
  const scans = () => repo.calls.filter(call => call.startsWith('ls-files')).length

  hub.tab = 'home'
  const before = scans()
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await repo.clock.advance(500)
  expect(scans()).toBe(before)

  hub.tab = 'changes'
  repo.tracked.push(['A', '20', '0', 'src/new.ts'])
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/new.ts', old_string: 'a', new_string: 'b' })
  await repo.clock.advance(500)
  expect(scans()).toBe(before + 1)
  const ui = await mountHubPane($, 'terminal')
  expect((await ui.find({ key: 'row:src/new.ts' }))?.text).toContain('+20 −0')
  await ui.unmount()
})

test('with mods-hub: a commit another mod made (git.commit on the bus) rescans at the end of the turn', async ($, on) => {
  const repo = world(on)
  const hub = await hubbed($, on, repo)
  repo.isHubPanelOpen = true
  hub.tab = 'changes'
  await repo.clock.advance(1000)
  const scans = () => repo.calls.filter(call => call.startsWith('ls-files')).length
  const before = scans()

  await $.turn.complete(TURN)
  expect(scans()).toBe(before)

  repo.tracked.length = 0
  hub.events.push({ topic: 'git.commit', data: { sha: 'abc', message: 'x', branch: 'main', files: 3 }, at: 1500, source: 'commit-composer' })
  await repo.clock.advance(1000)
  await $.turn.complete(TURN)
  expect(scans()).toBe(before + 1)
  const ui = await mountHubPane($, 'terminal')
  expect(await ui.find({ key: 'row:src/auth.ts' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub /changes opens the own pane and nothing is scanned at start', async ($, on) => {
  const repo = world(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(repo.calls).toEqual([])
  expect((await openChanges($)).text).toBe('Changes pane opened.')
  expect(repo.isOpen).toBe(true)
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RULES, dueRules, isGitCommit, isInstalled, isLongOutput, isTestPrompt, messageOf } from '../hooks/rules'
import type { Signals } from '../hooks/rules'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse('2026-10-07T09:00:00Z')

type World = {
  toasts: string[]
  usage: { percent?: number }
  commands: string[]
  plugins: string[]
  registered: string[]
  /** True when the `claude` binary cannot be started. */
  isCliMissing: boolean
  bashOutput: string
  advance: (ms: number) => Promise<void>
}

/** The engine beneath the plugin: clock and store in memory, a context gauge, installed plugins and commands, Bash output. */
const world = (on: On, stored: Record<string, unknown> = {}): World => {
  const clock = mock.clock(on, { now: START })
  mock.store(on, stored)
  const state: World = {
    toasts: [],
    usage: { percent: 10 },
    commands: [],
    plugins: [],
    registered: [],
    isCliMissing: false,
    bashOutput: 'ok',
    advance: clock.advance,
  }
  on('ui.toast', (_$, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: START, context: { window: 200_000, percent: state.usage.percent }, rateLimits: [] },
  }))
  on('command.list', () => ({ value: state.commands.map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => {
    if (state.isCliMissing) return { deny: 'failed to start: ENOENT' }
    const list = state.plugins.map(name => ({ id: `${name}@plagemes-claude-mods`, version: '1.0.0', scope: 'user', enabled: true }))
    return { value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('fail')) return { isError: true as const, result: 'boom', text: 'boom' }
    return { result: 'ok', text: e.tool === 'Bash' ? state.bashOutput : 'ok' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('classic.PermissionRequest', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_$, e) => {
    state.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return state
}

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const endTurn = ($: Engine, extra: { agentId?: string; reason?: 'answer' | 'aborted' } = {}) =>
  $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', ...extra } as never)
const coach = async ($: Engine, args = ''): Promise<string> =>
  (
    await $.command.run({
      command: 'coach',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? ''
const longOutputs = async ($: Engine, world: World, count: number) => {
  world.bashOutput = 'line\n'.repeat(200)
  for (let i = 0; i < count; i += 1) await bash($, `cat file${i}`)
}

test('registers /coach when the session starts', async ($, on) => {
  const w = world(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(w.registered).toEqual(['coach'])
})

test('suggests output-trimmer after three long outputs, with the line that installs it', async ($, on) => {
  const w = world(on)
  await longOutputs($, w, 2)
  await endTurn($)
  expect(w.toasts).toEqual([])

  await longOutputs($, w, 1)
  await endTurn($)

  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('3 commands printed very long output')
  expect(w.toasts[0]).toContain('/plugin install output-trimmer --marketplace plagemes/claude-mods')
})

test('suggests /compact when the context fills up; a built-in needs no install line', async ($, on) => {
  const w = world(on)
  w.usage.percent = 74

  await endTurn($)

  expect(w.toasts).toEqual([expect.stringContaining('The context window is 74% full. /compact')])
  expect(w.toasts[0]).not.toContain('/plugin install')
})

test('suggests /commit after three commits Claude made, ignoring failed ones', async ($, on) => {
  const w = world(on)
  await bash($, 'git commit -m "a"')
  await bash($, 'git -C sub commit -am "b"')
  await bash($, 'fail git commit -m "nope"')
  await bash($, 'git status')
  await endTurn($)
  expect(w.toasts).toEqual([])

  await bash($, 'git commit -m "c"')
  await endTurn($)

  expect(w.toasts[0]).toContain("commit-composer mod's /commit")
})

test('suggests quick-commands after three prompts that ask to run the tests, lint or build', async ($, on) => {
  const w = world(on)
  await say($, 'please run the tests')
  await say($, 'run lint again')
  await say($, 'what does this function do?')
  await endTurn($)
  expect(w.toasts).toEqual([])

  await say($, 'ok, rerun the test suite')
  await endTurn($)

  expect(w.toasts[0]).toContain('asked Claude to run the tests, linter or build 3 times')
  expect(w.toasts[0]).toContain('/t, /l and /b')
})

test('only a person counts: a plugin or notification prompt does not', async ($, on) => {
  const w = world(on)
  for (const origin of [{ kind: 'task-notification' }, { kind: 'plugin', name: 'x' }] as const) {
    for (let i = 0; i < 3; i += 1) await $.prompt.submit({ text: 'run the tests', wait: false, origin })
  }
  await endTurn($)

  expect(w.toasts).toEqual([])
})

test('long sessions, many approvals, many changed files and many failures each have a tip', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.advance(3 * HOUR)
  await endTurn($)
  expect(w.toasts[0]).toContain('This session has run for 3 h')
  expect(w.toasts[0]).toContain('resume-brief')

  w.toasts.length = 0
  await startSession($)
  await w.advance(2 * HOUR)
  for (let i = 0; i < 6; i += 1) await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await endTurn($)
  expect(w.toasts[0]).toContain('asked for approval 6 times')

  w.toasts.length = 0
  await startSession($)
  await w.advance(2 * HOUR)
  for (let i = 0; i < 10; i += 1) await $.tool.call({ tool: 'Write', file_path: `/repo/f${i}.ts`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/f0.ts', content: 'again' })
  await endTurn($)
  expect(w.toasts[0]).toContain('changed 10 files. /diff')

  w.toasts.length = 0
  await startSession($)
  await w.advance(2 * HOUR)
  for (let i = 0; i < 5; i += 1) await bash($, `fail ${i}`)
  await endTurn($)
  expect(w.toasts[0]).toContain('5 tool calls have failed')
})

test('one tip per cooldown, in priority order, and a tip is not repeated', async ($, on) => {
  const w = world(on)
  w.usage.percent = 80
  await longOutputs($, w, 3)

  await startSession($)
  await endTurn($)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('/compact')

  await endTurn($)
  await w.advance(90 * MINUTE)
  await startSession($)
  await endTurn($)
  expect(w.toasts).toHaveLength(1)

  await w.advance(40 * MINUTE)
  await startSession($)
  await endTurn($)
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toContain('output-trimmer')

  await w.advance(3 * HOUR)
  await startSession($)
  await endTurn($)
  expect(w.toasts).toHaveLength(2)
})

test('the cooldown is kept in the store, so a new session does not tip again at once', async ($, on) => {
  const w = world(on, { lastTipAt: START - 30 * MINUTE })
  w.usage.percent = 90

  await endTurn($)
  expect(w.toasts).toEqual([])

  await w.advance(2 * HOUR)
  await endTurn($)
  expect(w.toasts).toHaveLength(1)
})

test('a tip already shown within two weeks stays quiet, and comes back after that', async ($, on) => {
  const w = world(on, { shown: { compact: START - 3 * 24 * HOUR }, lastTipAt: START - 3 * 24 * HOUR })
  w.usage.percent = 90

  await endTurn($)
  expect(w.toasts).toEqual([])

  await w.advance(12 * 24 * HOUR)
  await endTurn($)
  expect(w.toasts).toHaveLength(1)
})

test('does not advertise a mod that is installed, by plugin name or by its command', async ($, on) => {
  const w = world(on)
  w.plugins = ['output-trimmer']
  w.commands = ['commit']
  await longOutputs($, w, 3)
  for (let i = 0; i < 3; i += 1) await bash($, 'git commit -m "x"')

  await endTurn($)

  expect(w.toasts).toEqual([])
  expect(await coach($)).toContain('Nothing to suggest right now')
})

test('a missing claude binary does not stop the tip', async ($, on) => {
  const w = world(on)
  w.isCliMissing = true
  await longOutputs($, w, 3)

  await endTurn($)

  expect(w.toasts[0]).toContain('output-trimmer')
})

test('subagent turns and interrupted turns do not trigger a tip', async ($, on) => {
  const w = world(on)
  w.usage.percent = 95

  await endTurn($, { agentId: 'sub-1' })
  await endTurn($, { reason: 'aborted' })

  expect(w.toasts).toEqual([])
})

test('toasts can be turned off and /coach still answers', { options: { showToasts: false } }, async ($, on) => {
  const w = world(on)
  w.usage.percent = 95

  await endTurn($)

  expect(w.toasts).toEqual([])
  expect(await coach($)).toContain('The context window is 95% full')
})

test('/coach lists everything that is due now, numbered, with what it has seen', async ($, on) => {
  const w = world(on)
  w.usage.percent = 72
  await startSession($)
  await w.advance(35 * MINUTE)
  await longOutputs($, w, 3)
  await say($, 'run the tests')

  const text = await coach($)

  expect(text.startsWith('Worth trying now:\n1. The context window is 72% full.')).toBe(true)
  expect(text).toContain('\n2. 3 commands printed very long output')
  expect(text).toContain('Seen this session: 3 long outputs · 0 commits · 1 test-run prompts · 0 approvals · 0 files changed · 0 failures · context 72% · 35 min')
})

test('/coach reset forgets what was suggested and the counts', async ($, on) => {
  const w = world(on, { shown: { compact: START }, lastTipAt: START })
  w.usage.percent = 90
  await say($, 'run the tests')

  expect(await coach($, 'reset')).toContain('Cleared')
  await endTurn($)
  expect(w.toasts).toHaveLength(1)
  expect(await coach($)).toContain('0 test-run prompts')
})

const quiet: Signals = { longOutputs: 0, commits: 0, testPrompts: 0, permissionPrompts: 0, editedFiles: 0, failures: 0, minutes: 5 }

test('the rule table: thresholds, priority and the install check', () => {
  expect(dueRules(quiet)).toEqual([])
  expect(dueRules({ ...quiet, contextPercent: 69 })).toEqual([])
  expect(dueRules({ ...quiet, contextPercent: 70, commits: 3 }).map(rule => rule.id)).toEqual(['compact', 'commit-composer'])
  expect(RULES.map(rule => rule.id)).toEqual(['compact', 'output-trimmer', 'commit-composer', 'quick-commands', 'long-session', 'permissions', 'diff', 'error-feed'])

  const rule = RULES.find(item => item.id === 'commit-composer')
  if (rule === undefined) throw new Error('missing rule')
  expect(isInstalled(rule, { plugins: new Set(), commands: new Set() })).toBe(false)
  expect(isInstalled(rule, { plugins: new Set(['commit-composer']), commands: new Set() })).toBe(true)
  expect(isInstalled(rule, { plugins: new Set(), commands: new Set(['compose-commit']) })).toBe(true)
  expect(messageOf(rule, { ...quiet, commits: 4 })).toContain('4 commits so far')
})

test('the pattern helpers', () => {
  for (const yes of ['run the tests', 'Run all tests again', 'can you re-run the unit tests?', 'execute the test suite', 'run lint', 'run the build', 'please run typecheck']) {
    expect(isTestPrompt(yes), yes).toBe(true)
  }
  for (const no of ['write a test for this', 'why do the tests fail?', 'the build is slow', 'testing 123']) expect(isTestPrompt(no), no).toBe(false)

  expect(isGitCommit('git commit -m x')).toBe(true)
  expect(isGitCommit('git -C ../repo commit --amend')).toBe(true)
  expect(isGitCommit('git commit-tree abc')).toBe(false)
  expect(isGitCommit('git status')).toBe(false)
  expect(isGitCommit('echo git commit')).toBe(true)

  expect(isLongOutput('x'.repeat(6000))).toBe(true)
  expect(isLongOutput('line\n'.repeat(120))).toBe(true)
  expect(isLongOutput('short')).toBe(false)
})

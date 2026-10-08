import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { defaultDays, fallbackSections, formatSections, neighboursOf, parseSections, unseenCommits } from '../hooks/standup'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const ROOT = '/work/shop'
const WEDNESDAY = Date.UTC(2026, 9, 7, 9)
const MONDAY = Date.UTC(2026, 9, 5, 9)
const LOG = [
  '2026-10-06\ta1b2c3d\tfeat(api): add pagination to /orders',
  '2026-10-06\tb2c3d4e\tfix: rounding of cart totals',
].join('\n')
const REPLY = 'YESTERDAY:\n- Added pagination to the orders API\n- Fixed cart total rounding\nTODAY:\n- Finish the orders page\nBLOCKERS:\n- None'
const PANE_PROPS = {
  title: 'Standup',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const run = (args = '') => ({
  command: 'standup',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = { gitCalls: string[][]; prompts: string[]; copies: string[] }
type Setup = { sessions?: unknown; now?: number; log?: string; status?: string; repo?: boolean; reply?: string | 'fails'; journal?: boolean }

const world = (on: On, setup: Setup = {}): World => {
  const state: World = { gitCalls: [], prompts: [], copies: [] }
  startClock = mock.clock(on, { now: setup.now ?? WEDNESDAY })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    state.gitCalls.push(args)
    const answer = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (setup.repo === false) return answer(128, '')
    if (args[0] === 'rev-parse') return answer(0, `${ROOT}\n`)
    if (args[0] === 'config') return answer(0, args[1] === 'user.email' ? 'dev@shop.io\n' : 'Dev\n')
    if (args[0] === 'log') return answer(0, setup.log ?? LOG)
    if (args[0] === 'status') return answer(0, setup.status ?? '## feature/orders...origin/feature/orders\n M src/orders.ts\n?? notes.txt\n')
    return answer(1, '')
  })
  on('fs.list', ($, e) =>
    setup.journal === true && e.path === `${ROOT}/.claude/journal`
      ? { value: ['2026-10-06.md', '2026-09-01.md'].map(name => ({ name, kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false })) }
      : { deny: 'ENOENT' },
  )
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'me' }))
  on('fs.read', ($, e) =>
    e.path.endsWith('/hub/sessions.json') ? (setup.sessions === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify(setup.sessions) }) : e.path.endsWith('2026-10-06.md') ? { value: 'Paired with Sam on the checkout bug.' } : { value: 'old notes' },
  )
  on('model.complete', ($, e) => {
    state.prompts.push(e.prompt)
    if (setup.reply === 'fails') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: NO_USAGE } }
    return { value: { isAnswered: true, text: setup.reply ?? REPLY, usage: NO_USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  return state
}

test('standup text: sections parse, fall back, and format for each paste target', async () => {
  const sections = parseSections('**Yesterday:**\n* Shipped X\n\nToday\n1. Y\nBlockers:\n- None')
  expect(sections).toEqual({ yesterday: ['Shipped X'], today: ['Y'], blockers: ['None'] })
  expect(parseSections('I could not do that.')).toBeUndefined()
  expect(formatSections({ yesterday: ['A'], today: ['B'], blockers: [] }, 'plain')).toBe('Yesterday:\n- A\n\nToday:\n- B\n\nBlockers:\n- None')
  expect(formatSections({ yesterday: ['A'], today: ['B'], blockers: ['C'] }, 'slack')).toBe('*Yesterday*\n• A\n\n*Today*\n• B\n\n*Blockers*\n• C')
  const fallback = fallbackSections([{ date: '', hash: '', subject: 'feat(api): add pagination' }], 'main', 2)
  expect(fallback).toEqual({ yesterday: ['Add pagination'], today: ['Continue on main (2 files in progress)'], blockers: ['None'] })
  expect(defaultDays(MONDAY)).toBe(3)
  expect(defaultDays(WEDNESDAY)).toBe(1)
})

test('/standup reads your commits and journal, asks the model and shows a copyable standup', async ($, on) => {
  const state = world(on, { journal: true })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('2 commits + journal since Tue 6 Oct · written by haiku')

  const log = state.gitCalls.find(args => args[0] === 'log') ?? []
  expect(log).toContain('--since=1 days ago midnight')
  expect(log).toContain('--author=dev@shop.io')
  expect(state.prompts[0]).toContain('2026-10-06  feat(api): add pagination to /orders')
  expect(state.prompts[0]).toContain('Paired with Sam on the checkout bug.')
  expect(state.prompts[0]).not.toContain('old notes')
  expect(state.prompts[0]).toContain('Branch: feature/orders · 2 files with uncommitted changes')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'standup', surface, component: 'Pane', requestId: 'standup', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Yesterday:' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '- Added pagination to the orders API' })).toBeDefined()
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copies[0]).toBe('Yesterday:\n- Added pagination to the orders API\n- Fixed cart total rounding\n\nToday:\n- Finish the orders page\n\nBlockers:\n- None')
})

test('on a Monday it looks back to Friday; a days argument wins and is validated', async ($, on) => {
  const state = world(on, { now: MONDAY })
  await $.command.run(run())
  expect(state.gitCalls.find(args => args[0] === 'log')).toContain('--since=3 days ago midnight')
  await $.command.run(run('7'))
  expect(state.gitCalls.filter(args => args[0] === 'log').at(-1)).toContain('--since=7 days ago midnight')
  const bad = await $.command.run(run('soon'))
  expect(bad.text).toContain('Days must be a whole number')
})

test('no commits, journal or open changes: no model call, a clear message', async ($, on) => {
  const quiet = world(on, { log: '', status: '## main\n', reply: 'fails' })
  const empty = await $.command.run(run())
  expect(empty.text).toContain('Nothing to report')
  expect(quiet.prompts).toHaveLength(0)
})

test('a model failure still gives a standup listed from git', async ($, on) => {
  const state = world(on, { reply: 'fails' })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('listed from git (the model answered api-error)')
  const ui = await $.ui.mount({ plugin: 'standup', surface: 'terminal', component: 'Pane', requestId: 'standup', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: '- Add pagination to /orders' })).toBeDefined()
  await ui.press({ key: 'regenerate' })
  expect(state.prompts).toHaveLength(2)
})

test('outside a git repository it says so', async ($, on) => {
  world(on, { repo: false })
  const ran = await $.command.run(run())
  expect(ran.text).toBe('Not inside a git repository.')
})

const SESSIONS = {
  me: { id: 'me', cwd: ROOT, turns: 4, usd: 1, events: [{ topic: 'git.commit', at: WEDNESDAY - 3_600_000, data: { sha: 'a1b2c3d4e5', message: 'feat(api): add pagination to /orders', branch: 'x', files: 2 } }] },
  other: {
    id: 'other',
    cwd: `${ROOT}/packages/web`,
    turns: 27,
    usd: 3.2,
    events: [
      { topic: 'git.commit', at: WEDNESDAY - 7_200_000, data: { sha: 'f9e8d7c6b5', message: 'fix(web): focus ring on the cart button\n\nlong body', branch: 'fix/focus', files: 1 } },
      { topic: 'git.commit', at: WEDNESDAY - 90 * 86_400_000, data: { sha: '0000000aaa', message: 'ancient', branch: 'x', files: 1 } },
      { topic: 'test.result', at: WEDNESDAY - 1000, data: {} },
    ],
  },
  elsewhere: { id: 'elsewhere', cwd: '/work/blog', turns: 9, usd: 9, events: [] },
}

test('with mods-hub: says hello, adds commits other sessions made on other branches, and tells the model about the other sessions', async ($, on) => {
  const state = world(on, { sessions: SESSIONS })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['git.commit', 'session.ended'] }])

  await $.command.run(run())
  const prompt = state.prompts[0] ?? ''
  expect(prompt).toContain('Commits (newest first):\n2026-10-07  fix(web): focus ring on the cart button\n2026-10-06  feat(api): add pagination to /orders')
  expect(prompt).not.toContain('ancient')
  expect(prompt.match(/pagination/g)).toHaveLength(1)
  expect(prompt).toContain('Other Claude sessions on this project right now: 1 (27 turns, $3.20 so far).')
})

test('without mods-hub the standup is built from git and the journal alone', async ($, on) => {
  const state = world(on, { sessions: SESSIONS })
  await $.command.run(run())
  expect(state.prompts[0]).not.toContain('Other Claude sessions')
  expect(state.prompts[0]).not.toContain('f9e8d7c')
})

test('neighboursOf and unseenCommits read the hub heartbeat defensively', () => {
  const day = (ms: number) => `d${ms}`
  expect(neighboursOf('nope', ROOT, 'me', 0, day)).toEqual({ commits: [], sessions: 0, turns: 0, usd: 0 })
  expect(neighboursOf({ a: { cwd: 5 }, b: null, c: { cwd: `${ROOT}-other`, turns: 1 } }, ROOT, 'me', 0, day).sessions).toBe(0)
  const found = neighboursOf(SESSIONS, ROOT, 'me', WEDNESDAY - 86_400_000, day)
  expect(found).toMatchObject({ sessions: 1, turns: 27, usd: 3.2 })
  expect(found.commits.map(commit => commit.hash)).toEqual(['a1b2c3d', 'f9e8d7c'])
  expect(unseenCommits([{ date: '', hash: 'a1b2c3d', subject: 'x' }], found.commits).map(commit => commit.hash)).toEqual(['f9e8d7c'])
})

import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { defaultDays, fallbackSections, formatSections, parseSections } from '../hooks/standup'

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
type Setup = { now?: number; log?: string; status?: string; repo?: boolean; reply?: string | 'fails'; journal?: boolean }

const world = (on: On, setup: Setup = {}): World => {
  const state: World = { gitCalls: [], prompts: [], copies: [] }
  mock.clock(on, { now: setup.now ?? WEDNESDAY })
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
  on('fs.read', ($, e) => (e.path.endsWith('2026-10-06.md') ? { value: 'Paired with Sam on the checkout bug.' } : { value: 'old notes' }))
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
  expect(bad.text).toContain('days must be a whole number')
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
  expect(ran.text).toBe('standup: not inside a git repository.')
})

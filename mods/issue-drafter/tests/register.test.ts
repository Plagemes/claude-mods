import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { issueUrl, parseArgs, parseDraft } from '../hooks/draft'

const ROOT = '/work/shop'
const FORK_REPLY = [
  'TYPE: bug',
  'TITLE: Checkout total rounds half-cents down',
  'BODY:',
  '## Summary',
  'Totals with half cents are rounded down in `src/cart/total.ts`.',
  '## Steps to reproduce',
  '1. Add two items at $0.005',
  '## Expected',
  'Total is $0.01.',
  '## Actual',
  'Total is $0.00.',
  '## Context',
  'Node 22, `npm test -- total` fails.',
].join('\n')
const PANE_PROPS = {
  title: 'Issue draft',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const issue = (args = '') => ({
  command: 'issue',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

type World = { forks: string[]; writes: Map<string, string>; runs: string[][]; closed: number }
type Setup = { fork?: 'nothing' | string; gh?: 'missing' | { exitCode: number; stdout: string; stderr: string } }

const world = (on: On, setup: Setup = {}): World => {
  const state: World = { forks: [], writes: new Map(), runs: [], closed: 0 }
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { TMPDIR: '/var/tmp/' })
  on('model.fork', ($, e) => {
    state.forks.push(e.prompt)
    return setup.fork === 'nothing'
      ? { value: { isAnswered: false, reason: 'nothing-to-fork' } }
      : { value: { isAnswered: true, text: setup.fork ?? FORK_REPLY, usage: NO_USAGE } }
  })
  on('session.root', () => ({ value: ROOT }))
  on('fs.write', ($, e) => {
    state.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    state.runs.push([...e.argv])
    if (setup.gh === 'missing') return { deny: 'spawn gh ENOENT' }
    const gh = setup.gh ?? { exitCode: 0, stdout: 'Creating issue in acme/shop\n\nhttps://github.com/acme/shop/issues/42\n', stderr: '' }
    return { value: { ...gh, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => {
    state.closed += 1
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  return state
}

test('arguments and the fork answer are read leniently', async () => {
  expect(parseArgs('bug the login loop')).toEqual({ kind: 'bug', focus: 'the login loop' })
  expect(parseArgs('enhancement')).toEqual({ kind: 'feature', focus: '' })
  expect(parseArgs('dark mode')).toEqual({ focus: 'dark mode' })

  expect(parseDraft(FORK_REPLY, undefined)).toMatchObject({ kind: 'bug', title: 'Checkout total rounds half-cents down' })
  const loose = parseDraft('Sure! Here it is.\n**TITLE:** Add dark mode\n\n## Summary\nUsers want it.\n## Proposal\nA toggle.', undefined)
  expect(loose).toEqual({ kind: 'feature', title: 'Add dark mode', body: '## Summary\nUsers want it.\n## Proposal\nA toggle.' })
  expect(parseDraft('', 'bug')).toBeUndefined()
  expect(issueUrl('Creating issue\nhttps://github.com/a/b/issues/7\n')).toBe('https://github.com/a/b/issues/7')
})

test('/issue bug drafts from the conversation and creates it with gh on every surface', async ($, on) => {
  const state = world(on)
  const ran = await $.command.run(issue('bug the rounding'))
  expect(ran.text).toContain('Drafted bug issue "Checkout total rounds half-cents down"')
  expect(state.forks[0]).toContain('as a bug report')
  expect(state.forks[0]).toContain('Focus on: the rounding')
  expect(state.forks[0]).toContain('## Steps to reproduce')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'issue-drafter', surface, component: 'Pane', requestId: 'issue', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Checkout total rounds half-cents down' })).toBeDefined()
    expect((await ui.find({ key: 'body' }))?.text).toContain('## Steps to reproduce')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'issue-drafter', surface: 'desktop', component: 'Pane', requestId: 'issue', props: PANE_PROPS })
  await ui.input({ key: 'title', text: 'Half-cent totals round down at checkout' })
  await ui.press({ key: 'create' })
  const bodyFile = '/var/tmp/claude-issue-1700000000000.md'
  expect(state.writes.get(bodyFile)).toContain('Total is $0.00.')
  expect(state.runs[0]).toEqual(['gh', 'issue', 'create', '--title', 'Half-cent totals round down at checkout', '--body-file', bodyFile])
  expect(await ui.find({ type: 'Link', text: 'https://github.com/acme/shop/issues/42' })).toBeDefined()
  expect(await ui.find({ key: 'create' })).toBeUndefined()
})

test('labels from the settings ride along', { options: { labels: 'triage, from-claude', typeLabels: true } }, async ($, on) => {
  const state = world(on)
  await $.command.run(issue())
  const ui = await $.ui.mount({ plugin: 'issue-drafter', surface: 'terminal', component: 'Pane', requestId: 'issue', props: PANE_PROPS })
  await ui.press({ key: 'create' })
  expect(state.runs[0]?.slice(-6)).toEqual(['--label', 'triage', '--label', 'from-claude', '--label', 'bug'])
})

test('nothing to fork closes the pane and says why', async ($, on) => {
  const state = world(on, { fork: 'nothing' })
  const ran = await $.command.run(issue('feature'))
  expect(ran.text).toBe('Nothing to draft yet: describe the problem or idea to Claude first.')
  expect(state.closed).toBe(1)
})

test('gh errors are shown in the pane and the draft stays', async ($, on) => {
  const state = world(on, { gh: { exitCode: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' } })
  await $.command.run(issue())
  const ui = await $.ui.mount({ plugin: 'issue-drafter', surface: 'terminal', component: 'Pane', requestId: 'issue', props: PANE_PROPS })
  await ui.press({ key: 'create' })
  expect(await ui.find({ type: 'Text', text: /gh failed: To get started with GitHub CLI/ })).toBeDefined()
  expect(await ui.find({ key: 'create' })).toBeDefined()
  expect(state.runs).toHaveLength(1)
})

test('a missing gh says how to get it', async ($, on) => {
  world(on, { gh: 'missing' })
  await $.command.run(issue())
  const ui = await $.ui.mount({ plugin: 'issue-drafter', surface: 'terminal', component: 'Pane', requestId: 'issue', props: PANE_PROPS })
  await ui.press({ key: 'create' })
  expect(await ui.find({ type: 'Text', text: /not installed or not on PATH/ })).toBeDefined()
})

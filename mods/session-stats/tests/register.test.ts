import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compact, formatDuration, topTools } from '../hooks/format'
import { EMPTY_HUB, describeRun, foldEvents, toolsPerTurn } from '../hooks/hubstats'
import { fakeHub } from './hub'

const PANE = {
  plugin: 'session-stats',
  component: 'Pane',
  requestId: 'session-stats',
  props: { title: 'Session stats', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const RUN = { command: 'session-stats', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

/** The engine beneath the plugin: a session that began at 0 and has cost $1.84. */
const engine = (on: On, options: { hasLedger?: boolean; renderBottom?: unknown } = {}) => {
  const clock = mock.clock(on, { now: 0 })
  const opened: string[] = []
  const registered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], ...(options.hasLedger === false ? {} : { cost: { usd: 1.84 } }) } }))
  on('command.register', ($, e) => {
    if (e.name === 'stats') return { deny: '"/stats" refused: it is the built-in /usage' }
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', () => (options.renderBottom ?? { type: 'Box' }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Write' && e.file_path.endsWith('locked.ts')) return { deny: 'Permission denied.' }
    if (e.tool === 'Bash' && e.command === 'false') return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
    return { result: 'ok' }
  })
  return { clock, opened, registered }
}

const work = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const text of ['fix the bug', 'and add a test']) await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  for (const command of ['ls', 'npm test', 'false']) await $.tool.call({ tool: 'Bash', command })
  for (const file_path of ['/repo/src/a.ts', '/repo/src/b.ts']) await $.tool.call({ tool: 'Read', file_path })
  for (let round = 0; round < 2; round += 1) await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.ts', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/locked.ts', content: '' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO' })
  await $.turn.complete({
    answer: '',
    durationMs: 3_000,
    isAborted: false,
    turnId: 'sub',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { input_tokens: 300, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku' },
  })
  await clock.set(330_000)
  await $.turn.complete({
    answer: 'Done.',
    durationMs: 90_000,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
    usage: { input_tokens: 1_200, output_tokens: 3_400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 8_000, model: 'claude-opus' },
  })
}

test('adds up turns, tools, tokens, cost, time and files into tiles, on terminal and desktop', async ($, on) => {
  const { clock, opened, registered } = engine(on)
  await work($, clock)
  await $.command.run(RUN)
  expect(registered).toEqual(['session-stats'])
  expect(opened).toEqual(['session-stats'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const values = (await ui.findAll({ type: 'Text' })).filter(found => found.props.bold === true).map(found => found.text)
    expect(values).toEqual(['1', '9', '64k', '$1.84', '5m 30s', '2', 'Top tools'])
    expect(await ui.find({ type: 'Text', text: '2 prompts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'in 1.5k · out 4.0k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cache 50k read · 8.0k new' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1m 30s in turns' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'last b.ts' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws the top five tools as bars, longest first', async ($, on) => {
  const { clock } = engine(on)
  await work($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const names = (await ui.findAll({ type: 'Text', text: /^(Bash|Edit|Read|Grep|Write) +$/ })).map(found => found.text.trim())
  const bars = (await ui.findAll({ type: 'Text', text: /^█+$/ })).map(found => found.text.length)
  expect(names).toEqual(['Bash', 'Edit', 'Read', 'Grep', 'Write'])
  expect(bars[0]).toBe(70)
  expect(bars).toEqual([...bars].sort((a, b) => b - a))
  await ui.unmount()
})

test('starts over after /clear', async ($, on) => {
  const { clock } = engine(on)
  await work($, clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'No tool calls yet.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '0 prompts' })).toBeDefined()
  await ui.unmount()
})

test('formats counts, durations and the tool ranking', () => {
  expect(compact(950)).toBe('950')
  expect(compact(12_345)).toBe('12k')
  expect(compact(4_100_000)).toBe('4.1M')
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(245_000)).toBe('4m 05s')
  expect(formatDuration(4_320_000)).toBe('1h 12m')
  expect(topTools({ Read: 2, Bash: 2, Edit: 5 }, 2)).toEqual([['Edit', 5], ['Bash', 2]])
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const

const bus = (hub: ReturnType<typeof fakeHub>, at: number) => {
  hub.events.push(
    { topic: 'test.result', data: { runner: 'vitest', outcome: 'failed', passed: 118, failed: 2 }, at, source: 'mods-hub' },
    { topic: 'test.result', data: { runner: 'vitest', outcome: 'passed', passed: 120, failed: 0 }, at: at + 1, source: 'mods-hub' },
    { topic: 'turn.finished', data: { durationMs: 90_000, tools: 9, isAborted: false }, at: at + 2, source: 'mods-hub' },
    { topic: 'cost.update', data: { turnUsd: 0.42, sessionUsd: 1.9, model: 'claude-opus-5-5', tokens: 1, isEstimate: false }, at: at + 3, source: 'mods-hub' },
  )
}

test('with mods-hub: the Stats tab opens with /session-stats and draws the tiles plus Tests, tools per turn and the last turn\'s cost', async ($, on) => {
  const { clock, opened } = engine(on)
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  await work($, clock)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['cost.update', 'test.result', 'turn.finished'] }])
  expect(hub.tabs).toEqual([{ id: 'stats', title: 'Stats', order: 290, command: 'session-stats' }])

  bus(hub, 330_100)
  await clock.advance(300)
  await $.command.run(RUN)
  expect(hub.shown).toEqual(['stats'])
  expect(opened).toEqual([])
  hub.tab = 'stats'

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    const values = (await ui.findAll({ type: 'Text' })).filter(found => found.props.bold === true).map(found => found.text)
    expect(values).toEqual(['1', '9', '64k', '$1.84', '5m 30s', '2', '2 runs', 'Top tools'])
    expect(await ui.find({ type: 'Text', text: '9.0 tools per turn' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'last turn $0.42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'last passed · 120 passed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 not passing' })).toBeDefined()
    await ui.unmount()
  }
})

test('with mods-hub, the hub\'s priced cost fills the Cost tile where the engine keeps no ledger, and /clear starts the totals over', async ($, on) => {
  const { clock } = engine(on, { hasLedger: false })
  const hub = fakeHub(on, {}, clock)
  hub.events.push({ topic: 'cost.update', data: { turnUsd: 0.1, sessionUsd: 1.9, model: 'm', tokens: 1, isEstimate: true }, at: 5, source: 'mods-hub' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  await $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId: 'main', reason: 'answer' })
  await clock.advance(300)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '~$1.90' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'as the hub prices it' })).toBeDefined()
  await ui.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '~$1.90' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
  await ui.unmount()
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  hub.tab = 'cost'
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Top tools' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub there is no Tests tile and nothing is read from a bus', async ($, on) => {
  const { clock } = engine(on)
  await work($, clock)
  await clock.advance(300)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /tools per turn/ })).toBeUndefined()
  await ui.unmount()
})

test('foldEvents counts what the hub\'s events carry and ignores the rest', () => {
  const total = foldEvents(EMPTY_HUB, [
    { topic: 'test.result', data: { runner: 'pytest', outcome: 'error', passed: null, failed: null } },
    { topic: 'test.result', data: 'broken' },
    { topic: 'turn.finished', data: { durationMs: 1, tools: 4, isAborted: false } },
    { topic: 'turn.finished', data: { durationMs: 1, tools: 1, isAborted: false } },
    { topic: 'git.commit', data: {} },
  ])
  expect(total).toMatchObject({ runs: 1, failedRuns: 1, turns: 2, tools: 5, sessionUsd: null })
  expect(describeRun(total.lastRun as never)).toBe('error')
  expect(toolsPerTurn(total)).toBe('2.5 tools per turn')
  expect(toolsPerTurn(EMPTY_HUB)).toBeUndefined()
})

test('regression: session.start waits on nothing slow; the hub hello and the first figures follow once it returned', async ($, on) => {
  const { clock, registered } = engine(on)
  const hub = fakeHub(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['session-stats'])
  expect(hub.hellos).toEqual([])
  expect(hub.tabs).toEqual([])
  await clock.advance(1_500)
  expect(hub.hellos).toHaveLength(1)
  expect(hub.tabs.map(tab => tab.id)).toEqual(['stats'])
})

/** Every node of a drawn tree whose type is the engine's own drawing. */
const engineNodes = (tree: unknown): number => {
  if (tree === null || typeof tree !== 'object') return 0
  if (Array.isArray(tree)) return tree.reduce((sum: number, child) => sum + engineNodes(child), 0)
  const node = tree as { type?: unknown; children?: unknown }
  return (node.type === 'engine' ? 1 : 0) + engineNodes(node.children)
}

test('regression: the Stats tab beneath the hub keeps the engine\'s own drawing out of its tree (the desktop drew "has not drawn in this pane")', async ($, on) => {
  // At the bottom of a real chain next(e) is the engine's node; the hub nests the tab in sized Boxes, where the engine
  // refuses a tree holding one, and on the desktop the node itself draws as the placeholder.
  const { clock } = engine(on, { renderBottom: { type: 'engine', ref: 0 } })
  const hub = fakeHub(on, {}, clock)
  await work($, clock)
  hub.tab = 'stats'
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Top tools' })).toBeDefined()
    expect(engineNodes(await ui.drawn())).toBe(0)
    await ui.unmount()
  }
})

test('a drawing that throws shows a card with Retry in the pane, not the engine\'s blank pane', async ($, on) => {
  engine(on)
  // A stats value of the wrong shape (as a damaged or older state could hold): the drawing throws reading it.
  let isBroken = true
  on('state.get', { plugin: 'session-stats', key: 'stats' }, () => ({ value: { value: isBroken ? null : undefined, version: isBroken ? 1 : 2 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'session-stats could not draw this view' })).toBeDefined()
  expect((await ui.find({ key: 'pane-retry' }))?.props).toMatchObject({ label: 'Retry' })
  isBroken = false
  await ui.press({ key: 'pane-retry' })
  expect(await ui.find({ key: 'pane-failure' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Top tools' })).toBeDefined()
  await ui.unmount()
})

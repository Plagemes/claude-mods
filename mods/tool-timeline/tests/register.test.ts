import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describeTurn, durationBar, formatDuration, formatOffset, toolLabel, turnEnds, turnMarksOf } from '../hooks/format'
import { fakeHub } from './hub'

const PANE = {
  plugin: 'tool-timeline',
  component: 'Pane',
  requestId: 'timeline',
  props: { title: 'Timeline', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/**
 * The engine beneath the plugin. Its clock moves only when a tool runs: each
 * call takes `took(e)` milliseconds, and answers as `answer(e)` says.
 */
const engine = (on: On, took: (command: string) => number = () => 10) => {
  const clock = { now: 1_000_000 }
  const opened: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: clock.now }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  on('ui.render', () => ({ type: 'Box' }))
  on('tool.call', ($, e) => {
    const key = e.tool === 'Bash' ? e.command : e.tool
    clock.now += took(key)
    if (e.tool === 'Write') return { deny: 'Permission to write was refused.' }
    if (key === 'npm test') return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
    return { result: 'ok' }
  })
  return { clock, opened }
}

test('records each call with its outcome, duration and a short summary, drawn on terminal and desktop', async ($, on) => {
  engine(on, key => (key.startsWith('npm test') ? 1500 : 20))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'npm test\n# then lint' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.ts', content: '' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '4 calls' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗' })).toMatchObject({ props: { color: 'error' } })
    expect(await ui.find({ type: 'Text', text: '⊘' })).toMatchObject({ props: { color: 'inactive' } })
    expect(await ui.findAll({ type: 'Text', text: /^ +1\.5s$/ })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /^ +20ms$/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^npm test$/ })).map(found => found.text)).toEqual(['npm test', 'npm test'])
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^\+00:0\d$/ })).map(found => found.text)).toEqual(['+00:00', '+00:01', '+00:01', '+00:01'])
    await ui.unmount()
  }
})

test('filters to failed calls and clears the timeline from the pane', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: '/repo/src' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'TODO in src' })).toBeDefined()

  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: 'TODO in src' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
  expect((await ui.find({ key: 'filter' }))?.props.label).toBe('Show all')

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: 'No failed calls.' })).toBeDefined()
  await ui.unmount()
})

test('/timeline opens the pane, which keeps the newest 300 calls', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'timeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened).toEqual(['timeline'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (let index = 0; index < 305; index += 1) await $.tool.call({ tool: 'Bash', command: `echo ${index}` })

  expect(await ui.find({ type: 'Text', text: '300 calls' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^echo 4$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^echo 5$/ })).toBeDefined()
  expect(await ui.find({ key: 'latest' })).toBeDefined()
  await ui.unmount()
})

test('formats durations, offsets, bars and tool names', () => {
  expect(formatDuration(850)).toBe('850ms')
  expect(formatDuration(1240)).toBe('1.2s')
  expect(formatDuration(125_000)).toBe('2m05s')
  expect(formatOffset(3_723_000)).toBe('+1:02:03')
  expect(durationBar(5, 1000, 12)).toBe('')
  expect(durationBar(1000, 1000, 12)).toBe('█'.repeat(12))
  expect(durationBar(100, 1000, 12).length).toBeLessThan(12)
  expect(toolLabel('mcp__github__get_file_contents')).toBe('github:get_file_contents')
  expect(toolLabel('Bash')).toBe('Bash')
})

const HUB_PANE = { ...PANE, requestId: 'claude-mods', props: { ...PANE.props, title: 'Claude Mods' } } as const
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const turnEvent = (at: number, tools: number, durationMs: number, isAborted = false) => ({ id: `t${at}`, topic: 'turn.finished', data: { durationMs, tools, isAborted }, source: 'mods-hub', at, session: 's', scope: 'session' as const })

test('with mods-hub: the Timeline tab opens with /timeline and marks where each turn ended', async ($, on) => {
  const { clock, opened } = engine(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  let feed: unknown[] = []
  on('state.get', { plugin: 'mods-hub', key: 'feed' }, () => ({ value: { value: feed, version: 1 } }))
  await $.session.start(START)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['turn.finished'] }])
  expect(hub.tabs).toEqual([{ id: 'timeline', title: 'Timeline', order: 270, command: 'timeline' }])

  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const firstTurnEnd = clock.now
  clock.now += 5_000
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' })
  feed = [turnEvent(firstTurnEnd + 1, 2, 4_000), turnEvent(clock.now + 1, 1, 65_000, true)]

  await $.command.run({ command: 'timeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(hub.shown).toEqual(['timeline'])
  expect(opened).toEqual([])
  hub.tab = 'timeline'

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HUB_PANE, surface })
    expect(await ui.find({ type: 'Text', text: '3 calls' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^─── turn/ })).map(found => found.text)).toEqual(['─── turn · 2 tools · 4.0s', '─── turn · 1 tool · 1m05s · interrupted'])
    await ui.press({ key: 'filter' })
    expect(await ui.find({ type: 'Text', text: /^─── turn/ })).toBeUndefined()
    await ui.press({ key: 'filter' })
    await ui.unmount()
  }
})

test('with mods-hub: another tab of the panel is left to its owner', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  hub.tab = 'cost'
  const ui = await $.ui.mount({ ...HUB_PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  await ui.unmount()
})

test('without mods-hub no turn marks are drawn in the own pane, and /timeline opens it', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  await $.command.run({ command: 'timeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened).toEqual(['timeline'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^─── turn/ })).toBeUndefined()
  await ui.unmount()
})

test('turnMarksOf and turnEnds: a mark goes under the last call before the turn ended; a turn with no calls leaves none', () => {
  const call = (id: string, startedAt: number) => ({ id, tool: 'Bash', summary: '', startedAt, endedAt: startedAt + 1, outcome: 'ok' as const })
  const calls = [call('a', 10), call('b', 20), call('c', 40)]
  const marks = turnMarksOf([
    { topic: 'cost.update', at: 1, data: {} },
    { topic: 'turn.finished', at: 25, data: { durationMs: 1000, tools: 2, isAborted: false } },
    { topic: 'turn.finished', at: 26, data: { durationMs: 10, tools: 0, isAborted: false } },
    { topic: 'turn.finished', at: 50, data: { durationMs: 3000, tools: 1, isAborted: true } },
    { topic: 'turn.finished', at: 60, data: 'broken' },
  ])
  expect(marks).toHaveLength(3)
  expect([...turnEnds(calls, marks)].map(([id, mark]) => [id, mark.tools])).toEqual([['b', 2], ['c', 1]])
  expect(describeTurn(marks[2] as never)).toBe('turn · 1 tool · 3.0s · interrupted')
})

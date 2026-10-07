import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compact, formatDuration, topTools } from '../hooks/format'

const PANE = {
  plugin: 'session-stats',
  component: 'Pane',
  requestId: 'session-stats',
  props: { title: 'Session stats', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const RUN = { command: 'session-stats', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

/** The engine beneath the plugin: a session that began at 0 and has cost $1.84. */
const engine = (on: On) => {
  const clock = mock.clock(on, { now: 0 })
  const opened: string[] = []
  const registered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 1.84 } } }))
  on('command.register', ($, e) => {
    if (e.name === 'stats') return { deny: '"/stats" refused: it is the built-in /usage' }
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', () => ({ type: 'Box' }))
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

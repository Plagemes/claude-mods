import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { durationBar, formatDuration, formatOffset, toolLabel } from '../hooks/format'

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

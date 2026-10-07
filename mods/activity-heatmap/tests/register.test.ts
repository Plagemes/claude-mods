import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'activity-heatmap'
const PANE = 'activity-heatmap'
const SURFACES = ['terminal', 'desktop'] as const
/** Tuesday 14 October 2025, mid-afternoon in any time zone's reading of its own clock. */
const NOW = new Date(2025, 9, 14, 15, 20).getTime()

const paneProps = {
  title: 'Activity',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** A store in memory the test can read back, answering the plugin's `$.store`. */
const memoryStore = (on: On, entries: Record<string, unknown> = {}) => {
  const kept = new Map<string, unknown>(Object.entries(entries))
  on('store.get', ($, e) => ({ value: kept.get(e.key) }))
  on('store.set', ($, e) => {
    kept.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })
  return kept
}

const prompt = (text: string, kind: 'composer' | 'task-notification') =>
  ({ text, origin: { kind }, wait: false }) as const

test('counts the prompts a person sends by weekday and hour, in the store', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = memoryStore(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit(prompt('fix the tests', 'composer'))
  await $.prompt.submit(prompt('now the docs', 'composer'))
  await $.prompt.submit(prompt('background task finished', 'task-notification'))

  const stored = store.get('activity') as { counts: number[]; since: number }
  const slot = new Date(NOW).getDay() * 24 + new Date(NOW).getHours()
  expect(stored.counts).toHaveLength(168)
  expect(stored.counts[slot]).toBe(2)
  expect(stored.counts.reduce((a, b) => a + b, 0)).toBe(2)
  expect(stored.since).toBe(NOW)
})

test('draws a 7x24 Raster on the terminal and a text grid elsewhere, with legend and totals', async ($, on) => {
  const counts = new Array<number>(168).fill(0)
  counts[2 * 24 + 15] = 12 // Tuesday 15:00
  counts[1 * 24 + 9] = 3 // Monday 09:00
  mock.store(on, { activity: { counts, since: NOW } })
  on('command.register', () => ({ value: { command: 'heatmap' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'heatmap',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('15 prompts, busiest at Tue 15:00')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps })
    const grid = await ui.find({ key: 'grid' })
    if (surface === 'terminal') {
      expect(grid?.type).toBe('Raster')
      expect(grid?.props.rows).toBe(7)
      expect(grid?.props.columns).toBe(72)
    } else {
      expect(grid?.type).toBe('Box')
      expect(grid?.text).toContain('█')
    }
    const text = (await ui.find({ type: 'Box' }))?.text
    expect(text).toContain('15 prompts since')
    expect(text).toContain('Busiest day   Tuesday (12)')
    expect(text).toContain('less')
    expect(text).toContain('more')
    await ui.unmount()
  }
})

test('reset asks first and erases the history only when confirmed', async ($, on) => {
  const counts = new Array<number>(168).fill(1)
  const store = memoryStore(on, { activity: { counts, since: NOW } })
  let answer = 'Cancel'
  on('tool.call', ($, e) =>
    e.tool === 'AskUserQuestion'
      ? { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, answer])) } }
      : { result: 'ok' },
  )
  const reset = () =>
    $.command.run({
      command: 'heatmap',
      args: 'reset',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })

  expect((await reset()).text).toContain('Nothing was erased')
  expect(store.has('activity')).toBe(true)
  answer = 'Reset'
  expect((await reset()).text).toContain('History erased')
  expect(store.has('activity')).toBe(false)
})

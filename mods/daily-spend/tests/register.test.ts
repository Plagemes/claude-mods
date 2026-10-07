import { test, expect, mock } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

/** Wednesday 7 October 2026, local noon: the week began on Monday the 5th. */
const NOW = new Date(2026, 9, 7, 12).getTime()

const key = (daysAgo: number): string => {
  const date = new Date(2026, 9, 7 - daysAgo)
  return `day:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const PANE = {
  plugin: 'daily-spend',
  component: 'Pane',
  requestId: 'daily-spend',
  props: {
    title: 'Spend',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = {
  command: 'spend',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

/** Opus 5.5 output at $20 per million: 30,000 tokens cost $0.60. */
const turn = (output_tokens: number) => {
  const usage: TurnUsage = {
    model: 'claude-opus-5-5',
    input_tokens: 0,
    output_tokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  return { answer: 'ok', durationMs: 900, isAborted: false, turnId: 't', reason: 'answer', usage } as const
}

/** The plugin's store, in memory and open to the test. */
const memoryStore = (on: On, entries: Record<string, unknown>) => {
  const store = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  return store
}

const answerEngine = (on: On, entries: Record<string, unknown> = {}) => {
  const toasts: string[] = []
  const store = memoryStore(on, entries)
  mock.clock(on, { now: NOW })
  on('session.root', () => ({ value: '/work/alpha' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts, store }
}

test('adds each turn to the day and project in the store, and toasts once past the daily limit', { options: { dailyLimit: 1 } }, async ($, on) => {
  const { toasts, store } = answerEngine(on)

  await $.turn.complete(turn(30_000))
  expect(toasts).toHaveLength(0)
  await $.turn.complete(turn(30_000))
  await $.turn.complete(turn(30_000))

  const today = store.get(key(0)) as Record<string, number>
  expect(Math.round((today['/work/alpha'] ?? 0) * 100)).toBe(180)
  expect(toasts).toEqual(["daily-spend: today's spend $1.20 passed your $1.00 daily limit."])
})

const HISTORY = {
  [key(0)]: { '/work/alpha': 2.5, '/work/beta': 1 },
  [key(1)]: { '/work/alpha': 4 },
  [key(10)]: { '/work/beta': 0.5 },
  [key(40)]: { '/work/gamma': 100 },
}

test('/spend draws today, the week, the fortnight and top projects; a Raster chart on the terminal', async ($, on) => {
  answerEngine(on, HISTORY)
  expect((await $.command.run(RUN)).text).toBe('daily-spend: today $3.50 · this week $7.50')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '$3.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$7.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$8.00' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'peak $4.00 on Tue 6' })).toBeDefined()

    const projects = await ui.findAll({ type: 'Text', text: /^(alpha|beta|gamma)$/ })
    expect(projects.map(found => found.text)).toEqual(['alpha', 'beta'])

    const raster = await ui.find({ type: 'Raster', key: 'chart' })
    if (surface === 'terminal') {
      expect(raster?.props.columns).toBe(27)
      expect(raster?.props.rows).toBe(5)
    } else {
      expect(raster).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Wed 7' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('Refresh picks up what other sessions spent since the pane opened', async ($, on) => {
  const { store } = answerEngine(on, HISTORY)
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  store.set(key(0), { '/work/alpha': 2.5, '/work/beta': 1, '/work/delta': 6 })
  expect(await ui.find({ type: 'Text', text: '$9.50' })).toBeUndefined()

  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: '$9.50' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^(alpha|beta|delta)$/ })).map(found => found.text)).toEqual([
    'alpha',
    'delta',
    'beta',
  ])
  await ui.unmount()
})

test('session start registers /spend and drops days older than 120', async ($, on) => {
  const { store } = answerEngine(on, { [key(5)]: { '/work/alpha': 1 }, [key(200)]: { '/work/alpha': 9 }, alertedOn: 'x' })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['spend'])
  expect([...store.keys()].sort()).toEqual([key(5), 'alertedOn'].sort())
})

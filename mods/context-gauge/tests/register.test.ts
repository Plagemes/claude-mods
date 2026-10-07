import { test, expect } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

const BAND = {
  plugin: 'context-gauge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const RUN = {
  command: 'context-gauge',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const measure = (context: SessionContextUsage) => ({
  context,
  rateLimits: [],
  changed: ['context' as const],
})

const answerEngine = (on: On) => {
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Box' }))
}

test('draws a 20-cell bar with the percentage and colours it by level', async ($, on) => {
  answerEngine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.measure(measure({ tokens: 40_000, window: 200_000, percent: 20 }))
    let ui = await $.ui.mount({ ...BAND, surface })
    const low = await ui.find({ type: 'Text', text: /█/ })
    expect(low?.text).toBe('█'.repeat(4))
    expect(low?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: '░'.repeat(16) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeUndefined()
    await ui.unmount()

    await $.session.measure(measure({ tokens: 130_000, window: 200_000, percent: 65 }))
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /█/ }))?.props.color).toBe('warning')
    await ui.unmount()

    await $.session.measure(measure({ tokens: 180_000, window: 200_000, percent: 90 }))
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /█/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('the Hide button removes the band, /context-gauge brings it back', async ($, on) => {
  answerEngine(on)
  await $.session.measure(measure({ tokens: 100_000, window: 200_000, percent: 50 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()

  await $.command.run(RUN)
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  await ui.unmount()
})

test('draws nothing until a context reading exists and again after a compaction', async ($, on) => {
  answerEngine(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await ui.unmount()

  await $.session.measure(measure({ tokens: 100_000, window: 200_000, percent: 50 }))
  await $.session.measure(measure({ window: 200_000 }))
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await after.unmount()
})

test('the thresholds come from the configuration', { options: { warnAt: 20, alertAt: 40 } }, async ($, on) => {
  answerEngine(on)
  await $.session.measure(measure({ tokens: 90_000, window: 200_000, percent: 45 }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /█/ }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: '/compact' })).toBeDefined()
  await ui.unmount()
})

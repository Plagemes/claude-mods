import { test, expect } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const BAND = {
  plugin: 'token-budget',
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

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

/** Opus 5.5 output at $20 per million: 10,000 tokens cost $0.20. */
const opusOutput = (output_tokens: number): TurnUsage => ({
  model: 'claude-opus-5-5',
  input_tokens: 0,
  output_tokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const turn = (usage: TurnUsage) =>
  ({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', usage }) as const

/** Stands for the engine beneath the plugin and records what reached it. */
const answerEngine = (on: On) => {
  const reached: string[] = []
  const toasts: string[] = []
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    reached.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another plugin band'] }))

  return { reached, toasts }
}

test('pauses prompts at 100% and lets an !override prompt through', { options: { budgetUsd: 1 } }, async ($, on) => {
  const engine = answerEngine(on)

  await $.prompt.submit(typed('first prompt'))
  await $.turn.complete(turn(opusOutput(60_000)))

  const dropped = await $.prompt.submit(typed('one more thing'))
  expect(dropped.drop).toContain('token-budget')
  expect(dropped.drop).toContain('$1.20 of $1.00')

  await $.prompt.submit(typed('!override finish the refactor'))
  expect(engine.reached).toEqual(['first prompt', 'finish the refactor'])
  expect(engine.toasts.join('\n')).toContain('Budget reached')
})

test('toasts once at 80% and draws a warning band on terminal and desktop', { options: { budgetUsd: 1 } }, async ($, on) => {
  const engine = answerEngine(on)
  await $.turn.complete(turn(opusOutput(42_500)))
  await $.turn.complete(turn(opusOutput(100)))

  expect(engine.toasts).toHaveLength(1)
  expect(engine.toasts[0]).toContain('85% of the budget used')
  expect(engine.toasts[0]).toContain('$0.15 left of $1.00')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /budget 85%/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /█/ }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: 'another plugin band' })).toBeDefined()
    await ui.unmount()
  }
})

test('Hide removes the band until the next threshold, Raise 50% lifts the limit', { options: { budgetUsd: 1 } }, async ($, on) => {
  answerEngine(on)
  await $.turn.complete(turn(opusOutput(42_500)))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()

  await $.turn.complete(turn(opusOutput(12_500)))
  expect(await ui.find({ type: 'Text', text: /budget reached/ })).toBeDefined()
  expect((await $.prompt.submit(typed('go on'))).drop).toBeDefined()

  await ui.press({ key: 'raise' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect((await $.prompt.submit(typed('go on'))).drop).toBeUndefined()
  await ui.unmount()
})

test('/budget shows the status and /budget set changes the limits', async ($, on) => {
  answerEngine(on)
  await $.session.start(START)
  await $.turn.complete(turn(opusOutput(50_000)))

  const run = (args: string) =>
    $.command.run({ command: 'budget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect((await run('')).text).toContain('10% used · $1.00 of $10.00')

  expect((await run('set 2')).text).toContain('50% used · $1.00 of $2.00')
  expect((await run('set 100k tokens')).text).toContain('50k of 100k tokens')
  expect((await run('set 40k')).text).toContain('125% used')
  expect((await $.prompt.submit(typed('blocked'))).drop).toContain('budget is spent')

  expect((await run('off')).text).toContain('No budget')
  expect((await $.prompt.submit(typed('free again'))).drop).toBeUndefined()

  expect((await run('set lots')).text).toContain('is not an amount')
})

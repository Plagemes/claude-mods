import { expect, test } from 'claude-code/testing'
import type { On, TurnCompleteInput } from 'claude-code'

import { fakeHub } from './hub'

const PLUGIN = 'token-sparkline'
const SURFACES = ['terminal', 'desktop'] as const

const bandProps = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

const turn = (input: number, output: number, agentId?: string): TurnCompleteInput => ({
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: `turn-${input}-${output}`,
  reason: 'answer',
  agentId,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' },
})

/** What the engine draws in the band beneath the plugin: a marker the tests look for. */
const engineBand = (on: On) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ key: 'engine', children: Text({ children: 'engine band' }) })
  })
}

test('plots the tokens of each main-loop turn above the prompt, as a Raster on the terminal', async ($, on) => {
  engineBand(on)
  await $.turn.complete(turn(1000, 200))
  await $.turn.complete(turn(50_000, 1_000, 'agent-1'))
  await $.turn.complete(turn(4000, 800))
  await $.turn.complete(turn(2500, 500))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps })
    const spark = await ui.find({ key: 'spark' })
    const text = (await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text
    if (surface === 'terminal') {
      expect(spark?.type).toBe('Raster')
      expect(spark?.props.columns).toBe(3)
      expect(spark?.props.rows).toBe(1)
    } else {
      expect(spark?.text).toBe('▂█▅')
    }
    expect(text).toContain('last 3.0k')
    expect(text).toContain('max 4.8k')
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps the last 40 turns and plots output tokens when configured', { options: { metric: 'output' } }, async ($, on) => {
  engineBand(on)
  for (let index = 1; index <= 45; index += 1) await $.turn.complete(turn(10_000, index * 10))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: bandProps })
  expect((await ui.find({ key: 'spark' }))?.text).toHaveLength(40)
  expect((await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text).toContain('output/turn')
  expect((await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text).toContain('last 450')
})

test('Hide removes the band and remembers it; /sparkline brings it back', async ($, on) => {
  engineBand(on)
  const saved = new Map<string, unknown>()
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sparkline' } }))
  await $.turn.complete(turn(1000, 100))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'spark' })).toBeUndefined()
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    expect(saved.get('isHidden')).toBe(true)

    const shown = await $.command.run({
      command: 'sparkline',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
    expect(shown.text).toBe('Shown.')
    expect(await ui.find({ key: 'spark' })).toBeDefined()
    expect(saved.get('isHidden')).toBe(false)
    await ui.unmount()
  }
})

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

test('with mods-hub: says hello and puts the last turn\'s cost (from cost.update) beside the tokens', async ($, on) => {
  engineBand(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sparkline' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let event: { value: unknown; version: number } = { value: null, version: 1 }
  on('state.get', { plugin: 'mods-hub', key: 'latest', id: 'cost.update' }, () => ({ value: event }))

  await $.session.start(START)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: [], consumes: ['cost.update'] }])
  await $.turn.complete(turn(3000, 200))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text).not.toContain('$')
    await ui.unmount()
  }

  event = { value: { id: 'e1', topic: 'cost.update', data: { turnUsd: 0.4231, sessionUsd: 2, model: 'm', tokens: 3200, isEstimate: false }, source: 'mods-hub', at: 1, session: 's', scope: 'session' }, version: 2 }
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text).toContain('max 3.2k · $0.42')
    await ui.unmount()
  }
})

test('without mods-hub the band shows tokens only', async ($, on) => {
  engineBand(on)
  await $.turn.complete(turn(3000, 200))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  expect((await ui.find({ type: 'Box', key: 'token-sparkline' }))?.text).not.toContain('$')
  await ui.unmount()
})

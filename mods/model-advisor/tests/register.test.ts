import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const BAND = {
  plugin: 'model-advisor',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 6,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 90, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const typed = (text: string, origin: PromptOrigin = { kind: 'composer' }) => ({ text, wait: false, origin })

/** Stands for the engine: the session runs `model.name`; what it receives is recorded. */
const answerEngine = (on: On, running: string) => {
  const engine = {
    model: running,
    entered: [] as string[],
    toasts: [] as string[],
    filled: [] as string[],
    asked: [] as { model: string; system?: string }[],
    classifierReply: 'light',
  }
  on('session.model', () => ({ value: engine.model }))
  on('prompt.submit', ($, e) => {
    engine.entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    engine.filled.push(e.text)
    return { isFilled: true }
  })
  on('model.complete', ($, e) => {
    engine.asked.push({ model: e.model, system: e.system })
    return { value: { isAnswered: true, text: engine.classifierReply, usage: USAGE } }
  })
  on('ui.toast', ($, e) => {
    engine.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another plugin band'] }))
  return engine
}

const headlineOn = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = await ui.find({ type: 'Text', text: /\/model/ })
  expect(await ui.find({ type: 'Text', text: 'another plugin band' })).toBeDefined()
  await ui.unmount()
  return found?.text
}

test('a simple prompt on Opus suggests haiku in the band, never touching the prompt', async ($, on) => {
  const engine = answerEngine(on, 'claude-opus-5-5')

  const entered = await $.prompt.submit(typed('rename getUser to fetchUser in api.ts'))

  expect(entered).toMatchObject({ text: 'rename getUser to fetchUser in api.ts' })
  expect(engine.entered).toEqual(['rename getUser to fetchUser in api.ts'])
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await headlineOn($, surface)).toBe('Simple task (a rename): /model haiku would do')
  }
  expect(engine.toasts).toHaveLength(0)
  expect(engine.asked).toHaveLength(0)
})

test('a hard prompt on haiku suggests opus; continuations and plugin prompts get nothing', async ($, on) => {
  answerEngine(on, 'claude-haiku-4-5')

  await $.prompt.submit(typed('debug the race condition in the job queue worker'))
  expect(await headlineOn($, 'terminal')).toBe('Hard task (debugging and concurrency): /model opus is stronger')

  await $.prompt.submit(typed('yes, go ahead'))
  expect(await headlineOn($, 'terminal')).toBeUndefined()

  await $.prompt.submit(typed('investigate the memory leak', { kind: 'plugin', name: 'other' }))
  expect(await headlineOn($, 'terminal')).toBeUndefined()
})

test('with useModel the classifier model decides after the prompt entered, and its failure falls back to the local rules', { options: { useModel: true, display: 'both' } }, async ($, on) => {
  const clock = mock.clock(on)
  const engine = answerEngine(on, 'claude-sonnet-5-5')

  engine.classifierReply = 'heavy'
  await $.prompt.submit(typed('make checkout work with the new payments API'))
  // The prompt entered without waiting for the classifier.
  expect(engine.entered).toEqual(['make checkout work with the new payments API'])
  expect(engine.asked).toHaveLength(0)
  await clock.advance(1)
  expect(engine.asked[0]?.model).toBe('haiku')
  expect(engine.asked[0]?.system).toContain('light, standard or heavy')
  expect(engine.toasts).toEqual(['Hard task (rated heavy by haiku): /model opus is stronger'])

  engine.classifierReply = 'no idea'
  await $.prompt.submit(typed('fix the typo in the README'))
  await clock.advance(1)
  expect(await headlineOn($, 'terminal')).toBe('Simple task (a typo fix): /model haiku would do')
})

test('Type /model fills the prompt, the same hint then rests a few prompts, Mute and /model-advisor on toggle it', async ($, on) => {
  const engine = answerEngine(on, 'opus')
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.prompt.submit(typed('fix the indentation in main.py'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'use' })
  expect(engine.filled).toEqual(['/model haiku'])
  expect(await ui.find({ type: 'Button' })).toBeUndefined()

  await $.prompt.submit(typed('fix the typo in the title'))
  expect(await ui.find({ type: 'Button', key: 'use' })).toBeUndefined()

  for (let i = 0; i < 3; i += 1) await $.prompt.submit(typed('sort the imports'))
  expect(await ui.find({ type: 'Button', key: 'use' })).toBeDefined()

  await ui.press({ key: 'mute' })
  await $.prompt.submit(typed('rename x to y'))
  expect(await ui.find({ type: 'Button' })).toBeUndefined()

  const run = await $.command.run({
    command: 'model-advisor',
    args: 'on',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(run.text).toBe('Suggestions on.')
  await $.prompt.submit(typed('reformat this file'))
  expect(await ui.find({ type: 'Button', key: 'use' })).toBeDefined()
  await ui.unmount()
})

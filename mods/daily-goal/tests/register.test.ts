import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptComposeInput, RenderPropsOf } from 'claude-code'

const PLUGIN = 'daily-goal'
const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/home/me/shop'
const KEY = `goals:${ROOT}`
/** Wednesday 7 October 2026, 10:00 local time. */
const MORNING = new Date(2026, 9, 7, 10, 0).getTime()
const HOUR = 3_600_000

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
}

const FACTS: PromptComposeInput = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }

/** Stands for the store, the clock and the prompt box beneath the plugin. */
function world(on: On, options: { now?: number; stored?: unknown } = {}) {
  const clock = mock.clock(on, { now: options.now ?? MORNING })
  const store = new Map<string, unknown>(options.stored === undefined ? [] : [[KEY, options.stored]])
  const toasts: string[] = []
  const fills: string[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))

  return { clock, store, toasts, fills }
}

const goal = ($: Engine, args = '') =>
  $.command.run({ command: 'daily-goal', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const entries = (store: Map<string, unknown>) => (store.get(KEY) as { entries: { date: string; text: string; status: string }[] }).entries
const mount = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

test('/daily-goal sets the goal, the band keeps it in view and Done marks it reached', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect((await goal($, 'Ship the login fix')).text).toBe("🎯 Today's goal: Ship the login fix. It stays above the prompt; /daily-goal done when you get there.")
  await w.clock.advance(2 * HOUR)

  for (const surface of SURFACES) {
    const band = await mount($, surface)
    expect((await band.find({ key: 'goal' }))?.text).toContain('🎯 Goal: Ship the login fix · set 2 h ago')
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await band.unmount()
  }

  const band = await mount($)
  await band.press({ key: 'done' })
  expect(w.toasts).toEqual(['🎉 Goal reached: Ship the login fix'])
  expect(entries(w.store)).toMatchObject([{ date: '2026-10-07', text: 'Ship the login fix', status: 'done' }])
  expect(await band.find({ key: 'goal' })).toBeUndefined()
  expect((await goal($)).text).toBe("🎯 Today's goal: Ship the login fix (✓ reached).")
})

test('an open goal rides in the system prompt; a reached one does not', async ($, on) => {
  world(on)
  expect((await $.prompt.compose(FACTS)).sections.map(section => section.id)).toEqual(['intro'])
  await goal($, 'Fix the flaky checkout test')
  const sections = (await $.prompt.compose(FACTS)).sections
  expect(sections.at(-1)).toEqual({
    id: 'daily-goal:goal',
    text: 'The user\'s goal for today in this project: "Fix the flaky checkout test". Keep it in mind when choosing what to work on and what to suggest next; mention it only when it is relevant.',
    scope: 'session',
  })
  await goal($, 'done')
  expect((await $.prompt.compose(FACTS)).sections.map(section => section.id)).toEqual(['intro'])
})

test('tellClaude off keeps the goal out of the system prompt', { options: { tellClaude: false } }, async ($, on) => {
  world(on)
  await goal($, 'Ship it')
  expect((await $.prompt.compose(FACTS)).sections.map(section => section.id)).toEqual(['intro'])
})

test('in the evening the band asks; "Not yet" waits for tomorrow, which asks about yesterday', async ($, on) => {
  const w = world(on, { now: MORNING + 9 * HOUR })
  await goal($, 'Ship the login fix')
  const band = await mount($)
  expect((await band.find({ key: 'question' }))?.text).toContain("🎯 Did you reach today's goal? “Ship the login fix”")
  await band.press({ key: 'not-yet' })
  expect(await band.find({ key: 'question' })).toBeUndefined()
  expect((await band.find({ key: 'goal' }))?.text).toContain('Ship the login fix')

  await w.clock.set(new Date(2026, 9, 8, 9, 0).getTime())
  await $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't', reason: 'answer' })
  await w.clock.advance(0)
  expect((await band.find({ key: 'question' }))?.text).toContain("Did you reach yesterday's goal? “Ship the login fix”")
  await band.press({ key: 'no' })
  expect(await band.find({ key: 'question' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')
  expect((await goal($, 'history')).text).toContain('✗ Wed 07 Oct  Ship the login fix')
  await band.unmount()
})

test('a new session after 18:00 asks right away; Yes counts it reached', async ($, on) => {
  const stored = { entries: [{ date: '2026-10-07', text: 'Write the docs', setAt: MORNING, status: 'open' }] }
  const w = world(on, { now: MORNING + 8 * HOUR + 30 * 60_000, stored })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.advance(0)
  const band = await mount($, 'desktop')
  expect((await band.find({ key: 'question' }))?.text).toContain('Write the docs')
  await band.press({ key: 'yes' })
  expect(entries(w.store)[0]?.status).toBe('done')
  expect(w.toasts).toEqual(['🎉 Goal reached: Write the docs'])
  expect(await band.find({ key: 'question' })).toBeUndefined()
})

test('Edit puts the goal back in the prompt box; Hide hides the band until /daily-goal', async ($, on) => {
  const w = world(on)
  await goal($, 'Ship the login fix')
  const band = await mount($)
  await band.press({ key: 'edit' })
  expect(w.fills).toEqual(['/daily-goal Ship the login fix'])
  await band.press({ key: 'hide' })
  expect(await band.find({ key: 'goal' })).toBeUndefined()
  await goal($)
  expect(await band.find({ key: 'goal' })).toBeDefined()
  expect((await goal($, 'clear')).text).toBe("Cleared today's goal (Ship the login fix).")
  expect(await band.find({ key: 'goal' })).toBeUndefined()
  expect((await goal($, 'done')).text).toBe('No goal set for today. /daily-goal <goal> sets one.')
})

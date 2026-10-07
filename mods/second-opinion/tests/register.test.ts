import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'

import { lastTurn, parseVerdict, reviewPrompt, reviewerFor } from '../hooks/review'

const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'hello', toolUses: [] },
  { role: 'assistant', text: 'Hi! What should we build?', toolUses: [] },
  { role: 'user', text: 'Cache the user lookups in getUser so we stop hitting the database on every request.', toolUses: [] },
  {
    role: 'assistant',
    text: 'I will add a cache.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Edit', input: { file_path: '/app/src/users.ts', old_string: 'return db.find(id)', new_string: 'cache[id] ??= db.find(id)\nreturn cache[id]' } },
      { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' }, isError: true },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }, { tool_use_id: 't2', text: 'fail', isError: true }] },
  { role: 'assistant', text: 'Done: getUser now caches results in a module-level object.', toolUses: [] },
]
const VERDICT = JSON.stringify({
  agreement: 'partly',
  summary: 'The cache works but never expires and grows without bound.',
  concerns: [
    { severity: 'high', text: 'The cache never invalidates: updated users are served stale forever.' },
    { severity: 'low', text: 'The failing npm test run was not mentioned.' },
  ],
  suggestions: ['Use an LRU with a TTL and clear the entry in updateUser.'],
})
const PANE = {
  plugin: 'second-opinion',
  component: 'Pane',
  requestId: 'second-opinion',
  props: { title: 'Second opinion', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const command = (args = '') => ({ command: 'second-opinion', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type Asked = { model: string; system?: string; prompt: string }
type World = { asked: Asked[]; prompts: string[]; toasts: string[]; copied: string[] }

const world = (on: On, reply: () => ModelCompleteResult, messages: SessionMessage[] = MESSAGES, sessionModel = 'claude-opus-5-5') => {
  const state: World = { asked: [], prompts: [], toasts: [], copied: [] }
  const clock = mock.clock(on, { now: 1_000 })
  on('session.messages', () => ({ value: messages }))
  on('session.model', () => ({ value: sessionModel }))
  on('model.complete', ($, e) => {
    state.asked.push({ model: e.model, prompt: e.prompt, ...(e.system === undefined ? {} : { system: e.system }) })
    return { value: reply() }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  return { state, clock }
}

test('finds the last answered turn with its changes, and reads the verdict even inside a fence', () => {
  const turn = lastTurn(MESSAGES)
  expect(turn?.question).toBe('Cache the user lookups in getUser so we stop hitting the database on every request.')
  expect(turn?.answer).toBe('I will add a cache.\n\nDone: getUser now caches results in a module-level object.')
  expect(turn?.changes).toEqual(['--- /app/src/users.ts\n- return db.find(id)\n+ cache[id] ??= db.find(id)\n+ return cache[id]'])
  expect(turn?.commands).toEqual(['npm test   # failed'])
  expect(lastTurn([{ role: 'user', text: 'hi', toolUses: [] }])).toBeUndefined()

  const prompt = reviewPrompt(turn!, 'cache invalidation')
  expect(prompt).toContain('<user_request>\nCache the user lookups')
  expect(prompt).toContain('<file_changes_made_in_that_turn>\n--- /app/src/users.ts')
  expect(prompt).toContain('<commands_run_in_that_turn>\nnpm test   # failed')
  expect(prompt).toContain('focusing especially on: cache invalidation')

  expect(parseVerdict('```json\n' + VERDICT + '\n```')?.agreement).toBe('partly')
  expect(parseVerdict('{"agreement":"maybe","summary":"x","concerns":["one"],"suggestions":[]}')).toEqual({
    agreement: 'unclear',
    summary: 'x',
    concerns: [{ severity: 'medium', text: 'one' }],
    suggestions: [],
  })
  expect(parseVerdict('I think it is fine.')).toBeUndefined()
  expect(reviewerFor('auto', 'claude-opus-5-5')).toBe('sonnet')
  expect(reviewerFor('auto', 'claude-sonnet-4-6')).toBe('opus')
  expect(reviewerFor('haiku', 'claude-opus-5-5')).toBe('haiku')
})

test('/second-opinion asks the other model and shows agreement, concerns and suggestions on terminal and desktop', async ($, on) => {
  const { state, clock } = world(on, () => ({ isAnswered: true, text: VERDICT, usage: USAGE }))
  const started = await $.command.run(command('cache invalidation'))
  expect(started.text).toBe('Asking sonnet for a second opinion on the last answer and the 1 file change it made…')
  await clock.settle()
  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]?.model).toBe('sonnet')
  expect(state.asked[0]?.system).toContain('Reply with JSON only')
  expect(state.asked[0]?.prompt).toContain('+ cache[id] ??= db.find(id)')
  expect(state.toasts.at(-1)).toBe('Second opinion from sonnet: partly agrees · 2 concerns (1 high)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '◐ Partly agrees' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "sonnet on claude-opus-5-5's answer · focus: cache invalidation" })).toBeDefined()
    expect((await ui.find({ key: 'concerns' }))?.text).toContain('The cache never invalidates')
    expect((await ui.find({ key: 'suggestions' }))?.text).toContain('→ Use an LRU with a TTL')
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copied[0]).toContain('**Second opinion (sonnet): partly agrees.** The cache works but never expires')
  expect(state.copied[0]).toContain('- [high] The cache never invalidates')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'send' })
  expect(state.prompts[0]).toContain('I asked another model for a second opinion on your last answer.')
  expect(state.prompts[0]).toContain('Suggestions:\n- Use an LRU with a TTL and clear the entry in updateUser.')
  expect(state.prompts[0]).toContain('push back where the reviewer is wrong')
})

test('a configured reviewer model wins over the automatic choice', { options: { model: 'haiku' } }, async ($, on) => {
  const { state, clock } = world(on, () => ({ isAnswered: true, text: VERDICT, usage: USAGE }), MESSAGES, 'claude-sonnet-4-6')
  await $.command.run(command())
  await clock.settle()
  expect(state.asked[0]?.model).toBe('haiku')
})

test('API errors, prose replies and an empty conversation are handled', async ($, on) => {
  let replies = 0
  const { state, clock } = world(on, () =>
    ++replies === 1 ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } : { isAnswered: true, text: 'Looks fine to me overall.', usage: USAGE },
  )
  await $.command.run(command())
  await clock.settle()
  expect(state.toasts.at(-1)).toBe('Second opinion failed: the API answered 529 (overloaded)')
  const failed = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await failed.find({ type: 'Text', text: 'It failed: the API answered 529 (overloaded)' })).toBeDefined()
  expect(await failed.find({ key: 'send' })).toBeUndefined()
  await failed.press({ key: 'again' })
  await clock.settle()
  expect(await failed.find({ key: 'raw' })).toBeDefined()
  expect(state.toasts.at(-1)).toBe('Second opinion from sonnet: see the pane')
})

test('nothing to review before Claude has answered', async ($, on) => {
  const { state } = world(on, () => ({ isAnswered: true, text: VERDICT, usage: USAGE }), [{ role: 'user', text: 'hi', toolUses: [] }])
  const ran = await $.command.run(command())
  expect(ran.text).toBe('Nothing to review yet: Claude has not answered in this conversation.')
  expect(state.asked).toHaveLength(0)
})

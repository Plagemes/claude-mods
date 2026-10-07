import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const reply = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

// Stands for the engine: a transcript the test edits, a project root, a prompt box and an in-memory store.
const engine = (on: On, root = '/work/shop') => {
  const state = {
    messages: [ask('fix the race'), reply('Use a mutex around the cache.')],
    root,
    filled: [] as { text: string; mode?: string }[],
    commands: [] as string[],
  }
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 14, 2) })
  mock.store(on)
  on('session.root', () => ({ value: state.root }))
  on('session.messages', () => ({ value: state.messages }))
  on('command.register', (_$, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: state.root }))
  on('prompt.fill', (_$, e) => {
    state.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  return state
}

const run = async ($: Engine, command: string, args = '') => {
  const { text } = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return { text: text ?? '' }
}

test('/bookmark saves the last answer with a label and /bookmarks lists it', async ($, on) => {
  engine(on)

  const saved = await run($, 'bookmark', 'race fix')
  expect(saved.text).toBe('📌 bookmark #1 saved: race fix')

  const listed = await run($, 'bookmarks')
  expect(listed.text).toContain('#1 · 2026-10-07 14:02 · race fix — Use a mutex around the cache.')
})

test('the label defaults to the start of the answer, and the text is cut at 2000 characters', async ($, on) => {
  const state = engine(on)
  state.messages = [reply('x'.repeat(5000))]

  await run($, 'bookmark')
  await run($, 'bookmark-insert', '1')

  expect(state.filled[0]?.text).toHaveLength(2000)
  expect((await run($, 'bookmarks')).text).toContain(`#1 · 2026-10-07 14:02 · ${'x'.repeat(39)}…`)
})

test('skips answers that are only tool calls and says so when there is nothing to save', async ($, on) => {
  const state = engine(on)
  state.messages = [ask('hi'), reply('Real answer'), reply('   ')]
  expect((await run($, 'bookmark')).text).toContain('#1')
  expect((await run($, 'bookmark-insert', '1')).text).toContain('in your prompt')
  expect(state.filled[0]?.text).toBe('Real answer')

  state.messages = [ask('hello')]
  expect((await run($, 'bookmark')).text).toContain('Nothing to save yet')
})

test('/bookmark-insert fills the prompt at the cursor and reports unknown numbers', async ($, on) => {
  const state = engine(on)
  await run($, 'bookmark', 'mutex')

  const inserted = await run($, 'bookmark-insert', '#1')
  expect(inserted.text).toBe('📌 bookmark #1 is in your prompt.')
  expect(state.filled).toEqual([{ text: 'Use a mutex around the cache.', mode: 'insert' }])

  expect((await run($, 'bookmark-insert', '9')).text).toContain('No bookmark #9')
  expect((await run($, 'bookmark-insert', 'abc')).text).toContain('usage:')
})

test('/bookmark-delete removes one and numbers are never reused', async ($, on) => {
  const state = engine(on)
  await run($, 'bookmark', 'first')
  state.messages = [reply('Second answer')]
  await run($, 'bookmark', 'second')

  expect((await run($, 'bookmark-delete', '1')).text).toBe('📌 bookmark #1 deleted.')
  await run($, 'bookmark', 'third')

  const listed = (await run($, 'bookmarks')).text
  expect(listed).not.toContain('#1 ·')
  expect(listed).toContain('#2 ·')
  expect(listed).toContain('#3 ·')
  expect(listed.indexOf('#3 ·')).toBeLessThan(listed.indexOf('#2 ·'))
})

test('bookmarks belong to the project they were saved in', async ($, on) => {
  const state = engine(on, '/work/shop')
  await run($, 'bookmark', 'shop note')

  state.root = '/work/blog'
  expect((await run($, 'bookmarks')).text).toContain('No bookmarks in this project yet')

  state.root = '/work/shop'
  expect((await run($, 'bookmarks')).text).toContain('shop note')
})

test('registers its four commands when the session starts', async ($, on) => {
  const state = engine(on)

  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })

  expect(state.commands.sort()).toEqual(['bookmark', 'bookmark-delete', 'bookmark-insert', 'bookmarks'])
})

import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const reply = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const RETRY = 'async function retry(fn) {\n  for (let i = 0; i < 3; i++) {\n    try { return await fn() } catch {}\n  }\n}'

// Stands for the engine: a transcript and a selection the test edits, a prompt box, an in-memory store.
const engine = (on: On) => {
  const state = {
    messages: [ask('write a retry helper'), reply(`Here you go:\n\n\`\`\`js\n${RETRY}\n\`\`\`\n\nUse it like retry(fetchUser).`)],
    selection: undefined as { text: string } | undefined,
    filled: [] as { text: string; mode?: string }[],
    commands: [] as string[],
  }
  mock.clock(on, { now: Date.UTC(2026, 9, 7) })
  mock.store(on)
  on('session.messages', () => ({ value: state.messages }))
  on('ui.selection', () => ({ value: state.selection }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.fill', (_$, e) => {
    state.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  return state
}

const run = async ($: Engine, command: string, args = '') => {
  const { text } = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return text ?? ''
}

test('/save-snippet keeps the last fenced block and /snippet puts it back, fenced', async ($, on) => {
  const state = engine(on)

  expect(await run($, 'save-snippet', 'retry')).toBe('📎 snippet retry saved (5 lines, js).')
  expect(await run($, 'snippet', 'retry')).toBe('📎 snippet retry is in your prompt.')

  expect(state.filled).toEqual([{ text: `\`\`\`js\n${RETRY}\n\`\`\``, mode: 'insert' }])
})

test('takes the newest block of the newest answer that has one', async ($, on) => {
  const state = engine(on)
  state.messages = [
    reply('```py\nprint(1)\n```\nand later\n```py\nprint(2)\n```'),
    reply('No code in this one.'),
    ask('thanks'),
  ]

  await run($, 'save-snippet', 'printer')
  await run($, 'snippet', 'printer')

  expect(state.filled[0]?.text).toBe('```py\nprint(2)\n```')
})

test('a selection wins over the last code block', async ($, on) => {
  const state = engine(on)
  state.selection = { text: '  npm run build -- --watch  ' }

  expect(await run($, 'save-snippet', 'watch')).toBe('📎 snippet watch saved (1 line).')
  await run($, 'snippet', 'watch')

  expect(state.filled[0]?.text).toBe('```\nnpm run build -- --watch\n```')
})

test('handles longer fences and code that contains fences', async ($, on) => {
  const state = engine(on)
  state.messages = [reply('````md\nUse:\n```sh\nls\n```\n````')]

  await run($, 'save-snippet', 'readme-bit')
  await run($, 'snippet', 'readme-bit')

  expect(state.filled[0]?.text).toBe('````md\nUse:\n```sh\nls\n```\n````')
})

test('explains itself when there is nothing to save or the name is bad', async ($, on) => {
  const state = engine(on)
  state.messages = [reply('Just prose, no code.')]

  expect(await run($, 'save-snippet', 'x')).toContain('no code block')
  expect(await run($, 'save-snippet', '')).toContain('usage:')
  expect(await run($, 'save-snippet', 'bad name!')).toContain('usage:')
})

test('/snippets lists, saving again updates, /delete-snippet removes', async ($, on) => {
  const state = engine(on)
  await run($, 'save-snippet', 'retry')
  state.messages = [reply('```sh\nls -la\n```')]
  await run($, 'save-snippet', 'ls')
  expect(await run($, 'save-snippet', 'ls')).toContain('updated')

  const listed = await run($, 'snippets')
  expect(listed).toContain('📎 Snippets (2)')
  expect(listed).toContain('ls · sh · 1 line · 2026-10-07')
  expect(listed).toContain('retry · js · 5 lines · 2026-10-07')

  expect(await run($, 'delete-snippet', 'ls')).toBe('📎 snippet ls deleted.')
  expect(await run($, 'snippets')).toContain('📎 Snippets (1)')
  expect(await run($, 'delete-snippet', 'ls')).toContain('no snippet called ls')
})

test('an unknown name lists what is saved', async ($, on) => {
  engine(on)
  await run($, 'save-snippet', 'retry')

  expect(await run($, 'snippet', 'nope')).toBe('snippet-vault: no snippet called nope. Saved: retry.')
  expect(await run($, 'snippet')).toContain('📎 Snippets (1)')
})

test('registers its four commands when the session starts', async ($, on) => {
  const state = engine(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(state.commands.sort()).toEqual(['delete-snippet', 'save-snippet', 'snippet', 'snippets'])
})

test('a snippet named like an Object.prototype key (constructor) is a normal snippet', async ($, on) => {
  const state = engine(on)

  expect(await run($, 'snippet', 'constructor')).toBe('snippet-vault: no snippet called constructor.')
  expect(await run($, 'delete-snippet', 'constructor')).toBe('snippet-vault: no snippet called constructor.')
  expect(await run($, 'save-snippet', 'constructor')).toBe('📎 snippet constructor saved (5 lines, js).')
  expect(await run($, 'snippet', 'constructor')).toBe('📎 snippet constructor is in your prompt.')
  expect(state.filled[0]?.text).toBe(`\`\`\`js\n${RETRY}\n\`\`\``)
  expect(await run($, 'delete-snippet', 'constructor')).toBe('📎 snippet constructor deleted.')
})

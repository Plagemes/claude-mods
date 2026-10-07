import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, UiCopyResult } from 'claude-code'

const message = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

type World = { messages: SessionMessage[]; copied: string[]; result: UiCopyResult }

const answerEngine = (on: On, messages: SessionMessage[]): World => {
  const world: World = { messages, copied: [], result: { isCopied: true } }
  on('session.messages', () => ({ value: world.messages }))
  on('ui.copy', (_$, e) => {
    world.copied.push(e.text)
    return { value: world.result }
  })
  return world
}

const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('/copy-last copies the last assistant text and reports what it copied', async ($, on) => {
  const world = answerEngine(on, [
    message('user', 'hi'),
    message('assistant', 'first answer'),
    message('user', 'more'),
    message('assistant', 'Here you go.\n\nSecond line.'),
    message('assistant', ''),
    message('user', '/copy-last'),
  ])

  const { text } = await run($, 'copy-last')

  expect(world.copied).toEqual(['Here you go.\n\nSecond line.'])
  expect(text).toBe("Copied Claude's last answer (26 characters, 3 lines).")
})

test('/copy-code copies the last fenced block, keeping nested fences and dropping list indentation', async ($, on) => {
  const world = answerEngine(on, [
    message(
      'assistant',
      [
        'Two options:',
        '```ts',
        'const a = 1',
        '```',
        'and',
        '  ````md',
        '  ```js',
        '  run()',
        '  ```',
        '  ````',
        'done',
      ].join('\n'),
    ),
  ])

  const { text } = await run($, 'copy-code')

  expect(world.copied).toEqual(['```js\nrun()\n```'])
  expect(text).toBe('Copied the md code block (15 characters, 3 lines).')

  await run($, 'copy-code', '2')
  expect(world.copied.at(-1)).toBe('const a = 1')
})

test('/copy-code looks back through earlier answers and handles tilde and unclosed fences', async ($, on) => {
  const world = answerEngine(on, [
    message('assistant', '~~~sh\nnpm test\n~~~'),
    message('assistant', 'No code in this one.'),
  ])

  await run($, 'copy-code')
  expect(world.copied).toEqual(['npm test'])

  world.messages = [message('assistant', 'Streaming...\n```python\nprint(1)')]
  await run($, 'copy-code')
  expect(world.copied.at(-1)).toBe('print(1)')
})

test('explains itself when there is nothing to copy or the copy fails', async ($, on) => {
  const world = answerEngine(on, [message('user', 'hello')])

  expect((await run($, 'copy-last')).text).toContain('nothing to copy')
  expect((await run($, 'copy-code')).text).toContain('nothing to copy')

  world.messages = [message('assistant', 'plain text only')]
  expect((await run($, 'copy-code')).text).toBe("No fenced code block in Claude's answers yet.")

  world.messages = [message('assistant', '```\nx\n```')]
  expect((await run($, 'copy-code', '3')).text).toBe('Only 1 code block so far.')

  world.result = { isCopied: false, reason: 'no-surface' }
  expect((await run($, 'copy-last')).text).toContain('headless')
  world.result = { isCopied: false, reason: 'no-clipboard' }
  expect((await run($, 'copy-code')).text).toContain('clipboard did not take it')
})

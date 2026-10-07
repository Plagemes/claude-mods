import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

/** Answers the engine's end of the chain: records the text of every prompt that reaches it. */
const answerEngine = (on: On): string[] => {
  const reached: string[] = []
  mock.store(on)
  on('prompt.submit', (_$, e) => {
    reached.push(e.text)
    return { text: e.text }
  })
  return reached
}

/** A prompt as it is typed, passed through the plugin; returns the text that reaches the engine. */
const typed = async ($: Engine, reached: string[], text: string, kind: 'composer' | 'peer' = 'composer'): Promise<string> => {
  await $.prompt.submit({ text, wait: false, origin: { kind } })
  return reached.at(-1) ?? ''
}

test('expands the built-in shortcodes inside a sentence', async ($, on) => {
  const reached = answerEngine(on)
  const text = await typed($, reached, 'please :review: and then :tests: for src/auth.ts')

  expect(text).toContain('Review the changes I have made so far')
  expect(text).toContain('Write tests for the code we just changed')
  expect(text).toEndWith('for src/auth.ts')
  expect(text).not.toContain(':review:')
})

test('/snippet-add saves a custom snippet that wins over a built-in one, /snippets lists it', async ($, on) => {
  const reached = answerEngine(on)

  const saved = await $.command.run(run('snippet-add', 'ship Run the tests, then commit.'))
  expect(saved.text).toBe('Saved :ship:. Type :ship: in a prompt to use it.')
  expect(await typed($, reached, ':ship:')).toBe('Run the tests, then commit.')

  const overridden = await $.command.run(run('snippet-add', ':review: Only look at security.'))
  expect(overridden.text).toContain('overrides the built-in one')
  expect(await typed($, reached, ':review:')).toBe('Only look at security.')

  const list = await $.command.run(run('snippets'))
  expect(list.text).toContain(':ship:  [custom]  Run the tests, then commit.')
  expect(list.text).toContain(':explain:  [built-in]')

  const removed = await $.command.run(run('snippet-remove', 'ship'))
  expect(removed.text).toBe('Removed :ship:.')
  expect(await typed($, reached, ':ship:')).toBe(':ship:')
})

test('snippets from the configuration are merged in', { options: { snippets: '{"fix": "Fix the failing test."}' } }, async ($, on) => {
  const reached = answerEngine(on)

  expect(await typed($, reached, ':fix: please')).toBe('Fix the failing test. please')
})

test('an invalid configuration is ignored and reported by /snippets', { options: { snippets: '{nope' } }, async ($, on) => {
  const reached = answerEngine(on)

  expect(await typed($, reached, ':docs:')).toContain('Document this code')
  expect((await $.command.run(run('snippets'))).text).toContain('was ignored')
})

test('leaves unknown tokens, times, code spans and prompts from others alone', async ($, on) => {
  const reached = answerEngine(on)

  expect(await typed($, reached, 'deploy at 10:30:45 :smile: std::vector')).toBe('deploy at 10:30:45 :smile: std::vector')
  expect(await typed($, reached, 'use `:review:` literally')).toBe('use `:review:` literally')
  expect(await typed($, reached, 'x\n```\n:tests:\n```')).toBe('x\n```\n:tests:\n```')
  expect(await typed($, reached, ':review:', 'peer')).toBe(':review:')
})

test('rejects a malformed /snippet-add', async ($, on) => {
  const reached = answerEngine(on)

  expect((await $.command.run(run('snippet-add', 'lonely'))).text).toContain('Usage:')
})

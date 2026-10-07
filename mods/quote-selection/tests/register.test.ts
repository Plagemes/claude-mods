import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

type World = { selection: string | undefined; filled: { text: string; mode: string }[]; isFilled: boolean }

const answerEngine = (on: On, selection?: string): World => {
  const world: World = { selection, filled: [], isFilled: true }
  on('ui.selection', () => ({ value: world.selection === undefined ? undefined : { text: world.selection } }))
  on('prompt.fill', (_$, e) => {
    world.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: world.isFilled }
  })
  return world
}

test('/quote puts the selection into the prompt as a Markdown quote', async ($, on) => {
  const world = answerEngine(on, 'first line\n\nthird line\n')

  const { text } = await $.command.run(run('quote'))

  expect(text).toBe('Quoted the selection.')
  expect(world.filled).toEqual([{ text: '> first line\n>\n> third line\n\n', mode: 'insert' }])
})

test('/quote-code wraps the selection in a fence, with an optional language', async ($, on) => {
  const world = answerEngine(on, 'const a = 1\nconst b = 2')

  await $.command.run(run('quote-code'))
  await $.command.run(run('quote-code', ' ts '))

  expect(world.filled.map(f => f.text)).toEqual([
    '```\nconst a = 1\nconst b = 2\n```\n\n',
    '```ts\nconst a = 1\nconst b = 2\n```\n\n',
  ])
})

test('the fence grows past backticks inside the selection', async ($, on) => {
  const world = answerEngine(on, 'run ```npm test``` now')

  await $.command.run(run('quote-code', 'md'))

  expect(world.filled[0]?.text).toBe('````md\nrun ```npm test``` now\n````\n\n')
})

test('says so when nothing is selected or the prompt box refuses', async ($, on) => {
  const world = answerEngine(on)

  const none = await $.command.run(run('quote'))
  expect(none.text).toContain('Nothing is selected')
  expect(world.filled).toHaveLength(0)

  world.selection = 'hello'
  world.isFilled = false
  const refused = await $.command.run(run('quote-code'))
  expect(refused.text).toContain('prompt box is not available')
})

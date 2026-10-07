import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

/** The engine beneath the plugin: tool calls fail while their command or file is listed in `failing`. */
const world = (on: On) => {
  const seen = { reached: 0, toasts: [] as string[], failing: new Set<string>(), isRefusing: false }
  on('tool.call', (_$, e) => {
    seen.reached += 1
    if (seen.isRefusing) return { deny: 'nope' }
    const target = String('command' in e ? e.command : 'file_path' in e ? e.file_path : '')
    const isFailing = seen.failing.has(target.trim().replace(/\s+/g, ' '))
    return isFailing ? { isError: true as const, result: 'it failed', text: 'it failed' } : { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return seen
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const edit = ($: Engine, file_path: string, new_string = 'b') => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string })
const say = ($: Engine, origin: PromptOrigin = { kind: 'composer' }) => $.prompt.submit({ text: 'try again', wait: false, origin })

test('the third identical failure tells Claude to step back, the fourth identical call is refused', async ($, on) => {
  const seen = world(on)
  seen.failing.add('npm run build')

  const first = await bash($, 'npm run build')
  const second = await bash($, 'npm run build')
  expect(first.context).toBeUndefined()
  expect(second.context).toBeUndefined()

  const third = await bash($, 'npm run build')
  expect(third.isError).toBe(true)
  expect(third.context?.[0]).toContain('failed 3 times in a row')
  expect(third.context?.[0]).toContain('try a different approach')
  expect(seen.toasts).toEqual(['stopped a loop: "npm run build" failed 3 times in a row'])

  const fourth = await bash($, 'npm run build')
  expect(fourth.deny).toContain('loop-breaker: refused')
  expect(fourth.deny).toContain('read the error')
  expect(seen.reached).toBe(3)
})

test('a different command, or the same one spaced differently, is judged on its own', async ($, on) => {
  const seen = world(on)
  seen.failing.add('make test')
  seen.failing.add('make lint')

  await bash($, 'make test')
  await bash($, 'make   lint')
  await bash($, '  make test  ')
  await bash($, 'make lint')
  expect((await bash($, 'make test')).context?.[0]).toContain('make test')
  expect((await bash($, 'make lint')).context?.[0]).toContain('make lint')
  expect((await bash($, 'make lint')).deny).toContain('refused')
  expect((await bash($, 'make build')).deny).toBeUndefined()
})

test('only consecutive failures count: a success or a project change starts the count over', async ($, on) => {
  const seen = world(on)
  seen.failing.add('npm test')

  await bash($, 'npm test')
  await bash($, 'npm test')
  seen.failing.delete('npm test')
  await bash($, 'npm test')
  seen.failing.add('npm test')
  await bash($, 'npm test')
  await bash($, 'npm test')
  expect((await bash($, 'npm test')).context).toBeDefined()

  // The model fixes the code between two failing runs: not the same situation any more.
  await say($)
  await bash($, 'npm test')
  await bash($, 'npm test')
  await edit($, '/repo/src/a.ts')
  expect((await bash($, 'npm test')).context).toBeUndefined()
  expect((await bash($, 'npm test')).context).toBeUndefined()
  expect((await bash($, 'npm test')).context).toBeDefined()
})

test('identical failing edits are caught too', async ($, on) => {
  const seen = world(on)
  seen.failing.add('/repo/a.ts')

  await edit($, '/repo/a.ts')
  await edit($, '/repo/a.ts')
  expect((await edit($, '/repo/a.ts')).context?.[0]).toContain('Edit /repo/a.ts')
  expect((await edit($, '/repo/a.ts')).deny).toContain('refused')
  // Another replacement text is a different attempt.
  expect((await edit($, '/repo/a.ts', 'c')).deny).toBeUndefined()
})

test('the next prompt from a person lifts the block; a plugin or task prompt does not', async ($, on) => {
  const seen = world(on)
  seen.failing.add('./flaky.sh')
  for (let i = 0; i < 3; i += 1) await bash($, './flaky.sh')
  expect((await bash($, './flaky.sh')).deny).toBeDefined()

  await say($, { kind: 'task-notification' })
  await say($, { kind: 'plugin', name: 'other' })
  expect((await bash($, './flaky.sh')).deny).toBeDefined()

  await say($, { kind: 'composer' })
  expect((await bash($, './flaky.sh')).deny).toBeUndefined()
})

test('the limit is configurable', { options: { limit: 2 } }, async ($, on) => {
  const seen = world(on)
  seen.failing.add('false')

  await bash($, 'false')
  expect((await bash($, 'false')).context?.[0]).toContain('failed 2 times')
  expect((await bash($, 'false')).deny).toContain('refused')
})

test('a call another plugin refused is not a failure', async ($, on) => {
  world(on).isRefusing = true

  for (let i = 0; i < 5; i += 1) expect((await bash($, 'rm -rf x')).deny).toBe('nope')
})

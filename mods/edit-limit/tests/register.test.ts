import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { fakeHub } from './hub'

/** Answers `$.state` from memory, as the host does: a value and the version it stands at. */
const memoryState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: cells.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const held = cells.get(keyOf(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    cells.set(keyOf(e), { value: e.value, version: held.version + 1 })
    return { value: { isSet: true, version: held.version + 1 } }
  })
}

/** The engine beneath the plugin: tool calls run (or fail for the paths in `failing`), toasts are recorded. */
const world = (on: On) => {
  const seen = { reached: 0, toasts: [] as string[], failing: new Set<string>() }
  memoryState(on)
  on('tool.call', (_$, e) => {
    seen.reached += 1
    const path = String('file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : '')
    return seen.failing.has(path) ? { isError: true as const, result: 'no match', text: 'no match' } : { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  return seen
}

const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const write = ($: Engine, file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' })
const editMany = async ($: Engine, count: number, prefix = '/repo/f') => {
  for (let i = 1; i <= count; i += 1) await edit($, `${prefix}${i}.ts`)
}
const newTurn = ($: Engine) => $.turn.start({ text: 'next', turnId: `t${Math.random()}` })
const say = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) => $.prompt.submit({ text, wait: false, origin })
const command = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'edit-limit',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('the file that would go over the limit is refused, with a message that asks Claude to check with you', async ($, on) => {
  const seen = world(on)
  await editMany($, 15)

  const result = await edit($, '/repo/one-too-many.ts')

  expect(result.deny).toContain('edit-limit: this turn has already modified 15 files and the limit is 15')
  expect(result.deny).toContain('Summarise your plan')
  expect(result.deny).toContain('EDITS-OK')
  expect(result.deny).toContain('/edit-limit <n>')
  expect(seen.reached).toBe(15)
  expect(seen.toasts).toEqual(['stopped at 15 files this turn; Claude was told to check with you'])
})

test('only distinct files count: editing a file again is free, and so is a call that fails', async ($, on) => {
  const seen = world(on)
  seen.failing.add('/repo/missing.ts')
  await editMany($, 14)
  await edit($, '/repo/f1.ts')
  await edit($, '/repo/f1.ts')
  expect((await edit($, '/repo/missing.ts')).isError).toBe(true)
  expect((await write($, '/repo/f15.ts')).deny).toBeUndefined()
  expect((await edit($, '/repo/f3.ts')).deny).toBeUndefined()
  expect((await edit($, '/repo/f16.ts')).deny).toBeDefined()
})

test('Write and NotebookEdit count like Edit', async ($, on) => {
  world(on)
  await editMany($, 13)
  expect((await write($, '/repo/a.md')).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/m.ipynb', new_source: 'x' })).deny).toContain('NotebookEdit was not run')
})

test('a new turn starts the count over', async ($, on) => {
  world(on)
  await editMany($, 15)
  expect((await edit($, '/repo/more.ts')).deny).toBeDefined()

  await newTurn($)

  expect((await edit($, '/repo/more.ts')).deny).toBeUndefined()
})

test('the approval word in the latest prompt lifts the limit for that turn, the next prompt takes it back', async ($, on) => {
  world(on)
  await say($, 'refactor everything, EDITS-OK')
  await editMany($, 20)
  expect((await edit($, '/repo/f21.ts')).deny).toBeUndefined()

  await say($, 'now something else')
  await newTurn($)
  await editMany($, 15, '/other/g')
  expect((await edit($, '/other/g16.ts')).deny).toBeDefined()
})

test('only a person can approve: another plugin or a task notification quoting the word does nothing', async ($, on) => {
  world(on)
  await say($, 'EDITS-OK', { kind: 'plugin', name: 'other' })
  await say($, 'EDITS-OK', { kind: 'task-notification' })
  await editMany($, 15)

  expect((await edit($, '/repo/f16.ts')).deny).toBeDefined()
})

test('/edit-limit shows the count, raises the limit for the session and resets it', async ($, on) => {
  world(on)
  await editMany($, 3)

  expect(await command($, '')).toContain('This turn: 3 of 15 files modified. Say EDITS-OK in a prompt to lift it for one turn.')
  expect(await command($, '4')).toBe('Claude may now modify 4 files per turn (was 15), until the session ends.')
  expect((await edit($, '/repo/f4.ts')).deny).toBeUndefined()
  expect((await edit($, '/repo/f5.ts')).deny).toContain('the limit is 4')

  expect(await command($, '30')).toContain('(was 4)')
  expect((await edit($, '/repo/f5.ts')).deny).toBeUndefined()

  expect(await command($, 'reset')).toBe('The limit is back to 15 files per turn.')
  expect(await command($, 'lots')).toContain('Give a whole number')
  expect(await command($, '0')).toContain('Give a whole number')
})

test('the limit and the approval word are configurable', { options: { max: 2, allowWord: 'GO-AHEAD' } }, async ($, on) => {
  world(on)
  await editMany($, 2)

  const refused = await edit($, '/repo/f3.ts')
  expect(refused.deny).toContain('the limit is 2')
  expect(refused.deny).toContain('GO-AHEAD')
  expect(refused.deny).not.toContain('EDITS-OK')

  await say($, 'EDITS-OK please')
  expect((await edit($, '/repo/f3.ts')).deny).toBeDefined()
  await say($, 'GO-AHEAD')
  expect((await edit($, '/repo/f3.ts')).deny).toBeUndefined()
})

test('with no approval word the message only offers /edit-limit', { options: { allowWord: '' } }, async ($, on) => {
  world(on)
  await editMany($, 15)

  const refused = await edit($, '/repo/f16.ts')

  expect(refused.deny).toContain('They can approve by raising the limit with /edit-limit <n>.')
  expect(await command($, '')).not.toContain('Say')
})

test('registers /edit-limit when the session starts', async ($, on) => {
  const registered: string[] = []
  world(on)
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['edit-limit'])
})

test('regression: EDITS-OK does not carry into a turn the person did not start', async ($, on) => {
  world(on)
  await say($, 'refactor everything, EDITS-OK')
  await editMany($, 16)
  // Delivered into the approved turn: it stays approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await edit($, '/repo/f17.ts')).deny).toBeUndefined()
  // A notification that starts a turn of its own is held to the limit again.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  await newTurn($)
  await editMany($, 15, '/other/g')
  expect((await edit($, '/other/g16.ts')).deny).toBeDefined()
})

test('with mods-hub: says hello; a refusal is published as risk.blocked and sent as a warning, not a toast', async ($, on) => {
  const seen = world(on)
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['risk.blocked'], consumes: [] }])

  await editMany($, 15)
  expect((await edit($, '/repo/one-too-many.ts')).deny).toContain('the limit is 15')
  expect(hub.published).toEqual([
    { topic: 'risk.blocked', data: { guard: 'edit-limit', tool: 'Edit', reason: 'more than 15 files in one turn', severity: 'low', path: '/repo/one-too-many.ts' } },
  ])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'stopped at 15 files this turn; Claude was told to check with you' }])
  expect(seen.toasts).toEqual([])
})

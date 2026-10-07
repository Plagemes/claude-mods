import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteInput } from 'claude-code'

import { fakeHub } from './hub'

const ROOT = '/home/me/shop'
const CLAUDE_MD = `${ROOT}/CLAUDE.md`
const USAGE = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LESSON = 'Initialize the price cache before rendering a cart in tests; `renderCart` reads it synchronously.'
const TURN: TurnCompleteInput = { answer: 'Fixed: the cache was not initialized.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' }
const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

type World = { files: Map<string, string>; asked: string[]; toasts: string[]; clock: MockClock; failing: Set<string> }

/** A shell where the commands in `failing` exit non-zero, and a model answering `reply`. */
function world(on: On, reply: string, files: Record<string, string> = {}): World {
  const seen: World = { files: new Map(Object.entries(files)), asked: [], toasts: [], clock: mock.clock(on), failing: new Set() }
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && seen.failing.has(e.command)) {
      return { isError: true, result: 'Exit code 1', text: 'FAIL test/cart.test.ts\n  TypeError: Cannot read properties of undefined (reading "price")' }
    }
    return { result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }
  })
  on('model.complete', ($, e) => {
    seen.asked.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  return seen
}

/** A test fails, a file is edited, the test passes: a fix cycle. */
async function fixCycle($: Engine, seen: World, failing = 'npm run test -- cart', passing = 'npm test'): Promise<void> {
  seen.failing.add(failing)
  await $.tool.call({ tool: 'Bash', command: failing })
  seen.failing.delete(failing)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: passing })
  await $.turn.complete(TURN)
  await seen.clock.advance(0)
}


/** Box props that size a box: the engine refuses its own nodes under any of them, and the band then disappears. */
const SIZE_PROPS = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight', 'flexBasis']
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** The elements above the first Text showing `text`, outermost first; undefined when the tree draws no such Text. */
const ancestorsOf = (node: unknown, text: string, above: DrawnNode[] = []): DrawnNode[] | undefined => {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as DrawnNode
  const children = element.children ?? []
  if (element.type === 'Text' && children.includes(text)) return above
  for (const child of children) {
    const found = ancestorsOf(child, text, [...above, element])
    if (found !== undefined) return found
  }
  return undefined
}
/** The size props set on any Box above the engine's band; a line says so when the band is not drawn at all. */
const sizedAbove = (tree: unknown): string[] => {
  const above = ancestorsOf(tree, 'engine band')
  if (above === undefined) return ['no engine band drawn']
  return above.flatMap(box => (box.type === 'Box' ? SIZE_PROPS.filter(prop => box.props?.[prop] !== undefined).map(prop => `Box ${prop}`) : []))
}

test('after a fail, edit, pass cycle it offers the lesson and saves it under Lessons learned', async ($, on) => {
  const seen = world(on, `- ${LESSON}`, { [CLAUDE_MD]: '# Shop\n\n## Lessons learned\n\n- Use pnpm, not npm.\n\n## Style\n\nTabs.\n' })
  await fixCycle($, seen)

  expect(seen.asked[0]).toContain('Failed command: npm run test -- cart')
  expect(seen.asked[0]).toContain('TypeError: Cannot read properties of undefined')
  expect(seen.asked[0]).toContain('Files edited before it passed: cart.ts')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lessons-learned', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /Lesson learned/ }))?.text).toContain('from fixing npm test')
    expect((await band.find({ type: 'Text', text: /price cache/ }))?.text).toBe(LESSON)
    expect((await band.find({ key: 'save' }))?.props.label).toBe('Save to CLAUDE.md')
    await band.unmount()
  }

  const band = await $.ui.mount({ plugin: 'lessons-learned', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'save' })
  expect(seen.files.get(CLAUDE_MD)).toBe(`# Shop\n\n## Lessons learned\n\n- Use pnpm, not npm.\n- ${LESSON}\n\n## Style\n\nTabs.\n`)
  expect(seen.toasts).toEqual(['📘 Saved to CLAUDE.md'])
  expect(await band.find({ key: 'save' })).toBeUndefined()
})

test('creates CLAUDE.md with the section when there is none', async ($, on) => {
  const seen = world(on, LESSON)
  await fixCycle($, seen, 'cargo test', 'cargo test --all')

  const band = await $.ui.mount({ plugin: 'lessons-learned', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'save' })
  expect(seen.files.get(CLAUDE_MD)).toBe(`## Lessons learned\n\n- ${LESSON}\n`)
})

test('ignores flaky reruns, non-check commands and NONE replies', async ($, on) => {
  const seen = world(on, 'NONE')

  seen.failing.add('pytest -x')
  await $.tool.call({ tool: 'Bash', command: 'pytest -x' })
  seen.failing.delete('pytest -x')
  await $.tool.call({ tool: 'Bash', command: 'pytest -x' })
  seen.failing.add('ls missing')
  await $.tool.call({ tool: 'Bash', command: 'ls missing' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.py`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN)
  await seen.clock.advance(0)
  expect(seen.asked).toEqual([])

  await fixCycle($, seen, 'go test ./...', 'go test ./...')
  expect(seen.asked).toHaveLength(1)
  const band = await $.ui.mount({ plugin: 'lessons-learned', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')
})

test('Dismiss drops the lesson and the same lesson is not offered twice', { options: { file: 'docs/AGENTS.md' } }, async ($, on) => {
  const seen = world(on, LESSON)
  await fixCycle($, seen)

  const band = await $.ui.mount({ plugin: 'lessons-learned', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ key: 'save' }))?.props.label).toBe('Save to docs/AGENTS.md')
  await band.press({ key: 'dismiss' })
  expect(await band.find({ key: 'save' })).toBeUndefined()

  await fixCycle($, seen)
  expect(seen.asked).toHaveLength(2)
  expect(await band.find({ key: 'save' })).toBeUndefined()
  expect(seen.files.size).toBe(0)
})

test('the lesson band keeps the bands beneath it on screen', async ($, on) => {
  const seen = world(on, LESSON)
  await fixCycle($, seen)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lessons-learned', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'save' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await band.unmount()
  }
})

test('regression: a failing command that only names a check does not start a fix cycle', async ($, on) => {
  const seen = world(on, LESSON)
  for (const named of ['cat jest.config.js', 'npm i -D vitest', 'git commit -m "fix eslint"']) {
    await fixCycle($, seen, named, 'npx jest')
  }
  expect(seen.asked).toEqual([])

  await fixCycle($, seen, 'cd web && npx jest cart', 'cd web && npx jest')
  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toContain('Failed command: cd web && npx jest cart')
})

test('the engine band is not drawn under a Box with a size prop', async ($, on) => {
  const seen = world(on, `- ${LESSON}`)
  await fixCycle($, seen)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lessons-learned', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'save' })).toBeDefined()
    expect(sizedAbove(await band.drawn())).toEqual([])
    await band.unmount()
  }
})

test('with mods-hub: a fix seen through test-watch\'s test.result becomes a lesson, and a saved lesson is published', async ($, on) => {
  const seen = world(on, LESSON)
  const hub = fakeHub(on, { presence: 'away' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['lesson.learned'], consumes: ['test.result', 'error.repeated'] }])

  // test-watch runs the tests on its own after edits: Claude never runs them through Bash.
  await seen.clock.advance(1_000)
  hub.events.push({ topic: 'test.result', source: 'test-watch', at: seen.clock.now(), data: { runner: 'vitest', outcome: 'failed', passed: 3, failed: 1, command: 'vitest run src/cart.test.ts', failures: ['cart > totals'] } })
  // The hub's own sensor reports the Bash runs this mod already watches: never counted twice.
  hub.events.push({ topic: 'test.result', source: 'mods-hub', at: seen.clock.now(), data: { runner: 'jest', outcome: 'failed', passed: 0, failed: 1 } })
  await seen.clock.advance(1_000)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'a', new_string: 'b' })
  await seen.clock.advance(1_000)
  hub.events.push({ topic: 'test.result', source: 'test-watch', at: seen.clock.now(), data: { runner: 'vitest', outcome: 'passed', passed: 4, failed: 0, command: 'vitest run src/cart.test.ts' } })
  await $.turn.complete(TURN)
  await seen.clock.advance(0)

  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toContain('Failed command: vitest run src/cart.test.ts')
  expect(seen.asked[0]).toContain('cart > totals')
  expect(seen.asked[0]).toContain('Files edited before it passed: cart.ts')
  // Away from the keyboard: the lesson also goes out through the hub, as a question.
  expect(hub.notified).toEqual([
    { level: 'info', kind: 'question', title: '💡 Lesson learned from fixing vitest', body: `${LESSON}\nSave it to CLAUDE.md from the terminal.` },
  ])

  const band = await $.ui.mount({ plugin: 'lessons-learned', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'save' })
  await band.unmount()
  expect(seen.toasts).toEqual(['📘 Saved to CLAUDE.md'])
  expect(hub.published).toEqual([{ topic: 'lesson.learned', data: { lesson: LESSON, context: 'fixing vitest', path: 'CLAUDE.md' }, scope: 'global' }])
})

test('with mods-hub: a check the hub saw fail three times in a row is not taken for a one-off', async ($, on) => {
  const seen = world(on, LESSON)
  const hub = fakeHub(on)
  hub.events.push({ topic: 'error.repeated', source: 'mods-hub', at: 0, data: { signature: 'npm run test', count: 3, tool: 'Bash', command: 'npm run test -- cart' } })

  await fixCycle($, seen)
  expect(seen.asked[0]).toContain('It failed 3 times in a row before the fix')
  // The person is here: the band is enough.
  expect(hub.notified).toEqual([])
})

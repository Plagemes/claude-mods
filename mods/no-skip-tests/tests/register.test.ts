import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { files: Record<string, string>; unreadable: Set<string> }

const answerEngine = (on: On, files: Record<string, string> = {}): World => {
  const world: World = { files, unreadable: new Set() }
  on('fs.exists', (_$, e) => ({ value: e.path in world.files || world.unreadable.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = world.files[e.path]
    return text === undefined ? { deny: 'EIO' } : { value: text }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  return world
}

const edit = ($: Engine, file_path: string, old_string: string, new_string: string) =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string })

const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })

test('denies an edit that adds a skip or a focus marker to a test file', async ($, on) => {
  answerEngine(on)

  const cases: [string, string, string][] = [
    ['/p/a.test.ts', "it('works', () => {", "it.skip('works', () => {"],
    ['/p/a.spec.js', "describe('x', () => {", "describe.only('x', () => {"],
    ['/p/a.test.ts', "test('x', () => {", "xtest('x', () => {"],
    ['/p/__tests__/a.js', "  it('x', f)", "  fit('x', f)"],
    ['/p/test_a.py', 'def test_a():', '@pytest.mark.skip(reason="flaky")\ndef test_a():'],
    ['/p/test_a.py', 'def test_a():', '@unittest.skip("later")\ndef test_a():'],
    ['/p/a_test.go', 'func TestA(t *testing.T) {', 'func TestA(t *testing.T) {\n\tt.Skip("later")'],
    ['/p/src/lib.rs', '#[test]', '#[test]\n#[ignore]'],
    ['/p/ATest.java', '@Test', '@Test @Disabled'],
  ]

  for (const [path, before, after] of cases) {
    const result = await edit($, path, before, after)
    expect(result.deny, `${path}: ${after}`).toContain('no-skip-tests')
  }
})

test('allows ordinary test edits, markers that were already there, and non-test files', async ($, on) => {
  answerEngine(on)

  expect((await edit($, '/p/a.test.ts', "it('a', f)", "it('a renamed', f)")).deny).toBeUndefined()
  expect((await edit($, '/p/a.test.ts', "it.skip('a', f)", "it.skip('a renamed', f)")).deny).toBeUndefined()
  expect((await edit($, '/p/a.test.ts', "it.only('a', f)", "it('a', f)")).deny).toBeUndefined()
  expect((await edit($, '/p/src/util.ts', 'x', "it.skip('x')")).deny).toBeUndefined()
  expect((await edit($, '/p/test_a.py', 'x', '@pytest.mark.skipif(sys.platform == "win32")')).deny).toBeUndefined()
  expect((await edit($, '/p/a.test.ts', 'x', 'const hit = fitness(1)')).deny).toBeUndefined()
})

test('judges a Write against the file it replaces', async ($, on) => {
  answerEngine(on, {
    '/p/old.test.ts': "it.skip('legacy', f)\nit('b', f)\n",
    '/p/clean.test.ts': "it('a', f)\n",
  })

  const kept = await write($, '/p/old.test.ts', "it.skip('legacy', f)\nit('b', f)\nit('c', f)\n")
  expect(kept.deny).toBeUndefined()

  const added = await write($, '/p/clean.test.ts', "it('a', f)\nit.skip('b', f)\n")
  expect(added.deny).toContain('.skip / .only')

  const fresh = await write($, '/p/new.test.ts', "xit('a', f)\n")
  expect(fresh.deny).toContain('fit / xit / xdescribe')
})

test('judges every edit of a MultiEdit and lets through what it cannot read', async ($, on) => {
  const world = answerEngine(on)
  world.unreadable.add('/p/huge.test.ts')

  const multi = {
    tool: 'MultiEdit',
    file_path: '/p/a.test.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: "it('x')", new_string: "it.skip('x')" },
    ],
  } as unknown as Parameters<Engine['tool']['call']>[0]
  expect((await $.tool.call(multi)).deny).toContain('no-skip-tests')

  expect((await write($, '/p/huge.test.ts', "it.skip('x')")).deny).toBeUndefined()
})

test('the escape word in the latest prompt allows it, the next prompt takes it back', async ($, on) => {
  answerEngine(on)
  const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  const skip = () => edit($, '/p/a.test.ts', "it('x')", "it.skip('x')")

  await say('please skip the flaky test, SKIP-OK')
  expect((await skip()).deny).toBeUndefined()

  await say('thanks, now continue')
  expect((await skip()).deny).toContain('SKIP-OK')
})

test('the escape word is configurable and can be turned off', { options: { allowWord: '' } }, async ($, on) => {
  answerEngine(on)

  await $.prompt.submit({ text: 'SKIP-OK', wait: false, origin: { kind: 'composer' } })
  const result = await edit($, '/p/a.test.ts', "it('x')", "it.skip('x')")

  expect(result.deny).toContain('no-skip-tests')
  expect(result.deny).not.toContain('ask them')
})

test('Windows paths with backslashes are recognised as test files', async ($, on) => {
  answerEngine(on)
  const result = await edit($, 'C:\\repo\\tests\\test_api.py', 'def test_a():', '@pytest.mark.skip\ndef test_a():')
  expect(result.deny).toContain('@pytest.mark.skip')
})

test('regression: SKIP-OK does not carry into a turn the person did not start', async ($, on) => {
  answerEngine(on)
  const skip = () => edit($, '/p/a.test.ts', "it('x')", "it.skip('x')")
  await $.prompt.submit({ text: 'please skip the flaky test, SKIP-OK', wait: false, origin: { kind: 'composer' } })
  // Delivered into the approved turn: it stays approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await skip()).deny).toBeUndefined()
  // A notification that starts a turn of its own is not approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect((await skip()).deny).toContain('SKIP-OK')
})

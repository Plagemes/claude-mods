import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const FILE = '/repo/src/app.ts'

/** Stands in for the engine: tools succeed, the status line is recorded, files read from `files`. */
const engine = (on: On, files: Record<string, string> = {}) => {
  const statuses: (string | undefined)[] = []
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const content = files[e.path]
    return content === undefined ? { deny: 'ENOENT' } : { value: content }
  })
  return statuses
}

test('asks for added console.log calls to be removed and counts them in the status', async ($, on) => {
  const statuses = engine(on)

  const result = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'const a = 1',
    new_string: 'const a = 1\nconsole.log("a is", a)',
  })

  expect(result.context?.[0]).toContain('added 1 debug statement')
  expect(result.context?.[0]).toContain('console.log("a is", a)')
  expect(statuses.at(-1)).toContain('1 debug statement')
})

test('ignores tests, scripts, comments, unrelated files and marked lines', async ($, on) => {
  engine(on)
  const edit = (file_path: string, new_string: string) =>
    $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string })

  expect((await edit('/repo/src/app.test.ts', 'console.log(1)')).context).toBeUndefined()
  expect((await edit('/repo/scripts/build.ts', 'console.log(1)')).context).toBeUndefined()
  expect((await edit('/repo/README.md', 'console.log(1)')).context).toBeUndefined()
  expect((await edit(FILE, '// console.log(1)')).context).toBeUndefined()
  expect((await edit(FILE, 'console.log(1) // debug-catcher: ignore')).context).toBeUndefined()
})

test('does not flag a debug line the edit merely leaves in place', async ($, on) => {
  engine(on)

  const result = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'console.log("kept")\nlet a = 1',
    new_string: 'console.log("kept")\nlet a = 2',
  })

  expect(result.context).toBeUndefined()
})

test('recognises the debug idioms of other languages', async ($, on) => {
  engine(on)
  const flagged = async (file_path: string, new_string: string) =>
    (await $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string })).context !== undefined

  expect(await flagged('/repo/main.py', 'print(value)')).toBe(true)
  expect(await flagged('/repo/main.rs', 'dbg!(value);')).toBe(true)
  expect(await flagged('/repo/main.go', 'fmt.Println(value)')).toBe(true)
  expect(await flagged('/repo/index.php', 'var_dump($value);')).toBe(true)
  expect(await flagged('/repo/app.js', 'debugger;')).toBe(true)
  expect(await flagged('/repo/main.py', 'sprint(value)')).toBe(false)
})

test('compares a Write against the file it replaces and clears the status once cleaned up', async ($, on) => {
  const statuses = engine(on, { [FILE]: 'console.log("old")\nexport const a = 1\n' })

  const kept = await $.tool.call({
    tool: 'Write',
    file_path: FILE,
    content: 'console.log("old")\nexport const a = 2\n',
  })
  expect(kept.context).toBeUndefined()

  const added = await $.tool.call({
    tool: 'Write',
    file_path: FILE,
    content: 'console.log("old")\nconsole.log("new")\n',
  })
  expect(added.context?.[0]).toContain('console.log("new")')
  expect(statuses.at(-1)).toContain('1 debug statement')

  await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'console.log("new")\n',
    new_string: '',
  })
  expect(statuses.at(-1)).toBeUndefined()
})

import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const FILE = '/repo/src/big.ts'

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

/** Stands in for the engine: files live in `files`, reads and toasts are recorded. */
const engine = (on: On, files: Record<string, string>) => {
  const seen = { reads: 0, toasts: [] as string[] }
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    seen.reads += 1
    const content = files[e.path]
    return content === undefined ? { deny: 'ENOENT' } : { value: content }
  })
  return seen
}

test('suggests splitting when an edit grows a file past the limit, toasting only once per file', async ($, on) => {
  const files = { [FILE]: lines(520) }
  const seen = engine(on, files)
  const addLine = () =>
    $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'line 1', new_string: 'line 1\nextra' })

  const first = await addLine()
  expect(first.context?.[0]).toContain('is now 520 lines (limit 500)')
  expect(first.context?.[0]).toContain('splitting')
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('big.ts is 520 lines')

  const second = await addLine()
  expect(second.context).toBeDefined()
  expect(seen.toasts).toHaveLength(1)
})

test('stays quiet for small files, shrinking edits and files that are not code', async ($, on) => {
  const seen = engine(on, { [FILE]: lines(520), '/repo/small.ts': lines(40), '/repo/data.json': lines(900) })

  const small = await $.tool.call({ tool: 'Edit', file_path: '/repo/small.ts', old_string: 'a', new_string: 'a\nb' })
  const shrinking = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a\nb', new_string: 'a' })
  const data = await $.tool.call({ tool: 'Edit', file_path: '/repo/data.json', old_string: 'a', new_string: 'a\nb' })

  expect(small.context).toBeUndefined()
  expect(shrinking.context).toBeUndefined()
  expect(data.context).toBeUndefined()
  expect(seen.toasts).toHaveLength(0)
  expect(seen.reads).toBe(1) // only the growing edit on small.ts had to read the file
})

test('compares a Write with the file it replaces and reads the limit from the options', { options: { maxLines: 100 } }, async ($, on) => {
  const seen = engine(on, { [FILE]: lines(300) })

  const shorter = await $.tool.call({ tool: 'Write', file_path: FILE, content: lines(250) })
  expect(shorter.context).toBeUndefined()

  const longer = await $.tool.call({ tool: 'Write', file_path: FILE, content: lines(320) })
  expect(longer.context?.[0]).toContain('is now 320 lines (limit 100)')

  const created = await $.tool.call({ tool: 'Write', file_path: '/repo/fresh.ts', content: lines(150) })
  expect(created.context?.[0]).toContain('is now 150 lines')
  expect(seen.toasts).toHaveLength(2)
})

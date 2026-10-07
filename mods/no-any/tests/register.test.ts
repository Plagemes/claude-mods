import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const FILE = '/repo/src/user.ts'

/** Stands in for the engine: records which tool calls reach it and which toasts are raised. */
const engine = (on: On, files: Record<string, string> = {}) => {
  const seen = { reached: 0, toasts: [] as string[] }
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const content = files[e.path]
    return content === undefined ? { deny: 'ENOENT' } : { value: content }
  })
  return seen
}


test('in warn mode lets the edit through, tells Claude and toasts', async ($, on) => {
  const seen = engine(on)

  const result = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'const user = load()',
    new_string: 'const user = load() as any',
  })

  expect(seen.reached).toBe(1)
  expect(result.context?.[0]).toContain('added as any')
  expect(seen.toasts[0]).toContain('no-any: as any added to user.ts')
})

test('in block mode refuses the edit before it runs', { options: { mode: 'block' } }, async ($, on) => {
  const seen = engine(on)

  const result = await $.tool.call({
    tool: 'Write',
    file_path: FILE,
    content: 'export const x: any = 1\n// @ts-ignore\nconst y = 2\n',
  })

  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('no-any: blocked')
  expect(result.deny).toContain(': any')
  expect(result.deny).toContain('@ts-ignore')
})

test('recognises every escape hatch', async ($, on) => {
  engine(on)
  const flagged = async (new_string: string) =>
    (await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x', new_string })).context !== undefined

  expect(await flagged('function f(a: any) {}')).toBe(true)
  expect(await flagged('const a = <any>b')).toBe(true)
  expect(await flagged('const m: Record<string, any> = {}')).toBe(true)
  expect(await flagged('const a: Array<any> = []')).toBe(true)
  expect(await flagged('// @ts-ignore')).toBe(true)
  expect(await flagged('// @ts-nocheck')).toBe(true)
  expect(await flagged('/* eslint-disable */')).toBe(true)
  expect(await flagged('// eslint-disable-next-line no-console')).toBe(true)
})

test('leaves alone anything that is not a new any', async ($, on) => {
  engine(on)
  const flagged = async (new_string: string, file_path = FILE) =>
    (await $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string })).context !== undefined

  expect(await flagged('const a: unknown = 1')).toBe(false)
  expect(await flagged('const a: anything = 1')).toBe(false)
  expect(await flagged('const label = "use as any sparingly"')).toBe(false)
  expect(await flagged('const a = 1 // TODO: any better idea?')).toBe(false)
  expect(await flagged('// we avoid `: any` here')).toBe(false)
  expect(await flagged(' * @returns: any value the loader gives')).toBe(false)
  expect(await flagged('const a: any = 1 // no-any: allow, third-party shape')).toBe(false)
  expect(await flagged('const a: any = 1', '/repo/src/user.js')).toBe(false)
})

test('only counts what the edit adds, comparing a Write with the file it replaces', async ($, on) => {
  engine(on, { [FILE]: 'export const old: any = 1\nexport const n = 1\n' })

  const unchanged = await $.tool.call({
    tool: 'Write',
    file_path: FILE,
    content: 'export const old: any = 1\nexport const n = 2\n',
  })
  expect(unchanged.context).toBeUndefined()

  const added = await $.tool.call({
    tool: 'Write',
    file_path: FILE,
    content: 'export const old: any = 1\nexport const more: any = 2\n',
  })
  expect(added.context?.[0]).toContain(': any')
})

test('an escape hatch already on an edited line is not counted as added; a second one is', { options: { mode: 'block' } }, async ($, on) => {
  const seen = engine(on)
  const kept = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'const data = JSON.parse(raw) as any',
    new_string: 'const data = JSON.parse(text) as any',
  })
  expect(kept.deny).toBeUndefined()
  expect(seen.reached).toBe(1)

  const doubled = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'const data = JSON.parse(raw) as any',
    new_string: 'const data = JSON.parse(raw) as any as any',
  })
  expect(doubled.deny).toContain('as any')
})

test('a long run of backslashes after a stray quote does not hang the check', async ($, on) => {
  engine(on)
  const started = Date.now()
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: `// don't ${'\\'.repeat(60)}` })
  expect(Date.now() - started).toBeLessThan(1000)
})

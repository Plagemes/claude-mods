import { test, expect } from 'claude-code/testing'
import type { FsStat, On } from 'claude-code'

import { fakeHub } from './hub'

const file = (size: number): FsStat => ({ kind: 'file', size, mtimeMs: 0, isLink: false })

const answerEngine = (on: On, sizes: Record<string, number>) => {
  on('fs.stat', (_$, e) => {
    const size = sizes[e.path]
    return size === undefined ? { deny: 'ENOENT' } : { value: file(size) }
  })
  on('tool.call', () => ({ result: 'ok' }))
}

test('denies a full read of a file over the size limit and points at offset/limit and Grep', async ($, on) => {
  answerEngine(on, { '/repo/data.csv': 3 * 1024 * 1024 })

  const blocked = await $.tool.call({ tool: 'Read', file_path: '/repo/data.csv' })
  expect(blocked.deny).toContain('big-read-guard')
  expect(blocked.deny).toContain('3.0 MB')
  expect(blocked.deny).toContain('offset and limit')
  expect(blocked.deny).toContain('Grep')
})

test('allows the read when a limit is set, or the file is small', async ($, on) => {
  answerEngine(on, { '/repo/data.csv': 3 * 1024 * 1024, '/repo/small.ts': 4 * 1024 })

  const sliced = await $.tool.call({ tool: 'Read', file_path: '/repo/data.csv', offset: 100, limit: 200 })
  expect(sliced.deny).toBeUndefined()

  const small = await $.tool.call({ tool: 'Read', file_path: '/repo/small.ts' })
  expect(small.deny).toBeUndefined()
})

test('denies minified, bundled and lock files above the small-file floor', async ($, on) => {
  answerEngine(on, {
    '/repo/dist/app.min.js': 80 * 1024,
    '/repo/pnpm-lock.yaml': 120 * 1024,
    '/repo/Cargo.lock': 2 * 1024,
    '/repo/dist/app.js.map': 90 * 1024,
  })

  for (const path of ['/repo/dist/app.min.js', '/repo/pnpm-lock.yaml', '/repo/dist/app.js.map']) {
    const blocked = await $.tool.call({ tool: 'Read', file_path: path })
    expect(blocked.deny).toContain('minified, bundled or lock file')
  }

  const tiny = await $.tool.call({ tool: 'Read', file_path: '/repo/Cargo.lock' })
  expect(tiny.deny).toBeUndefined()
})

test('lets the Read tool report missing files, and skips PDFs and images', async ($, on) => {
  answerEngine(on, { '/repo/manual.pdf': 50 * 1024 * 1024 })

  const missing = await $.tool.call({ tool: 'Read', file_path: '/repo/nope.txt' })
  expect(missing.deny).toBeUndefined()

  const pdf = await $.tool.call({ tool: 'Read', file_path: '/repo/manual.pdf' })
  expect(pdf.deny).toBeUndefined()
})

test('the size limit is configurable', { options: { maxKb: 10 } }, async ($, on) => {
  answerEngine(on, { '/repo/a.txt': 11 * 1024, '/repo/b.txt': 9 * 1024 })

  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })).deny).toContain('10 KB')
  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/b.txt' })).deny).toBeUndefined()
})

test('regression: an offset alone is a bounded read', async ($, on) => {
  answerEngine(on, { '/repo/app.log': 3 * 1024 * 1024 })

  const window = await $.tool.call({ tool: 'Read', file_path: '/repo/app.log', offset: 50_000 })
  expect(window.deny).toBeUndefined()

  const whole = await $.tool.call({ tool: 'Read', file_path: '/repo/app.log' })
  expect(whole.deny).toContain('over the 256 KB limit')
})

test('with mods-hub: says hello and publishes each refusal as risk.blocked (severity low, with the path)', async ($, on) => {
  answerEngine(on, { '/repo/data.csv': 3 * 1024 * 1024, '/repo/pnpm-lock.yaml': 120 * 1024, '/repo/ok.ts': 1024 })
  const hub = fakeHub(on)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['risk.blocked'], consumes: [] }])

  const big = await $.tool.call({ tool: 'Read', file_path: '/repo/data.csv' })
  const lock = await $.tool.call({ tool: 'Read', file_path: '/repo/pnpm-lock.yaml' })
  const fine = await $.tool.call({ tool: 'Read', file_path: '/repo/ok.ts' })
  expect(big.deny).toContain('3.0 MB')
  expect(lock.deny).toContain('lock file')
  expect(fine.deny).toBeUndefined()
  expect(hub.published).toEqual([
    { topic: 'risk.blocked', data: { guard: 'big-read-guard', tool: 'Read', reason: 'over the 256 KB limit for a full read (3.0 MB)', severity: 'low', path: '/repo/data.csv' } },
    { topic: 'risk.blocked', data: { guard: 'big-read-guard', tool: 'Read', reason: 'a minified, bundled or lock file (120 KB)', severity: 'low', path: '/repo/pnpm-lock.yaml' } },
  ])
})

test('without mods-hub the refusal is the same and nothing breaks', async ($, on) => {
  answerEngine(on, { '/repo/data.csv': 3 * 1024 * 1024 })
  const blocked = await $.tool.call({ tool: 'Read', file_path: '/repo/data.csv' })
  expect(blocked.deny).toContain('big-read-guard: /repo/data.csv is 3.0 MB')
})

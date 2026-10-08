import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { biggestChanges, buildToolOf, formatDelta, formatSize, isBuildCommand, leadingCd, normalizeName, snapshotOf } from '../hooks/sizes'
import { fakeHub } from './hub'

const NOW = 1_800_000_000_000
const KB = 1024
const FRESH = NOW + 5_000
const STALE = NOW - 3_600_000

type Disk = Record<string, { size: number; mtimeMs: number }>

/** The project beneath the plugin: a disk of files, gzip answering 30% of the size, a store and a clock. */
const project = (on: On, disk: Disk, build = { fails: false }) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], listed: [] as string[], gzipped: [] as string[] }
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.repo', () => ({ value: { root: '/work/app', remote: null, internal: false, name: null } }))
  on('fs.list', (_$, e) => {
    seen.listed.push(e.path)
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const children = new Map<string, { size: number; mtimeMs: number; isDir: boolean }>()
    for (const [path, file] of Object.entries(disk).filter(([path]) => path.startsWith(prefix))) {
      const [name, ...deeper] = path.slice(prefix.length).split('/')
      if (name !== undefined) children.set(name, { ...file, isDir: deeper.length > 0 })
    }
    if (children.size === 0) return { deny: 'ENOENT' }
    return { value: [...children].map(([name, info]) => ({ name, kind: info.isDir ? ('dir' as const) : ('file' as const), size: info.isDir ? 0 : info.size, mtimeMs: info.isDir ? 0 : info.mtimeMs, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    const path = e.argv.at(-1) ?? ''
    seen.gzipped.push(path)
    return { value: { exitCode: 0, stdout: `${Math.round((disk[path]?.size ?? 0) * 0.3)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => (build.fails ? { isError: true as const, result: 'failed', text: 'Build failed' } : { result: 'built' }))
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, seen }
}

const run = async ($: Engine, clock: MockClock, command = 'npm run build') => {
  const result = await $.tool.call({ tool: 'Bash', command })
  await clock.settle()
  return result
}

const bundle = (main: number, mtimeMs = FRESH): Disk => ({
  '/work/app/dist/assets/index-DgWgUv9n.js': { size: main * KB, mtimeMs },
  '/work/app/dist/assets/style-a81f3c.css': { size: 112 * KB, mtimeMs },
  '/work/app/dist/assets/index-DgWgUv9n.js.map': { size: 900 * KB, mtimeMs },
  '/work/app/dist/index.html': { size: 1 * KB, mtimeMs },
})

test('the first build shows its size in the status line, the next ones show how it changed', async ($, on) => {
  const disk = bundle(300)
  const { clock, seen } = project(on, disk)

  await run($, clock)
  expect(seen.statuses.at(-1)).toBe('📦 413 KB')

  Object.assign(disk, bundle(318))
  await run($, clock)
  expect(seen.statuses.at(-1)).toBe('📦 431 KB (+18 KB)')
  expect(seen.toasts).toHaveLength(0)

  Object.assign(disk, bundle(298))
  await run($, clock)
  expect(seen.statuses.at(-1)).toBe('📦 411 KB (-20 KB)')

  await run($, clock)
  expect(seen.statuses.at(-1)).toBe('📦 411 KB (±0)')
})

test('growth over the threshold raises a toast with the biggest changes and a gzip estimate', async ($, on) => {
  const disk = bundle(300)
  const { clock, seen } = project(on, disk)
  await run($, clock)

  Object.assign(disk, bundle(340))
  await run($, clock)

  expect(seen.statuses.at(-1)).toBe('📦 453 KB (+40 KB)')
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toBe('bundle grew +40 KB (+9.7%) to 453 KB (≈ 136 KB gzipped, largest files). Biggest changes: assets/index-[hash].js +40 KB')
  expect(seen.gzipped).toContain('/work/app/dist/assets/index-DgWgUv9n.js')
  expect(seen.gzipped.some(path => path.endsWith('.map'))).toBe(false)
})

test('the threshold and the gzip estimate are configurable', { options: { growthPercent: 1, gzip: false } }, async ($, on) => {
  const disk = bundle(300)
  const { clock, seen } = project(on, disk)
  await run($, clock)

  Object.assign(disk, bundle(310))
  await run($, clock)

  expect(seen.toasts).toEqual(['bundle grew +10 KB (+2.4%) to 423 KB. Biggest changes: assets/index-[hash].js +10 KB'])
  expect(seen.gzipped).toHaveLength(0)
})

test('a failed build, a watcher and other commands are not measured', async ($, on) => {
  const build = { fails: true }
  const { clock, seen } = project(on, bundle(300), build)

  await run($, clock)
  build.fails = false
  await run($, clock, 'npm run dev')
  await run($, clock, 'npm run build -- --watch')
  await run($, clock, 'ls dist')

  expect(seen.statuses).toHaveLength(0)
  expect(seen.listed).toHaveLength(0)
})

test('the folder the build just wrote to is the one measured; stale output is ignored', async ($, on) => {
  const disk: Disk = {
    '/work/app/dist/old.js': { size: 900 * KB, mtimeMs: STALE },
    '/work/app/build/static/main.3f2a1b.js': { size: 200 * KB, mtimeMs: FRESH },
  }
  const { clock, seen } = project(on, disk)

  await run($, clock)
  expect(seen.statuses.at(-1)).toBe('📦 200 KB')

  delete disk['/work/app/build/static/main.3f2a1b.js']
  disk['/work/app/build/static/main.3f2a1b.js'] = { size: 200 * KB, mtimeMs: STALE }
  seen.statuses.length = 0
  await run($, clock)
  expect(seen.statuses).toHaveLength(0)
})

test('a build in another folder is found through a leading cd', async ($, on) => {
  const { clock, seen } = project(on, { '/work/app/web/dist/app.js': { size: 64 * KB, mtimeMs: FRESH } })

  await run($, clock, 'cd web && pnpm build')

  expect(seen.statuses.at(-1)).toBe('📦 64 KB')
  expect(seen.listed).toContain('/work/app/web/dist')
})

test('which commands are builds', () => {
  for (const command of ['npm run build', 'pnpm build', 'pnpm run build:prod', 'yarn build', 'bun run build', 'npx vite build', 'next build', 'ng build --configuration production', 'webpack --mode production', 'npx webpack', 'bash -c "npm run build"', 'cd web && npm run build 2>&1 | tail']) {
    expect(`${command} => ${isBuildCommand(command)}`).toBe(`${command} => true`)
  }
  for (const command of ['npm run dev', 'npm install webpack', 'npm run build -- --watch', 'webpack serve', 'git commit -m "npm run build"', 'vite', 'npm test', 'next dev']) {
    expect(`${command} => ${isBuildCommand(command)}`).toBe(`${command} => false`)
  }
  expect(leadingCd('cd web && npm run build')).toBe('web')
  expect(leadingCd('cd "my app"; yarn build')).toBe('my app')
  expect(leadingCd('npm run build')).toBeUndefined()
  expect(buildToolOf('sudo -E NODE_ENV=production pnpm build')).toBe('pnpm')
  expect(buildToolOf('npx webpack --mode production')).toBe('npx')
  expect(buildToolOf('vite build && echo done')).toBe('vite')
  expect(leadingCd('cd web')).toBeUndefined()
  expect(leadingCd('echo hi && cd web && npm run build')).toBeUndefined()
})

test('hashed file names are compared across builds, sizes and deltas are printed plainly', () => {
  expect(normalizeName('assets/index-DgWgUv9n.js')).toBe('assets/index-[hash].js')
  expect(normalizeName('static/js/main.3f2a1b9c.chunk.js')).toBe('static/js/main.[hash].chunk.js')
  expect(normalizeName('fonts/Roboto-Regular.woff2')).toBe('fonts/Roboto-Regular.woff2')
  expect(normalizeName('vendor-react.js')).toBe('vendor-react.js')
  expect(formatSize(512)).toBe('512 B')
  expect(formatSize(2.5 * KB)).toBe('2.5 KB')
  expect(formatSize(412 * KB)).toBe('412 KB')
  expect(formatSize(1.5 * KB * KB)).toBe('1.5 MB')
  expect(formatDelta(0)).toBe('±0')
  expect(formatDelta(-3 * KB)).toBe('-3 KB')

  const before = snapshotOf([{ path: 'a-AbCdEf12.js', size: 100 * KB, mtimeMs: 0 }, { path: 'b.css', size: 10 * KB, mtimeMs: 0 }], 'dist', 1)
  const after = snapshotOf([{ path: 'a-ZzYyXx34.js', size: 130 * KB, mtimeMs: 0 }, { path: 'b.css', size: 10 * KB, mtimeMs: 0 }, { path: 'c.js', size: 5 * KB, mtimeMs: 0 }], 'dist', 2)
  expect(biggestChanges(before, after)).toEqual(['a-[hash].js +30 KB', 'c.js +5 KB'])
})

test('with mods-hub: says hello, publishes build.result for every build and sends the growth warning through the hub with the same toast as a fallback', async ($, on) => {
  const disk = bundle(300)
  const build = { fails: false }
  const { clock, seen } = project(on, disk, build)
  const hub = fakeHub(on, {}, clock)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['build.result'], consumes: [] }])

  await run($, clock)
  Object.assign(disk, bundle(340))
  await run($, clock)
  expect(hub.published).toEqual([
    { topic: 'build.result', data: { tool: 'npm', outcome: 'passed', durationMs: 0, command: 'npm run build' } },
    { topic: 'build.result', data: { tool: 'npm', outcome: 'passed', durationMs: 0, command: 'npm run build' } },
  ])
  expect(hub.notified).toHaveLength(1)
  expect(hub.notified[0]).toMatchObject({ level: 'warning' })
  expect(hub.notified[0]?.title).toContain('bundle grew +40 KB')
  expect(seen.toasts).toEqual([])

  hub.published.length = 0
  build.fails = true
  await run($, clock)
  await run($, clock, 'npm run dev')
  expect(hub.published).toEqual([{ topic: 'build.result', data: { tool: 'npm', outcome: 'failed', durationMs: 0, command: 'npm run build' } }])
})

test('without mods-hub the growth warning is the same toast', async ($, on) => {
  const disk = bundle(300)
  const { clock, seen } = project(on, disk)
  await run($, clock)
  Object.assign(disk, bundle(340))
  await run($, clock)
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('bundle grew +40 KB')
})

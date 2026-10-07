import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

type World = {
  /** NUL-separated `git status --porcelain=v1 -z` output; undefined means "not a repository". */
  status?: string
  /** File sizes in bytes by absolute path. */
  sizes?: Record<string, number>
  cwd?: string
}

const MB = 1024 * 1024
const bash = (command: string) => ({ tool: 'Bash', command }) as const
const nul = (...entries: string[]) => `${entries.join('\0')}\0`

/** Stands in for the engine: a repository at /repo with the given status and file sizes. */
function engine(on: On, world: World) {
  const statusCalls: string[][] = []
  on('tool.call', () => ({ result: 'ran' }))
  on('session.repo', () => ({ value: world.status === undefined ? null : { root: '/repo', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: world.cwd ?? '/repo' }))
  on('process.run', (_$, e) => {
    statusCalls.push([...e.argv])
    return {
      value: { exitCode: world.status === undefined ? 128 : 0, stdout: world.status ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.stat', (_$, e) => {
    const size = world.sizes?.[e.path]
    return size === undefined ? { deny: 'no such file' } : { value: { kind: 'file' as const, size, mtimeMs: 0, isLink: false } }
  })
  return { statusCalls }
}

test('git add -A is refused when it would stage node_modules, OS junk, logs or .env, with .gitignore lines', async ($, on) => {
  engine(on, { status: nul('?? node_modules/a/index.js', '?? node_modules/b/index.js', '?? .DS_Store', '?? logs/app.log', '?? .env', ' M src/a.ts') })
  for (const command of ['git add -A', 'git add .', 'git add --all', 'git add -Av', 'cd app && git add * && git commit -m x']) {
    const result = await $.tool.call(bash(command))
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('gitignore-guard')
  }
  const deny = (await $.tool.call(bash('git add -A'))).deny ?? ''
  expect(deny).toContain('node_modules/ (2 files)')
  expect(deny).toContain('.DS_Store (macOS metadata)')
  expect(deny).toContain('Add to .gitignore:')
  for (const line of ['  node_modules/', '  .DS_Store', '  *.log', '  .env']) expect(deny).toContain(line)
})

test('build output is only judged when everything is added; templates and tracked changes never are', async ($, on) => {
  const world: World = { status: nul('?? dist/bundle.js', '?? build/out.o') }
  engine(on, world)
  const everything = (await $.tool.call(bash('git add -A'))).deny ?? ''
  expect(everything).toContain('dist/bundle.js (build output)')
  expect(everything).toContain('  build/')
  expect((await $.tool.call(bash('git add dist/bundle.js'))).deny).toBeUndefined()

  world.status = nul('?? .env.example', '?? src/new.ts', ' M package.json', 'A  README.md', ' D old.txt')
  expect((await $.tool.call(bash('git add -A'))).deny).toBeUndefined()
})

test('refuses files over the size limit that are not ignored', async ($, on) => {
  engine(on, { status: nul('?? data/dump.sql', '?? src/a.ts', ' M assets/video.mp4'), sizes: { '/repo/data/dump.sql': 12 * MB, '/repo/src/a.ts': 2000, '/repo/assets/video.mp4': 6.5 * MB } })
  const deny = (await $.tool.call(bash('git add .'))).deny ?? ''
  expect(deny).toContain('data/dump.sql (12.0 MB)')
  expect(deny).toContain('assets/video.mp4 (6.5 MB)')
  expect(deny).not.toContain('src/a.ts')
  const named = await $.tool.call(bash('git add data/not-there.bin'))
  expect(named.deny).toBeUndefined()
})

test('maxFileMb raises or switches off the size limit', { options: { maxFileMb: 20 } }, async ($, on) => {
  engine(on, { status: nul('?? data/dump.sql'), sizes: { '/repo/data/dump.sql': 12 * MB } })
  expect((await $.tool.call(bash('git add -A'))).deny).toBeUndefined()
})

test('explicit paths: strong junk is refused, ordinary files, -f and dry runs pass', async ($, on) => {
  const { statusCalls } = engine(on, { status: nul() })
  expect((await $.tool.call(bash('git add .env'))).deny).toContain('.env (environment file)')
  expect((await $.tool.call(bash('git add src/a.ts .DS_Store'))).deny).toContain('.DS_Store')
  for (const command of ['git add src/a.ts', 'git add -f node_modules/pkg/index.js', 'git add -n .', 'git add -u', 'git add -p', 'git status', 'git commit -m "add node_modules"']) {
    expect(`${command} => ${(await $.tool.call(bash(command))).deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(statusCalls).toHaveLength(0)
})

test('is silent outside a repository and for a clean tree', async ($, on) => {
  const world: World = { status: undefined }
  engine(on, world)
  expect((await $.tool.call(bash('git add -A'))).deny).toBeUndefined()
  world.status = ''
  expect((await $.tool.call(bash('git add -A'))).deny).toBeUndefined()
})

test('git add . only looks at the working directory subtree', async ($, on) => {
  engine(on, { cwd: '/repo/web', status: nul('?? node_modules/x.js', '?? web/src/a.ts') })
  expect((await $.tool.call(bash('git add .'))).deny).toBeUndefined()
  expect((await $.tool.call(bash('git add -A'))).deny).toContain('node_modules')
})

test('extraPatterns adds your own junk', { options: { extraPatterns: '*.sqlite, coverage/' } }, async ($, on) => {
  engine(on, { status: nul('?? db/dev.sqlite', '?? coverage/lcov.info', '?? src/a.ts') })
  const deny = (await $.tool.call(bash('git add -A'))).deny ?? ''
  expect(deny).toContain('db/dev.sqlite (matches *.sqlite)')
  expect(deny).toContain('  coverage/')
})

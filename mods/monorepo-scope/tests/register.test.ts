import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { packageJsonGlobs, pnpmGlobs, scopeCommand } from '../hooks/workspace'
import type { Package } from '../hooks/workspace'

type World = { executed: string[]; statuses: (string | undefined)[] }

/** A repository on a virtual disk; the bottom `tool.call` records the Bash commands that ran. */
const world = (on: On, files: Record<string, string>): World => {
  const w: World = { executed: [], statuses: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files).filter(file => file.startsWith(prefix))) {
      const [name = '', ...rest] = path.slice(prefix.length).split('/')
      entries.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') w.executed.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return w
}

const PNPM_REPO = {
  '/repo/.git/HEAD': '',
  '/repo/package.json': JSON.stringify({ name: 'root', private: true, scripts: { test: 'turbo run test', lint: 'turbo run lint' } }),
  '/repo/pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - \"packages/*\"\n  - '!**/fixtures/**'\n",
  '/repo/pnpm-lock.yaml': '',
  '/repo/apps/web/package.json': JSON.stringify({ name: '@app/web', scripts: { test: 'vitest run', lint: 'eslint .' } }),
  '/repo/apps/web/src/App.tsx': '',
  '/repo/apps/docs/package.json': JSON.stringify({ name: '@app/docs', scripts: { build: 'next build' } }),
  '/repo/packages/ui/package.json': JSON.stringify({ name: '@app/ui', scripts: { test: 'vitest run' } }),
  '/repo/packages/ui/src/Button.tsx': '',
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const scopePkg = ($: Engine, args = '') =>
  $.command.run({ command: 'scope-pkg', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('follows the package Claude edits and scopes root test and lint runs to it', async ($, on) => {
  const w = world(on, PNPM_REPO)
  await bash($, 'pnpm test')
  expect(w.executed).toEqual(['pnpm test'])

  await edit($, '/repo/apps/web/src/App.tsx')
  expect(w.statuses.at(-1)).toBe('📦 @app/web')
  const ran = await bash($, 'pnpm test -- --reporter=dot')
  expect(w.executed.at(-1)).toBe('pnpm --filter @app/web test -- --reporter=dot')
  expect(ran.context).toEqual([
    "monorepo-scope: ran `pnpm --filter @app/web test -- --reporter=dot` instead of `pnpm test -- --reporter=dot`, scoped to @app/web (apps/web) where the latest edits are. For every package run `pnpm -r test`, or the user can turn this off with /scope-pkg off.",
  ])
  await bash($, 'CI=1 pnpm run lint')
  expect(w.executed.at(-1)).toBe('CI=1 pnpm --filter @app/web run lint')

  for (const untouched of ['pnpm build', 'pnpm -r test', 'pnpm --filter @app/ui test', 'cd apps/web && pnpm test', 'pnpm test | tail -5', 'npx vitest run']) {
    await bash($, untouched)
    expect(w.executed.at(-1)).toBe(untouched)
  }

  await edit($, '/repo/packages/ui/src/Button.tsx')
  expect(w.statuses.at(-1)).toBe('📦 @app/ui')
  await bash($, 'pnpm turbo run test --continue')
  expect(w.executed.at(-1)).toBe('pnpm turbo run test --continue --filter=@app/ui')
})

test('/scope-pkg lists the packages, pins one, and turns scoping off', async ($, on) => {
  const w = world(on, PNPM_REPO)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await scopePkg($)).text).toBe(
    [
      'No package yet: it follows the files Claude edits.',
      'Workspace /repo (pnpm), 3 packages:',
      '  @app/docs  apps/docs',
      '  @app/web  apps/web',
      '  @app/ui  packages/ui',
      '/scope-pkg <name> pins a package · /scope-pkg auto follows edits · /scope-pkg off stops scoping',
    ].join('\n'),
  )
  expect((await scopePkg($, 'ui')).text).toBe('Pinned to @app/ui (packages/ui).')
  expect(w.statuses.at(-1)).toBe('📦 @app/ui (pinned)')
  await edit($, '/repo/apps/web/src/App.tsx')
  await bash($, 'pnpm test')
  expect(w.executed.at(-1)).toBe('pnpm --filter @app/ui test')

  expect((await scopePkg($, 'off')).text).toBe('Scoping is off for this session. /scope-pkg auto turns it back on.')
  expect(w.statuses.at(-1)).toBeUndefined()
  await bash($, 'pnpm test')
  expect(w.executed.at(-1)).toBe('pnpm test')

  await scopePkg($, 'auto')
  await edit($, '/repo/apps/web/src/App.tsx')
  expect(w.statuses.at(-1)).toBe('📦 @app/web')
  expect((await scopePkg($, 'nope')).text).toContain('No package "nope".')
})

test('with autoScope off it runs the command as written and tells Claude the scoped one', { options: { autoScope: false } }, async ($, on) => {
  const w = world(on, PNPM_REPO)
  await edit($, '/repo/apps/web/src/App.tsx')
  const ran = await bash($, 'pnpm test')
  expect(w.executed).toEqual(['pnpm test'])
  expect(ran.context).toEqual(['monorepo-scope: the latest edits are in @app/web (apps/web); `pnpm --filter @app/web test` runs only that package.'])
})

test('reads npm workspaces and stays out of single-package repositories', async ($, on) => {
  const w = world(on, {
    '/repo/.git/HEAD': '',
    '/repo/package.json': JSON.stringify({ workspaces: { packages: ['services/**'] } }),
    '/repo/services/api/package.json': JSON.stringify({ name: 'api', scripts: { test: 'jest' } }),
    '/repo/services/api/src/index.ts': '',
  })
  await edit($, '/repo/services/api/src/index.ts')
  await bash($, 'npm test')
  expect(w.executed.at(-1)).toBe('npm test -w api')
})

test('says when there is no workspace', async ($, on) => {
  const w = world(on, { '/repo/.git/HEAD': '', '/repo/package.json': '{"name":"solo","scripts":{"test":"jest"}}', '/repo/src/a.ts': '' })
  await edit($, '/repo/src/a.ts')
  await bash($, 'npm test')
  expect(w.executed).toEqual(['npm test'])
  expect(w.statuses).toEqual([])
  expect((await scopePkg($)).text).toContain('No monorepo workspace here')
})

test('rewrites each runner its own way', () => {
  const web: Package = { name: '@app/web', dir: 'apps/web', scripts: ['test', 'lint', 'build'], project: 'web' }
  const scoped = new Set(['test', 'lint', 'build', 'typecheck'])
  expect(scopeCommand('yarn test --coverage', web, 'yarn', scoped)?.command).toBe('yarn workspace @app/web test --coverage')
  expect(scopeCommand('bun run lint', web, 'bun', scoped)?.command).toBe('bun run --filter @app/web lint')
  expect(scopeCommand('npm run build', web, 'npm', scoped)?.command).toBe('npm run build -w @app/web')
  expect(scopeCommand('npx turbo test lint', web, 'npm', scoped)?.command).toBe('npx turbo test lint --filter=@app/web')
  expect(scopeCommand('nx test --watch=false', web, 'npm', scoped)?.command).toBe('nx test web --watch=false')
  expect(scopeCommand('npx nx run-many -t lint,test --parallel=3', web, 'npm', scoped)?.command).toBe('npx nx run-many -t lint,test -p web --parallel=3')
  expect(scopeCommand('nx run-many -t test --all', web, 'npm', scoped)).toBeUndefined()
  expect(scopeCommand('turbo run deploy', web, 'pnpm', scoped)).toBeUndefined()
  expect(scopeCommand('pnpm typecheck', web, 'pnpm', scoped)).toBeUndefined()

  expect(pnpmGlobs("packages:\n  - 'apps/*' # apps\n  - packages/**\n  - '!**/test/**'\nonlyBuiltDependencies:\n  - esbuild\n")).toEqual(['apps/*', 'packages/**'])
  expect(packageJsonGlobs({ workspaces: ['a/*', '!a/skip'] })).toEqual(['a/*'])
})

test('a turbo command that does not parse is rejected at once, not after exponential backtracking', () => {
  const pkg: Package = { name: '@app/web', dir: 'apps/web', scripts: ['test'], project: 'web' }
  const started = Date.now()
  expect(scopeCommand(`turbo run ${'a'.repeat(40)}.`, pkg, 'pnpm', new Set(['test']))).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(100)
  expect(scopeCommand('turbo run test lint --force', pkg, 'pnpm', new Set(['test']))).toEqual({ command: 'turbo run test lint --force --filter=@app/web', task: 'test lint' })
})

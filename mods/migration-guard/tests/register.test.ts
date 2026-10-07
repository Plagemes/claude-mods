import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION_STARTED_AT = 1_000_000
const OLD = SESSION_STARTED_AT - 5_000
const NEW = SESSION_STARTED_AT + 5_000

type File = { mtimeMs: number; isTracked?: boolean; realPath?: string }

// Stands for the engine: a small file system, git's idea of what is tracked, and the tool call itself.
const engine = (on: On, files: Record<string, File>) => {
  const reached: string[] = []
  const gitCalls: string[] = []
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.stat', (_$, e) => {
    const file = files[e.path]
    return file === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: 10, mtimeMs: file.mtimeMs, isLink: file.realPath !== undefined, realPath: file.realPath ?? e.path } }
  })
  on('process.run', (_$, e) => {
    const path = e.argv.at(-1) ?? ''
    gitCalls.push(path)
    const exitCode = files[path]?.isTracked === true ? 0 : 1
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: { startedAt: SESSION_STARTED_AT, context: {}, rateLimits: [] } as never }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.call', (_$, e) => {
    reached.push(`${String(e.tool)} ${'file_path' in e ? e.file_path : ''}`)
    return { result: 'ok', text: 'ok' }
  })
  return { reached, gitCalls }
}

const edit = (file_path: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b' })

test('denies editing a migration that is tracked in git', async ($, on) => {
  const path = '/repo/db/migrate/20240101_add_users.rb'
  const { reached } = engine(on, { [path]: { mtimeMs: NEW, isTracked: true } })

  const result = await $.tool.call(edit(path))

  expect(result.deny).toContain('migration-guard: db/migrate/20240101_add_users.rb is an existing migration (tracked in git)')
  expect(result.deny).toContain('create a new migration')
  expect(reached).toHaveLength(0)
})

test('denies an untracked migration that was there before the session, allows one made during it', async ($, on) => {
  const before = '/repo/prisma/migrations/20240101_init/migration.sql'
  const during = '/repo/prisma/migrations/20241001_add_tags/migration.sql'
  const { reached } = engine(on, { [before]: { mtimeMs: OLD }, [during]: { mtimeMs: NEW } })

  expect((await $.tool.call(edit(before))).deny).toContain('it was there before this session started')
  await $.tool.call(edit(during))

  expect(reached).toEqual([`Edit ${during}`])
})

test('creating a new migration is always allowed', async ($, on) => {
  const { reached } = engine(on, {})

  await $.tool.call({ tool: 'Write', file_path: '/repo/alembic/versions/0002_add_orders.py', content: 'revision = "0002"\n' })

  expect(reached).toEqual(['Write /repo/alembic/versions/0002_add_orders.py'])
})

test('Write over an existing migration is denied too, and so is MultiEdit', async ($, on) => {
  const path = '/repo/supabase/migrations/20240101_init.sql'
  const { reached } = engine(on, { [path]: { mtimeMs: OLD, isTracked: true } })

  expect((await $.tool.call({ tool: 'Write', file_path: path, content: 'drop table users;' })).deny).toContain('existing migration')
  expect((await $.tool.call({ tool: 'MultiEdit', file_path: path, edits: [] } as never)).deny).toContain('existing migration')
  expect(reached).toHaveLength(0)
})

test('other files, and lookalike directory names, are not its business', async ($, on) => {
  const files = {
    '/repo/src/app.ts': { mtimeMs: OLD, isTracked: true },
    '/repo/my_migrations/001.py': { mtimeMs: OLD, isTracked: true },
    '/repo/docs/migrations.md': { mtimeMs: OLD, isTracked: true },
  }
  const { reached, gitCalls } = engine(on, files)

  for (const path of Object.keys(files)) await $.tool.call(edit(path))

  expect(reached).toHaveLength(3)
  expect(gitCalls).toHaveLength(0)
})

test('a symbolic link into a migration directory is still a migration', async ($, on) => {
  const link = '/repo/shortcut/001_init.sql'
  const real = '/repo/db/migrate/001_init.sql'
  const { reached } = engine(on, { [link]: { mtimeMs: OLD, realPath: real }, [real]: { mtimeMs: OLD, isTracked: true } })

  const result = await $.tool.call(edit(link))

  expect(result.deny).toContain('existing migration')
  expect(reached).toHaveLength(0)
})

test('allowUncommitted frees untracked migrations but never tracked ones', { options: { allowUncommitted: true, directories: 'migrations' } }, async ($, on) => {
  const draft = '/repo/migrations/0003_draft.py'
  const applied = '/repo/migrations/0001_initial.py'
  const { reached } = engine(on, { [draft]: { mtimeMs: OLD }, [applied]: { mtimeMs: OLD, isTracked: true } })

  await $.tool.call(edit(draft))
  expect((await $.tool.call(edit(applied))).deny).toContain('tracked in git')

  expect(reached).toEqual([`Edit ${draft}`])
})

test('directories can be changed', { options: { directories: 'db/migration, src/main/resources/flyway', allowUncommitted: false } }, async ($, on) => {
  const flyway = '/repo/src/main/resources/db/migration/V1__init.sql'
  const { reached } = engine(on, { [flyway]: { mtimeMs: OLD, isTracked: true }, '/repo/db/migrate/old.rb': { mtimeMs: OLD, isTracked: true } })

  expect((await $.tool.call(edit(flyway))).deny).toContain('existing migration')
  await $.tool.call(edit('/repo/db/migrate/old.rb'))

  expect(reached).toEqual(['Edit /repo/db/migrate/old.rb'])
})

test('fails closed for migration paths when the check itself breaks', async ($, on) => {
  const reached: string[] = []
  on('fs.exists', () => ({ deny: 'file system unavailable' }))
  on('tool.call', (_$, e) => {
    reached.push(String(e.tool))
    return { result: 'ok', text: 'ok' }
  })

  const guarded = await $.tool.call(edit('/repo/db/migrate/001.rb'))
  const unrelated = await $.tool.call(edit('/repo/src/app.ts'))

  expect(guarded.deny).toContain('could not verify /repo/db/migrate/001.rb')
  expect(unrelated.deny).toBeUndefined()
  expect(reached).toEqual(['Edit'])
})

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { leadingDirectory, migrationKind, rotate } from '../hooks/backup'

const NOW = Date.UTC(2026, 9, 7, 15, 4, 5)
const DIR = '/work/app/.claude/db-backups'
const PG_ENV = { '/work/app/.env': 'DATABASE_URL="postgresql://dev:s3cret@localhost:5432/app"\n' }

type Dump = 'ok' | 'fails' | 'missing'

type World = {
  files: Map<string, string>
  runs: { argv: readonly string[]; env: Record<string, string> }[]
  migrations: string[]
  toasts: string[]
}

/** A project folder in memory, a dump tool that writes its file, and an engine whose Bash runs anything. */
const world = (on: On, files: Record<string, string>, dump: Dump = 'ok'): World => {
  const state: World = { files: new Map(Object.entries(files)), runs: [], migrations: [], toasts: [] }
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.read', ($, e) => (state.files.has(e.path) ? { value: state.files.get(e.path) as string } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.write', ($, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } }
  })
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, env: e.init?.env ?? {} })
    const [tool] = e.argv
    const answer = (exitCode: number, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (tool === 'rm') {
      for (const path of e.argv.slice(3)) state.files.delete(path)
      return answer(0)
    }
    if (dump === 'missing') return { deny: `failed to start: ENOENT (${tool})` }
    const target = e.argv.find(arg => arg.startsWith('--file=') || arg.startsWith('--result-file='))?.split('=')[1] ?? /\.backup '(.*)'/.exec(e.argv.join(' '))?.[1]
    if (target !== undefined) state.files.set(target, dump === 'ok' ? 'x'.repeat(2048) : 'partial')
    return dump === 'ok' ? answer(0) : answer(1, 'pg_dump: error: connection to server at "localhost" (127.0.0.1), port 5432 failed: Connection refused\n')
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    state.migrations.push('command' in e ? String(e.command) : String(e.tool))
    return { result: 'migrated' }
  })
  return state
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const DUMP_FILE = `${DIR}/2026-10-07T15-04-05-app.sql.gz`

test('recognises migration commands and leaves look-alikes alone', () => {
  const migrations = [
    'npx prisma migrate dev --name init',
    'pnpm prisma migrate deploy',
    'bin/rails db:migrate',
    'alembic upgrade head',
    'python manage.py migrate',
    'npx knex migrate:latest',
    'php artisan migrate:fresh --seed',
    'goose -dir db postgres "$URL" up',
    'flyway migrate',
    'npx sequelize-cli db:migrate',
    'npm run typeorm migration:run',
    'diesel migration run',
    'bash -c "prisma migrate deploy"',
  ]
  for (const line of migrations) expect(`${line} => ${migrationKind(line, undefined) ?? 'none'}`).not.toContain('=> none')
  const others = [
    'npx prisma migrate dev --create-only',
    'npx prisma migrate status',
    'rails db:migrate:status',
    'alembic upgrade head --sql',
    'python manage.py migrate --plan',
    'php artisan migrate:status',
    'goose status',
    'git commit -m "prisma migrate dev"',
  ]
  for (const line of others) expect(`${line} => ${migrationKind(line, undefined) ?? 'none'}`).toContain('=> none')
  expect(migrationKind('make migrate', /make migrate/)).toBe('custom migration')
  expect(leadingDirectory('cd "api server" && prisma migrate dev')).toBe('api server')
})

test('dumps the local postgres before the migration, then runs it and tells Claude', async ($, on) => {
  const state = world(on, PG_ENV)
  const result = await bash($, 'npx prisma migrate dev --name add_users')

  const [dump] = state.runs
  expect(dump?.argv.slice(0, 6)).toEqual(['pg_dump', '--no-owner', '--no-privileges', '--clean', '--if-exists', '--format=plain'])
  expect(dump?.argv).toContain(`--file=${DUMP_FILE}`)
  expect(dump?.argv).toContain("--dbname=host='localhost' port='5432' dbname='app' user='dev' application_name='claude-mods' connect_timeout='5'")
  expect(dump?.argv.join(' ')).not.toContain('s3cret')
  expect(dump?.env).toEqual({ PGPASSWORD: 's3cret' })

  expect(state.migrations).toEqual(['npx prisma migrate dev --name add_users'])
  expect(result.context?.[0]).toContain('postgres · app @ localhost:5432 was backed up to .claude/db-backups/2026-10-07T15-04-05-app.sql.gz')
  expect(state.toasts[0]).toBe('💾 Backed up postgres · app @ localhost:5432 (2.0 kB) before prisma migrate')
  expect(state.files.get(`${DIR}/.gitignore`)).toContain('*')
  const index = JSON.parse(state.files.get(`${DIR}/index.json`) ?? '{}')
  expect(index.backups[0].file).toBe('2026-10-07T15-04-05-app.sql.gz')
  expect(index.backups[0].restore).toBe(`gunzip -c ${DUMP_FILE} | psql -X -v ON_ERROR_STOP=1 postgresql://dev@localhost:5432/app`)
})

test('a failed dump blocks the migration and removes the partial file', async ($, on) => {
  const state = world(on, PG_ENV, 'fails')
  const result = await bash($, 'python manage.py migrate')
  expect(result.deny).toContain('the backup before this django migrate failed (pg_dump failed: pg_dump: error: connection to server')
  expect(result.deny).toContain('SKIP_DB_BACKUP=1')
  expect(state.migrations).toHaveLength(0)
  expect(state.files.has(DUMP_FILE)).toBe(false)

  expect((await bash($, 'SKIP_DB_BACKUP=1 python manage.py migrate')).deny).toBeUndefined()
  expect(state.migrations).toEqual(['SKIP_DB_BACKUP=1 python manage.py migrate'])
})

test('a missing dump tool or a remote database skips the backup with a toast', async ($, on) => {
  const state = world(on, PG_ENV, 'missing')
  const result = await bash($, 'npx knex migrate:latest')
  expect(result.context?.[0]).toContain('no backup was taken before this migration (pg_dump is not installed or not on PATH)')
  expect(state.toasts[0]).toBe('No backup before knex migrate: pg_dump is not installed or not on PATH')
  expect(state.migrations).toHaveLength(1)

  state.files.set('/work/app/.env', 'DATABASE_URL=postgres://admin:pw@db.prod.example.com/app\n')
  await bash($, 'npx knex migrate:latest')
  expect(state.toasts[1]).toContain('its host is db.prod.example.com, not this machine')
  expect(state.runs.filter(run => run.argv[0] === 'pg_dump')).toHaveLength(1)
})

test('requireBackup blocks a migration that could not be backed up, opt-out or not', { options: { requireBackup: true } }, async ($, on) => {
  const state = world(on, { '/work/app/.env': 'DATABASE_URL=mysql://root@10.0.0.4/shop\n' })
  const result = await bash($, 'SKIP_DB_BACKUP=1 php artisan migrate')
  expect(result.deny).toContain('no backup could be taken (DATABASE_URL was not used: its host is 10.0.0.4, not this machine')
  expect(result.deny).not.toContain('SKIP_DB_BACKUP')
  expect(state.migrations).toHaveLength(0)
})

test('keeps the newest backups only, and backs up SQLite with .backup', { options: { keep: 2 } }, async ($, on) => {
  const old = (file: string, createdAt: number) => ({ file, createdAt, kind: 'sqlite' as const, label: 'old', bytes: 1, migration: 'm', command: 'c', restore: 'r' })
  const state = world(on, {
    '/work/app/prisma/dev.db': 'sqlite',
    [`${DIR}/index.json`]: JSON.stringify({ backups: [old('a.sqlite', 1), old('b.sqlite', 2)] }),
    [`${DIR}/a.sqlite`]: 'a',
    [`${DIR}/b.sqlite`]: 'b',
  })
  await bash($, 'bin/rails db:migrate')
  const sqlite = state.runs.find(run => run.argv[0] === 'sqlite3')
  expect(sqlite?.argv).toEqual(['sqlite3', '/work/app/prisma/dev.db', `.backup '${DIR}/2026-10-07T15-04-05-dev.sqlite'`])
  expect(state.files.has(`${DIR}/a.sqlite`)).toBe(false)
  expect(state.files.has(`${DIR}/b.sqlite`)).toBe(true)
  const index = JSON.parse(state.files.get(`${DIR}/index.json`) ?? '{}')
  expect(index.backups.map((entry: { file: string }) => entry.file)).toEqual(['b.sqlite', '2026-10-07T15-04-05-dev.sqlite'])
  expect(rotate([old('x', 3), old('y', 1)], 1).dropped.map(entry => entry.file)).toEqual(['y'])
})

test('/db-backups lists backups and /db-restore prints the command without running it', async ($, on) => {
  const state = world(on, PG_ENV)
  expect((await command($, 'db-backups')).text).toContain('No database backups yet')
  await bash($, 'npx prisma migrate deploy')
  const runsBefore = state.runs.length

  const listed = (await command($, 'db-backups')).text ?? ''
  expect(listed).toContain(' 1. 2026-10-07 15:04 UTC  postgres · app @ localhost:5432  2.0 kB  before: npx prisma migrate deploy')
  const restore = (await command($, 'db-restore', '1')).text ?? ''
  expect(restore).toContain(`  gunzip -c ${DUMP_FILE} | psql -X -v ON_ERROR_STOP=1 postgresql://dev@localhost:5432/app`)
  expect(restore).toContain('nothing is run for you')
  expect((await command($, 'db-restore', '7')).text).toBe('There is no backup 7: /db-backups lists 1.')
  expect((await command($, 'db-restore', 'last')).text).toContain('Usage: /db-restore <n>')
  expect(state.runs.length).toBe(runsBefore)
})

test('regression: a DATABASE_URL the command sets for itself is the database backed up', async ($, on) => {
  const state = world(on, PG_ENV)
  const result = await bash($, 'DATABASE_URL="postgresql://dev:t3st@localhost:5432/app_test" npx prisma migrate reset --force')
  const [dump] = state.runs
  expect(dump?.argv).toContain("--dbname=host='localhost' port='5432' dbname='app_test' user='dev' application_name='claude-mods' connect_timeout='5'")
  expect(dump?.env).toEqual({ PGPASSWORD: 't3st' })
  expect(result.context?.[0]).toContain('postgres · app_test @ localhost:5432 was backed up')

  // A URL the shell would expand cannot be read here: no backup of some other database instead.
  const skipped = await bash($, 'DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy')
  expect(skipped.context?.[0]).toContain('no backup was taken before this migration (the command sets DATABASE_URL from a shell variable')
  expect(state.runs.filter(run => run.argv[0] === 'pg_dump')).toHaveLength(1)
})

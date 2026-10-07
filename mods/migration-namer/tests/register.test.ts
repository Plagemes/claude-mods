import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildStem, defaultConvention, describeContent, detectConvention, judgeName, parsePrefix } from '../hooks/naming'
import type { Entry } from '../hooks/naming'

const ROOT = '/repo'
const NOW = Date.parse('2026-10-07T12:30:45Z')
const STAMP = '20261007123045'

const trimmed = (path: string): string => path.replace(/\/+$/, '')

/** A project on a virtual disk (file paths; folders follow from them), plus the tool call that reaches the engine. */
const project = (on: On, paths: string[]) => {
  const reached: string[] = []
  const registered: string[] = []
  mock.clock(on, { now: NOW })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', (_$, e) => ({ value: paths.some(path => path === trimmed(e.path) || path.startsWith(`${trimmed(e.path)}/`)) }))
  on('fs.list', (_$, e) => {
    const folder = trimmed(e.path)
    const children = new Map<string, 'file' | 'dir'>()
    for (const path of paths.filter(path => path.startsWith(`${folder}/`))) {
      const [name, ...deeper] = path.slice(folder.length + 1).split('/')
      if (name !== undefined) children.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    return { value: [...children].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', (_$, e) => {
    reached.push('file_path' in e ? String(e.file_path) : String(e.tool))
    return { result: 'ok' }
  })
  return { reached, registered }
}

const write = ($: Engine, file_path: string, content = '') => $.tool.call({ tool: 'Write', file_path, content })
const typed = ($: Engine, args: string) =>
  $.command.run({ command: 'migration-name', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a generic name in a timestamped folder is refused with a timestamped name built from the content', async ($, on) => {
  const { reached } = project(on, [`${ROOT}/db/migrate/20240101120000_create_users.rb`, `${ROOT}/db/migrate/20240215093000_add_email_to_users.rb`])

  const result = await write($, `${ROOT}/db/migrate/migration.sql`, 'CREATE TABLE orders (id bigint primary key);')

  expect(result.deny).toContain('"migration.sql" is too generic and has no timestamp or number in front')
  expect(result.deny).toContain('Migrations in db/migrate follow YYYYMMDDHHMMSS_snake_case, like 20240215093000_add_email_to_users.rb')
  expect(result.deny).toContain(`Write it as /repo/db/migrate/${STAMP}_create_orders_table.sql instead.`)
  expect(reached).toHaveLength(0)
})

test('the suggestion copies a sequence convention and reads Django and Alembic content', async ($, on) => {
  project(on, [`${ROOT}/shop/migrations/0001_initial.py`, `${ROOT}/shop/migrations/0002_add_sku.py`, `${ROOT}/shop/migrations/__init__.py`])

  const result = await write($, `${ROOT}/shop/migrations/temp.py`, "operations = [migrations.CreateModel(name='Invoice', fields=[])]")

  expect(result.deny).toContain('"temp.py" is too generic and has no timestamp or number in front')
  expect(result.deny).toContain('<number>_snake_case')
  expect(result.deny).toContain('/repo/shop/migrations/0003_create_invoice_model.py')
})

test('Prisma folders get a timestamped folder around migration.sql', async ($, on) => {
  const { reached } = project(on, [`${ROOT}/prisma/migrations/20240101000000_init/migration.sql`, `${ROOT}/prisma/migrations/migration_lock.toml`])

  const flat = await write($, `${ROOT}/prisma/migrations/new/migration.sql`, 'ALTER TABLE "users" ADD COLUMN "age" integer;')
  expect(flat.deny).toContain(`/repo/prisma/migrations/${STAMP}_add_age_to_users/migration.sql`)

  await write($, `${ROOT}/prisma/migrations/20260101000000_add_tags/migration.sql`, 'select 1;')
  expect(reached).toEqual([`${ROOT}/prisma/migrations/20260101000000_add_tags/migration.sql`])
})

test('a descriptive name with no number is refused, and without a recognisable change the suggestion has a blank to fill', async ($, on) => {
  project(on, [`${ROOT}/migrations/001_init.sql`])

  const result = await write($, `${ROOT}/migrations/add_users.sql`, 'select 1;')

  expect(result.deny).toContain('"add_users.sql" has no timestamp or sequence number')
  expect(result.deny).toContain('/repo/migrations/002_<what_it_changes>.sql')
  expect(result.deny).toContain('Replace <what_it_changes>')
})

test('good names, existing files and files elsewhere go through untouched', async ($, on) => {
  const { reached } = project(on, [`${ROOT}/db/migrate/20240101120000_create_users.rb`, `${ROOT}/db/migrate/new.rb`])

  await write($, `${ROOT}/db/migrate/20260301101500_add_index_to_orders.rb`)
  await write($, `${ROOT}/db/migrate/new.rb`)
  await write($, `${ROOT}/src/new.sql`)
  await write($, `${ROOT}/docs/migrations/overview.md`)
  await write($, `${ROOT}/app/migrations/__init__.py`)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/db/migrate/migration.sql`, old_string: 'a', new_string: 'b' })

  expect(reached).toHaveLength(6)
})

test('an empty folder starts with a timestamp, or a sequence when configured', async ($, on) => {
  project(on, [])
  expect((await write($, `${ROOT}/db/migrate/update.sql`, 'DROP TABLE legacy;')).deny).toContain(`${STAMP}_drop_legacy_table.sql`)
})

test('an empty folder can start a sequence instead', { options: { defaultStyle: 'sequence', directories: 'sql/changes' } }, async ($, on) => {
  project(on, [])
  const result = await write($, `${ROOT}/sql/changes/new.sql`, 'CREATE INDEX idx_orders_user ON orders (user_id);')
  expect(result.deny).toContain('/repo/sql/changes/0001_add_idx_orders_user_index.sql')
  expect(result.deny).toContain('New migrations should be named <number>_snake_case')
})

test('/migration-name builds a name from the folder it finds', async ($, on) => {
  project(on, [`${ROOT}/db/migrate/20240101120000_create_users.rb`, `${ROOT}/db/migrate/20240215093000_add_email.rb`])

  const result = await typed($, 'Add status to orders')

  expect(result.text).toBe(`${STAMP}_add_status_to_orders.rb\nConvention: YYYYMMDDHHMMSS_snake_case (from db/migrate)`)
})

test('/migration-name falls back to .sql, accepts an extension and explains its usage', async ($, on) => {
  project(on, [])

  expect((await typed($, 'create users table')).text).toContain(`${STAMP}_create_users_table.sql`)
  expect((await typed($, 'create users table .py')).text).toContain(`${STAMP}_create_users_table.py`)
  expect((await typed($, 'create users table')).text).toContain('no migrations folder found here')
  expect((await typed($, '   ')).text).toContain('Usage: /migration-name')
})

test('registers /migration-name when the session starts', async ($, on) => {
  const { registered } = project(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['migration-name'])
})

// ── The naming rules themselves ─────────────────────────────────────────────

const files = (...names: string[]): Entry[] => names.map(name => ({ name, kind: 'file' as const }))

test('names are judged by prefix and by what is left of the description', () => {
  expect(judgeName('20240101120000_add_users')).toEqual([])
  expect(judgeName('0007_auto')).toEqual(['generic'])
  expect(judgeName('20240101120000_')).toEqual(['generic'])
  expect(judgeName('V3__add_orders')).toEqual([])
  expect(judgeName('a1b2c3d4e5f6_add_users')).toEqual([])
  expect(judgeName('2024_01_01_1200-abc_add_users')).toEqual([])
  expect(judgeName('migration')).toEqual(['generic', 'unnumbered'])
  expect(judgeName('AddUsers')).toEqual(['unnumbered'])
  expect(parsePrefix('2024_01_01_120000_create_users_table')?.style).toBe('laravel')
  expect(parsePrefix('1700000000000-AddUsers')?.style).toBe('epoch')
  expect(parsePrefix('0001')?.rest).toBe('')
})

test('conventions are read from the neighbours: Laravel, Flyway, TypeORM, golang-migrate', () => {
  const laravel = detectConvention(files('2024_01_01_000000_create_users_table.php', '2024_02_01_000000_add_x.php'))
  expect(buildStem(laravel!, ['add', 'tags'], NOW)).toBe('2026_10_07_123045_add_tags')

  const flyway = detectConvention(files('V1__init.sql', 'V2__add_orders.sql', 'V10__more.sql'))
  expect(buildStem(flyway!, ['add', 'tags'], NOW)).toBe('V11__add_tags')

  const typeorm = detectConvention(files('1700000000000-CreateUsers.ts', '1710000000000-AddEmail.ts'))
  expect(buildStem(typeorm!, ['add', 'tags'], NOW)).toBe(`${NOW}-AddTags`)

  const migrate = detectConvention(files('000001_init.up.sql', '000001_init.down.sql', '000002_users.up.sql', '000002_users.down.sql'))
  expect(buildStem(migrate!, ['add', 'tags'], NOW)).toBe('000003_add_tags')

  expect(detectConvention(files('README.md', '.gitkeep', 'script.py.mako'))).toBeUndefined()
  expect(buildStem(defaultConvention('timestamp'), ['x'], NOW)).toBe(`${STAMP}_x`)
})

test('the most used style wins over a stray file, and ties go to the newest', () => {
  const mixed = detectConvention(files('20240101120000_a.sql', '20240102120000_b.sql', '20240103120000_c.sql', '0001_old.sql'))
  expect(mixed?.style).toBe('timestamp')
  const tied = detectConvention(files('0001_old.sql', '20240101120000_new.sql'))
  expect(tied?.style).toBe('timestamp')
})

test('the content tells what a migration does in a few words', () => {
  expect(describeContent('ALTER TABLE public.orders ADD COLUMN status text;')?.join('_')).toBe('add_status_to_orders')
  expect(describeContent('alter table orders drop column legacy_id')?.join('_')).toBe('drop_legacy_id_from_orders')
  expect(describeContent('CREATE UNIQUE INDEX CONCURRENTLY idx_u ON users (email)')?.join('_')).toBe('add_idx_u_index')
  expect(describeContent('class X < ActiveRecord::Migration[7.0]\n  def change\n    add_column :users, :age, :integer')?.join('_')).toBe('add_age_to_users')
  expect(describeContent("op.create_table('invoices',")?.join('_')).toBe('create_invoices_table')
  expect(describeContent('exports.up = k => k.schema.createTable("accounts", t => {})')?.join('_')).toBe('create_accounts_table')
  expect(describeContent('SELECT 1')).toBeUndefined()
})

test('Flyway repeatable, undo and callback scripts are not refused', async ($, on) => {
  const folder = `${ROOT}/src/main/resources/db/migration`
  const { reached } = project(on, [`${folder}/V1__init.sql`, `${folder}/V2__add_orders.sql`])
  for (const name of ['R__create_views.sql', 'U2__drop_orders.sql', 'afterMigrate.sql', 'beforeEachMigrate__grants.sql']) {
    expect((await write($, `${folder}/${name}`, 'select 1;')).deny).toBeUndefined()
  }
  expect(reached).toHaveLength(4)
  expect((await write($, `${folder}/views.sql`, 'select 1;')).deny).toContain('V3__')
})

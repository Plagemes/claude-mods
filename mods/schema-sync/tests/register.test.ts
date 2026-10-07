import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { generateError, matchesSchema, parseDrizzleConfig, schemaChanges } from '../hooks/schema'

const PLUGIN = 'schema-sync'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const

const PRISMA_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id    Int @id @default(autoincrement())
  total Int
}
`

const DRIZZLE_SCHEMA = `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name'),
})
`

const VALIDATION_ERROR = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Error: Prisma schema validation - (get-dmmf wasm)',
  'Error code: P1012',
  'error: Type "Strng" is neither a built-in type, nor refers to another model, composite type, or enum.',
  '  -->  prisma/schema.prisma:9',
  '   | ',
  ' 8 |   total Int',
  ' 9 |   note  Strng',
  '',
  'Validation Error Count: 1',
].join('\n')

type World = {
  files: Record<string, string>
  runs: { argv: readonly string[]; cwd: string | undefined }[]
  statuses: (string | undefined)[]
  toasts: string[]
  submitted: string[]
  clock: ReturnType<typeof mock.clock>
  generate: { exitCode: number; stderr: string }
}

/** A project on a virtual disk; the bottom `tool.call` applies edits, and `prisma migrate dev` / `drizzle-kit generate` add a migration. */
const world = (on: On, files: Record<string, string>): World => {
  const w: World = { files, runs: [], statuses: [], toasts: [], submitted: [], clock: mock.clock(on), generate: { exitCode: 0, stderr: '' } }
  const isDir = (path: string) => Object.keys(w.files).some(file => file.startsWith(`${path}/`))
  on('fs.exists', ($, e) => ({ value: e.path in w.files || isDir(e.path) }))
  on('fs.read', ($, e) => (e.path in w.files ? { value: w.files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const names = new Set(Object.keys(w.files).filter(file => file.startsWith(`${e.path}/`)).map(file => file.slice(e.path.length + 1).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { stdout: '', ...w.generate, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') w.files[e.file_path] = e.content
    if (e.tool === 'Edit') w.files[e.file_path] = (w.files[e.file_path] ?? '').replace(e.old_string, e.new_string)
    if (e.tool === 'Bash' && /prisma migrate dev/.test(e.command)) w.files['/app/prisma/migrations/20261007_add_status/migration.sql'] = 'ALTER TABLE ...'
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  return w
}

const PRISMA_APP = {
  '/app/.git/HEAD': '',
  '/app/package.json': '{}',
  '/app/node_modules/.bin/prisma': '',
  '/app/prisma/schema.prisma': PRISMA_SCHEMA,
  '/app/prisma/migrations/20240101_init/migration.sql': 'CREATE TABLE "Order" ...',
}

const editSchema = ($: Engine, old_string: string, new_string: string) =>
  $.tool.call({ tool: 'Edit', file_path: '/app/prisma/schema.prisma', old_string, new_string })
const mountBand = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })

test('regenerates the Prisma client and warns when the schema changed without a migration', async ($, on) => {
  const w = world(on, { ...PRISMA_APP })
  await editSchema($, '  total Int\n', '  total Int\n  status String @default("new")\n')
  await w.clock.advance(1999)
  expect(w.runs).toEqual([])
  await w.clock.advance(1)

  expect(w.runs).toEqual([{ argv: ['/app/node_modules/.bin/prisma', 'generate'], cwd: '/app' }])
  expect(w.statuses).toEqual(['⧗ prisma generate…', '⚠ Prisma schema changed without a migration'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await mountBand($, surface)
    expect((await band.find({ key: 'ss-missing' }))?.text).toContain('Order (changed)')
    expect(await band.find({ key: 'ss-fix' })).toBeUndefined()
    await band.unmount()
  }

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'ss-migrate' })
  expect(w.submitted.at(-1)).toContain('The Prisma schema (prisma/schema.prisma in /app) changed without a migration: Order (changed).')
  expect(w.submitted.at(-1)).toContain('npx prisma migrate dev --name <short_descriptive_name>')
  expect(await band.find({ key: 'ss-missing' })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npx prisma migrate dev --name add_status' })
  await w.clock.advance(2000)
  expect(w.statuses.at(-1)).toBe('✓ prisma client regenerated')
  await w.clock.advance(6000)
  expect(w.statuses.at(-1)).toBeUndefined()

  await editSchema($, 'model Order {', '/// An order a customer placed.\nmodel Order {')
  await w.clock.advance(2000)
  expect(w.statuses.at(-1)).toBe('✓ prisma client regenerated')
})

test('a failed generate shows its error and can go to Claude', async ($, on) => {
  const w = world(on, { ...PRISMA_APP })
  w.generate = { exitCode: 1, stderr: VALIDATION_ERROR }
  await editSchema($, '  total Int\n', '  total Int\n  note  Strng\n')
  await w.clock.advance(2000)

  const error = 'error: Type "Strng" is neither a built-in type, nor refers to another model, composite type, or enum. -->  prisma/schema.prisma:9'
  expect(w.toasts).toEqual([`prisma generate failed: ${error}`])
  expect(w.statuses.at(-1)).toBe('✗ prisma generate failed')
  const band = await mountBand($, 'desktop')
  expect((await band.find({ key: 'ss-generate' }))?.text).toContain('Strng')
  await band.press({ key: 'ss-fix' })
  expect(w.submitted.at(-1)).toBe(`\`prisma generate\` fails after the schema edit (prisma/schema.prisma in /app):\n\n${error}\n\nFix the schema so the client generates.`)
})

test('watches the Drizzle schema its config names; a push counts as in step', async ($, on) => {
  const w = world(on, {
    '/web/.git/HEAD': '',
    '/web/package.json': '{}',
    '/web/drizzle.config.ts': "export default defineConfig({\n  dialect: 'postgresql',\n  schema: './src/db/schema/*.ts',\n  out: './drizzle',\n})\n",
    '/web/src/db/schema/users.ts': DRIZZLE_SCHEMA,
    '/web/src/db/client.ts': 'export const db = drizzle(pool)\n',
    '/web/drizzle/0000_init.sql': 'CREATE TABLE users ...',
  })
  await $.tool.call({ tool: 'Edit', file_path: '/web/src/db/client.ts', old_string: 'pool', new_string: 'pool, { schema }' })
  await $.tool.call({ tool: 'Edit', file_path: '/web/src/db/schema/users.ts', old_string: "  name: text('name'),\n", new_string: "  name: text('name'),\n  email: text('email').notNull(),\n" })
  await w.clock.advance(2000)
  expect(w.runs).toEqual([])
  expect(w.statuses.at(-1)).toBe('⚠ Drizzle schema changed without a migration')
  const band = await mountBand($, 'terminal')
  expect((await band.find({ key: 'ss-missing' }))?.text).toContain('users (changed)')

  await $.tool.call({ tool: 'Bash', command: 'npx drizzle-kit push' })
  await w.clock.advance(2000)
  expect(await band.find({ key: 'ss-missing' })).toBeUndefined()
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('without a migrations folder it only regenerates the client', { options: { debounceSeconds: 1 } }, async ($, on) => {
  const w = world(on, { '/app/package.json': '{}', '/app/prisma/schema.prisma': PRISMA_SCHEMA })
  await editSchema($, '  total Int\n', '  total Int\n  paid Boolean\n')
  await w.clock.advance(1000)
  expect(w.runs.map(run => run.argv)).toEqual([['npx', '--no-install', 'prisma', 'generate']])
  expect(w.statuses.at(-1)).toBe('✓ prisma client regenerated')
})

test('reads schema changes, Drizzle configs and generate errors', () => {
  const after = PRISMA_SCHEMA.replace('  total Int\n', '  total  Int // in cents\n').concat('\nmodel Invoice {\n  id Int @id\n}\n')
  expect(schemaChanges('prisma', PRISMA_SCHEMA, after)).toEqual(['Invoice (new)'])
  expect(schemaChanges('prisma', after, PRISMA_SCHEMA)).toEqual(['Invoice (removed)'])
  expect(schemaChanges('prisma', PRISMA_SCHEMA, PRISMA_SCHEMA.replace('postgresql', 'mysql'))).toEqual(['schema (changed)'])
  expect(schemaChanges('drizzle', DRIZZLE_SCHEMA, `${DRIZZLE_SCHEMA}\nexport const posts = pgTable('posts', { id: serial('id') })\n`)).toEqual(['posts (new)'])

  expect(parseDrizzleConfig("export default { schema: ['./src/a.ts', './src/b.ts'], out: './migrations' }")).toEqual({ schema: ['./src/a.ts', './src/b.ts'], out: './migrations' })
  expect(parseDrizzleConfig('export default { schema: "./db/schema.ts" }')).toEqual({ schema: ['./db/schema.ts'], out: './drizzle' })
  expect(matchesSchema('/web/src/**/schema.ts', '/web/src/db/schema.ts')).toBe(true)
  expect(matchesSchema('/web/src/db', '/web/src/db/users.ts')).toBe(true)
  expect(matchesSchema('/web/src/db/*.ts', '/web/src/db/sub/users.ts')).toBe(false)
  expect(generateError('Error: Could not find Prisma Schema that is required for this command.\n')).toBe('Error: Could not find Prisma Schema that is required for this command.')
})

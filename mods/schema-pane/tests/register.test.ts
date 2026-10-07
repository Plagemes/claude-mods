import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RECORD, UNIT, parseRows } from '../hooks/client'
import { environmentRisk, parseEnv, resolveUrl } from '../hooks/db'
import { buildTables, compactSchema } from '../hooks/schema'

const PLUGIN = 'schema-pane'
const PANE_PROPS = {
  title: 'Schema',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const row = (...fields: string[]) => fields.join(UNIT)
/** What psql prints for the schema queries: rows joined by RECORD, each command's output ending in a newline. */
const PSQL_OUTPUT = [
  [
    row('C', 'public', 'orgs', 'id', 'integer', 'NO', "nextval('orgs_id_seq'::regclass)"),
    row('C', 'public', 'orgs', 'name', 'text', 'NO', ''),
    row('C', 'public', 'users', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
    row('C', 'public', 'users', 'email', 'character varying(255)', 'NO', ''),
    row('C', 'public', 'users', 'org_id', 'integer', 'YES', ''),
    row('C', 'billing', 'invoices', 'id', 'bigint', 'NO', ''),
  ].join(RECORD),
  [
    row('K', 'public', 'orgs', 'id', 'PRIMARY KEY', '', '', ''),
    row('K', 'public', 'orgs', 'name', 'UNIQUE', '', '', ''),
    row('K', 'public', 'users', 'id', 'PRIMARY KEY', '', '', ''),
    row('K', 'public', 'users', 'org_id', 'FOREIGN KEY', 'public', 'orgs', 'id'),
  ].join(RECORD),
  [
    row('I', 'public', 'users', 'users_pkey', 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'),
    row('I', 'public', 'users', 'users_org_idx', 'CREATE INDEX users_org_idx ON public.users USING btree (org_id)'),
  ].join(RECORD),
]
  .map(chunk => `${chunk}\n`)
  .join('')

type World = { runs: { argv: readonly string[]; env: Record<string, string>; stdin: string | undefined }[]; fills: string[]; opened: string[] }

const world = (on: On, files: Record<string, string>, env: Record<string, string> = {}, output: string | Error = PSQL_OUTPUT): World => {
  const state: World = { runs: [], fills: [], opened: [] }
  mock.env(on, env)
  mock.clock(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] as string } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, env: e.init?.env ?? {}, stdin: e.init?.stdin })
    if (output instanceof Error) return { deny: output.message }
    return { value: { exitCode: 0, stdout: output, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', ($, e) => {
    state.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', ($, e) => {
    state.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return state
}

const schema = ($: Engine, args = '') =>
  $.command.run({ command: 'schema', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'schema', props: PANE_PROPS })

const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

const LOCAL_ENV = { '/work/app/.env': 'DATABASE_URL="postgres://dev:s3cret@localhost:5432/app?schema=public"\n' }

test('only local databases are accepted', () => {
  const local = ['postgres://u:p@localhost:5432/app', 'postgresql://u@127.0.0.1/app', 'postgres://u@[::1]/app', 'postgres:///app', 'postgres://u@/app?host=/var/run/postgresql', 'mysql://root@localhost/shop', 'file:./dev.db', 'sqlite:////srv/data.db']
  for (const url of local) expect(`${url} ${resolveUrl(url, '/work/app').ok}`).toBe(`${url} true`)
  const remote = ['postgres://u:p@db.example.com/app', 'postgres://u@localhost.evil.io/app', 'postgres://u@localhost/app?host=10.1.2.3', 'postgres://u@localhost/app?hostaddr=10.1.2.3', 'postgres://u@localhost/app?service=prod', 'mysql://root@192.168.1.4/shop', 'postgres://a,b/app', 'mongodb://localhost/x']
  for (const url of remote) expect(`${url} ${resolveUrl(url, '/work/app').ok}`).toBe(`${url} false`)

  const target = resolveUrl('postgres:///app', '/work/app')
  if (!target.ok || !('target' in target)) throw new Error('expected a server target')
  expect(environmentRisk(target.target, { PGHOST: 'prod.example.com' })).toContain('PGHOST')
  expect(environmentRisk(target.target, { PGHOST: '/tmp' })).toBeUndefined()
  expect(parseEnv('export A="x" # note\nB=${A}/y\nC=plain # comment').get('B')).toBe('x/y')
})

test('/schema reads a local postgres read-only and lists tables, keys and indexes', async ($, on) => {
  const state = world(on, LOCAL_ENV)
  expect((await schema($)).text).toBe('Schema of postgres · app @ localhost:5432 (from .env): 3 tables.')
  expect(state.opened).toEqual(['schema'])

  const [run] = state.runs
  expect(run?.argv[0]).toBe('psql')
  expect(run?.argv).toContain('SET default_transaction_read_only = on')
  expect(run?.argv.join(' ')).toContain("host='localhost' port='5432' dbname='app' user='dev'")
  expect(run?.argv.join(' ')).not.toContain('s3cret')
  expect(run?.env).toEqual({ PGPASSWORD: 's3cret' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'table:users' }))?.text).toContain('3 cols · 1 idx')
    expect(await ui.find({ key: 'column:users.org_id' })).toBeUndefined()
    await ui.press({ key: 'toggle:users' })
    const fk = await ui.find({ key: 'column:users.org_id' })
    expect(fk?.text).toContain('integer')
    expect(fk?.text).toContain('→ orgs.id')
    expect((await ui.find({ key: 'column:users.id' }))?.text).toContain('PK')
    expect((await ui.find({ key: 'index:users:INDEX users_org_idx (org_id)' }))?.text).toBe('INDEX users_org_idx (org_id)')
    await ui.press({ key: 'toggle:users' })
    await ui.unmount()
  }
})

test('Send to Claude fills the prompt with the shown tables; Inject adds them to the system prompt', async ($, on) => {
  const state = world(on, LOCAL_ENV)
  await schema($)
  const ui = await mountPane($, 'terminal')
  await ui.input({ key: 'filter', text: 'org', kind: 'change' })
  expect((await ui.find({ key: 'title' }))?.text).toContain('1 of 3 tables')
  await ui.press({ key: 'send' })
  expect(state.fills[0]).toContain('Database schema (postgres · app @ localhost:5432), 1 table:')
  expect(state.fills[0]).toContain('orgs(id integer PK default autoincrement, name text NOT NULL UNIQUE)')
  expect(state.fills[0]).not.toContain('users(')

  expect((await compose($)).sections.map(section => section.id)).toEqual(['intro'])
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  await ui.press({ key: 'inject' })
  expect((await ui.find({ key: 'injected' }))?.text).toMatch(/Claude sees 3 tables in its context \(~0\.\dk of 6k chars\)/)
  const sections = (await compose($)).sections
  const injected = sections.find(section => section.id === 'schema-pane:schema')
  expect(injected?.scope).toBe('session')
  expect(injected?.text).toContain('users(id uuid PK default gen_random_uuid(), email varchar(255) NOT NULL, org_id integer → orgs.id)')
  expect(injected?.text).toContain('billing.invoices(id bigint NOT NULL)')
})

test('the pane draws without a filter field on mobile', async ($, on) => {
  world(on, LOCAL_ENV)
  await schema($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', requestId: 'schema', props: PANE_PROPS })
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  expect((await ui.find({ key: 'table:orgs' }))?.text).toContain('2 cols')
})

test('a remote DATABASE_URL is refused without running any client', async ($, on) => {
  const state = world(on, { '/work/app/.env': 'DATABASE_URL=postgres://admin:pw@db.prod.example.com:5432/app\n' })
  const result = await schema($)
  expect(result.text).toContain('its host is db.prod.example.com, not this machine')
  expect(state.runs).toHaveLength(0)
  expect(state.opened).toHaveLength(0)
})

test('the environment wins over .env, and a PGHOSTADDR pointing away is refused', async ($, on) => {
  const state = world(on, LOCAL_ENV, { DATABASE_URL: 'postgres://dev@localhost/other', PGHOSTADDR: '10.0.0.9' })
  expect((await schema($)).text).toContain('Refused: PGHOSTADDR=10.0.0.9 is set in the environment')
  expect(state.runs).toHaveLength(0)
})

test('falls back to a framework SQLite file and reads it with sqlite3 -readonly', async ($, on) => {
  const output = [row('C', '', 'posts', 'id', 'INTEGER', 'YES', ''), row('K', '', 'posts', 'id', 'PRIMARY KEY', '', '', '')].join(RECORD) + RECORD
  const state = world(on, { '/work/app/prisma/dev.db': '' }, {}, output)
  expect((await schema($)).text).toBe('Schema of sqlite · /work/app/prisma/dev.db (from prisma/dev.db, no DATABASE_URL set): 1 table.')
  expect(state.runs[0]?.argv.slice(0, 2)).toEqual(['sqlite3', '-readonly'])
  expect(state.runs[0]?.stdin).toContain('pragma_table_info')
})

test('a missing client is reported in the pane', async ($, on) => {
  world(on, LOCAL_ENV, {}, new Error('failed to start: ENOENT'))
  expect((await schema($)).text).toContain('psql is not installed or not on PATH')
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'error' }))?.text).toContain('psql is not installed')
})

test('compact schema text stays within its budget at a table boundary', () => {
  const tables = buildTables('postgres', parseRows('postgres', PSQL_OUTPUT))
  const text = compactSchema('pg', tables, 120)
  expect(text.split('\n')[0]).toBe('Database schema (pg), 3 tables:')
  expect(text).toContain('… 2 more tables not shown.')
  expect(text.length).toBeLessThan(200)
})

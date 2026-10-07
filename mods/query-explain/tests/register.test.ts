import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RECORD, UNIT } from '../hooks/client'
import { checkStatement, findings, planText, referencedTables } from '../hooks/sql'

const PLUGIN = 'query-explain'
const PANE_PROPS = {
  title: 'Query plan',
  isFocused: true,
  bodyColumns: 110,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 50 },
  view: {},
} as const
const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const EXPLANATION = '**In short**: Postgres reads all of `users`.\n\n**Suggestions**:\n- `CREATE INDEX users_role_idx ON users (role);`'
const PG_PLAN = [
  'Sort  (cost=114.28..114.29 rows=1 width=24)',
  '  ->  Seq Scan on users u  (cost=0.00..109.50 rows=1 width=22)',
  "        Filter: (role = 'admin'::text)",
].join(RECORD)
const PG_CONTEXT = [
  ['I', 'public', 'users', 'users_pkey', 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'].join(UNIT),
  ['S', 'users', '5000'].join(UNIT),
].join(RECORD)

type World = {
  runs: { argv: readonly string[]; env: Record<string, string> }[]
  prompts: { system: string; prompt: string }[]
  fills: string[]
  clock: ReturnType<typeof mock.clock>
}

type Answer = { exitCode: number; stdout: string; stderr?: string }
/** A model reply that makes `$.model.complete` reject instead of answering. */
const REJECT = 'REJECT'

const world = (on: On, files: Record<string, string>, answers: Answer[], modelReply: string | null = EXPLANATION): World => {
  const state: World = { runs: [], prompts: [], fills: [], clock: mock.clock(on) }
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] as string } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, env: e.init?.env ?? {} })
    const answer = answers[state.runs.length - 1] ?? { exitCode: 0, stdout: '' }
    return { value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    state.prompts.push({ system: e.system ?? '', prompt: e.prompt })
    if (modelReply === REJECT) return { deny: 'network down' }
    return modelReply === null
      ? { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' as const, usage: USAGE } }
      : { value: { isAnswered: true, text: modelReply, usage: USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.selection', () => ({ value: { text: "select * from orders where status = 'open'" } }))
  on('prompt.fill', ($, e) => {
    state.fills.push(e.text)
    return { isFilled: true }
  })
  return state
}

const explainQuery = ($: Engine, args: string) =>
  $.command.run({ command: 'explain-query', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'query-plan', props: PANE_PROPS })

const PG_ENV = { '/work/app/.env': 'DATABASE_URL=postgres://dev:pw@localhost:5432/app\n' }
const QUERY = "select u.email from users u where u.role = 'admin' order by u.created_at desc;"

test('accepts exactly one statement, strips EXPLAIN and knows which queries only read', () => {
  expect(checkStatement('select a from t; ', 'postgres')).toEqual({ ok: true, sql: 'select a from t', isRead: true })
  expect(checkStatement('```sql\nEXPLAIN ANALYZE SELECT * FROM t;\n```', 'postgres')).toEqual({ ok: true, sql: 'SELECT * FROM t', isRead: true })
  for (const sql of ['select 1; drop table users', "select ';' from t", "select 'C:\\' ; commit; drop table t; --'", 'select $$;$$', '']) {
    expect(checkStatement(sql, 'postgres').ok).toBe(false)
  }
  expect(checkStatement('\\! rm -rf /', 'postgres').ok).toBe(false)
  expect(checkStatement("select * from t where a like '%\\_%'", 'mysql').ok).toBe(false)
  expect(checkStatement("select *\n-- note\nfrom t # tail\nwhere s = 'a\nb'\nlimit 1", 'mysql')).toEqual({ ok: true, sql: "select * from t where s = 'a\nb' limit 1", isRead: true })
  const reads = (sql: string) => {
    const checked = checkStatement(sql, 'postgres')
    return checked.ok && checked.isRead
  }
  expect(reads('with recent as (select * from orders) select * from recent')).toBe(true)
  expect(reads("select replace(name, 'a', 'b') from users")).toBe(true)
  expect(reads("select 'delete' as word from users -- update")).toBe(true)
  expect(reads('with gone as (delete from orders returning *) select * from gone')).toBe(false)
  expect(reads('select * from jobs for update skip locked')).toBe(false)
  expect(reads('select * into backup from users')).toBe(false)
  expect(reads('update users set role = 1')).toBe(false)
  expect(referencedTables('select * from public.users u join "orgs" o on true left join lateral (select 1) x on true')).toEqual(['users', 'orgs'])
})

test('/explain-query runs EXPLAIN on the local postgres and explains the plan', async ($, on) => {
  const state = world(on, PG_ENV, [{ exitCode: 0, stdout: `${PG_PLAN}\n` }, { exitCode: 0, stdout: `${PG_CONTEXT}\n` }])
  const result = await explainQuery($, QUERY)

  expect(result.text).toBe('EXPLAIN on postgres · app @ localhost:5432: Sequential scan on users (~5,000 rows in the table). The explanation is coming in the Query plan pane.')
  expect(result.context?.[0]).toContain('Seq Scan on users u')
  const [explainRun, lookupRun] = state.runs
  expect(explainRun?.argv).toContain("EXPLAIN select u.email from users u where u.role = 'admin' order by u.created_at desc")
  expect(explainRun?.argv).toContain('SET default_transaction_read_only = on')
  expect(explainRun?.env).toEqual({ PGPASSWORD: 'pw' })
  expect(lookupRun?.argv.join(' ')).toContain("tablename IN ('users')")

  await state.clock.settle()
  expect(state.prompts[0]?.prompt).toContain('Existing indexes on these tables:')
  expect(state.prompts[0]?.prompt).toContain('CREATE UNIQUE INDEX users_pkey')
  expect(state.prompts[0]?.prompt).toContain('users ~5,000 rows')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'title' }))?.text).toContain('EXPLAIN · postgres · app @ localhost:5432')
    expect((await ui.find({ key: 'finding:0' }))?.text).toBe('⚠ Sequential scan on users (~5,000 rows in the table)')
    expect((await ui.find({ key: 'plan' }))?.text).toContain('Seq Scan on users u')
    expect((await ui.find({ key: 'explanation' }))?.text).toContain('CREATE INDEX users_role_idx')
    await ui.unmount()
  }
})

test('with analyze on, only read queries run under EXPLAIN ANALYZE', { options: { analyze: true } }, async ($, on) => {
  const state = world(on, PG_ENV, [{ exitCode: 0, stdout: 'x\n' }, { exitCode: 0, stdout: '' }, { exitCode: 0, stdout: 'y\n' }])
  await explainQuery($, 'select * from users')
  expect(state.runs[0]?.argv).toContain('EXPLAIN (ANALYZE, BUFFERS) select * from users')
  expect(state.runs[0]?.argv).toContain("SET statement_timeout = '60s'")

  await explainQuery($, 'delete from users where id = 1')
  const last = state.runs.at(-2)?.argv ?? []
  expect(last).toContain('EXPLAIN delete from users where id = 1')
  expect(last.join(' ')).not.toContain('ANALYZE')
})

test('a remote database is refused before anything runs', async ($, on) => {
  const state = world(on, { '/work/app/.env': 'DATABASE_URL=mysql://root:pw@db.internal:3306/shop\n' }, [])
  expect((await explainQuery($, 'select 1')).text).toContain('its host is db.internal, not this machine')
  expect(state.runs).toHaveLength(0)
})

test('a second statement is refused before anything runs', async ($, on) => {
  const state = world(on, PG_ENV, [])
  expect((await explainQuery($, 'select 1; delete from users')).text).toContain("The query holds a ';'")
  expect(state.runs).toHaveLength(0)
})

test('with no argument it explains the selected query; MySQL falls back to the JSON format', async ($, on) => {
  const json = '{\\n  "query_block": {\\n    "table": {\\n      "table_name": "orders",\\n      "access_type": "ALL"\\n    }\\n  }\\n}\n'
  const state = world(on, { '/work/app/.env': 'DATABASE_URL="mysql://root:pw@127.0.0.1:3306/shop"\n' }, [
    { exitCode: 1, stdout: '', stderr: "ERROR 1064 (42000): You have an error in your SQL syntax near 'FORMAT=TREE'" },
    { exitCode: 0, stdout: json },
  ])
  const result = await explainQuery($, '')
  expect(result.text).toContain('Full table scan on orders')
  expect(state.runs[0]?.argv).toContain("SET SESSION TRANSACTION READ ONLY;\nEXPLAIN FORMAT=TREE select * from orders where status = 'open'")
  expect(state.runs[0]?.argv).toContain('--no-defaults')
  expect(state.runs[0]?.env).toEqual({ MYSQL_PWD: 'pw' })
  expect(state.runs[1]?.argv.join(' ')).toContain('EXPLAIN FORMAT=JSON select')
})

test('a model failure is shown, and Ask Claude prepares an optimisation prompt', async ($, on) => {
  const state = world(on, PG_ENV, [{ exitCode: 0, stdout: `${PG_PLAN}\n` }, { exitCode: 0, stdout: '' }], null)
  await explainQuery($, QUERY)
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toBe('No explanation: the API answered 529 (overloaded).')
  await ui.press({ key: 'ask' })
  expect(state.fills[0]).toContain("select u.email from users u where u.role = 'admin'")
  expect(state.fills[0]).toContain('Seq Scan on users u')
})

test('a model call that rejects ends the explaining phase with the reason', async ($, on) => {
  const state = world(on, PG_ENV, [{ exitCode: 0, stdout: `${PG_PLAN}\n` }, { exitCode: 0, stdout: '' }], REJECT)
  await explainQuery($, QUERY)
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toContain('No explanation:')
  expect((await ui.find({ key: 'error' }))?.text).toContain('network down')
})

test('a database error lands in the pane', async ($, on) => {
  world(on, PG_ENV, [{ exitCode: 1, stdout: '', stderr: 'ERROR:  relation "userz" does not exist\nLINE 1: EXPLAIN select * from userz\n' }])
  expect((await explainQuery($, 'select * from userz')).text).toBe('ERROR:  relation "userz" does not exist')
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'error' }))?.text).toContain('relation "userz" does not exist')
})

test('reads SQLite and MySQL tree plans', () => {
  const sqlite = planText('sqlite', ['2', '0', '0', 'SCAN orders'].join(UNIT) + RECORD + ['5', '0', '0', 'USE TEMP B-TREE FOR ORDER BY'].join(UNIT) + RECORD)
  expect(sqlite).toBe('QUERY PLAN\n  SCAN orders\n  USE TEMP B-TREE FOR ORDER BY')
  expect(findings('sqlite', sqlite, {})).toEqual([
    { level: 'warn', text: 'Full table scan on orders' },
    { level: 'info', text: 'ORDER BY without a matching index (temp B-tree)' },
  ])
  expect(findings('sqlite', 'SEARCH orders USING INDEX orders_status_idx (status=?)', {})).toEqual([])
  expect(findings('mysql', '-> Filter: (orders.status = 1)\n    -> Table scan on orders  (cost=0.35 rows=10)', { orders: 10 })).toEqual([
    { level: 'info', text: 'Full table scan on orders (~10 rows in the table)' },
  ])
})

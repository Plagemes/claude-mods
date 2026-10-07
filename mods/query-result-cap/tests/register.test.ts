import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capQueries } from '../hooks/cap'
import { isCappable } from '../hooks/select'

/** The command as it comes out, or undefined when it is left untouched. */
const capped = (command: string, limit = 50): string | undefined => capQueries(command, limit)?.command

/** The engine beneath the plugin: records the commands that reach it. */
const engine = (on: On) => {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    ran.push(e.tool === 'Bash' ? e.command : '')
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return ran
}

test('a SELECT without a limit reaches the shell with LIMIT 50 and Claude is told', async ($, on) => {
  const ran = engine(on)

  const result = await $.tool.call({ tool: 'Bash', command: `psql -d app -c "SELECT id, email FROM users WHERE active"` })

  expect(ran).toEqual([`psql -d app -c "SELECT id, email FROM users WHERE active LIMIT 50"`])
  expect(result.context?.[0]).toContain('query-result-cap: the SELECT in this command had no row limit, so " LIMIT 50" was added')
})

test('commands that are not queries, or are already bounded, are passed on unchanged', async ($, on) => {
  const ran = engine(on)
  const commands = [`ls -la`, `psql -c "select * from users limit 5"`, `echo "select * from users"`, `psql -f report.sql`]

  for (const command of commands) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(result.context).toBeUndefined()
  }

  expect(ran).toEqual(commands)
})

test('the limit is configurable', { options: { limit: 10 } }, async ($, on) => {
  const ran = engine(on)

  const result = await $.tool.call({ tool: 'Bash', command: `mysql -e 'select * from orders;'` })

  expect(ran).toEqual([`mysql -e 'select * from orders LIMIT 10;'`])
  expect(result.context?.[0]).toContain('LIMIT 10')
})

test('psql: -c in every spelling, quotes kept, semicolons respected', () => {
  expect(capped(`psql -c "select * from t"`)).toBe(`psql -c "select * from t LIMIT 50"`)
  expect(capped(`psql -c 'select * from t;'`)).toBe(`psql -c 'select * from t LIMIT 50;'`)
  expect(capped(`psql -c 'select * from t ;  '`)).toBe(`psql -c 'select * from t LIMIT 50 ;  '`)
  expect(capped(`psql -Atc "select email from users order by 1"`)).toBe(`psql -Atc "select email from users order by 1 LIMIT 50"`)
  expect(capped(`psql --command="select * from t"`)).toBe(`psql --command="select * from t LIMIT 50"`)
  expect(capped(`psql --command 'select * from t'`)).toBe(`psql --command 'select * from t LIMIT 50'`)
  expect(capped(`psql -c"select * from t"`)).toBe(`psql -c"select * from t LIMIT 50"`)
  expect(capped(`psql "postgres://u@h/db" -c "select * from t" -t`)).toBe(`psql "postgres://u@h/db" -c "select * from t LIMIT 50" -t`)
})

test('mysql and sqlite3', () => {
  expect(capped(`mysql -u root -p"s3cret" shop -e "SELECT * FROM orders"`)).toBe(`mysql -u root -p"s3cret" shop -e "SELECT * FROM orders LIMIT 50"`)
  expect(capped(`mysql -Nbe 'select name from t;'`)).toBe(`mysql -Nbe 'select name from t LIMIT 50;'`)
  expect(capped(`mysql --execute='select a from b'`)).toBe(`mysql --execute='select a from b LIMIT 50'`)
  expect(capped(`mariadb -e "select * from t"`)).toBe(`mariadb -e "select * from t LIMIT 50"`)
  expect(capped(`sqlite3 app.db "select * from users"`)).toBe(`sqlite3 app.db "select * from users LIMIT 50"`)
  expect(capped(`sqlite3 -header -column app.db 'SELECT * FROM t;'`)).toBe(`sqlite3 -header -column app.db 'SELECT * FROM t LIMIT 50;'`)
  expect(capped(`sqlite3 app.db ".tables"`)).toBeUndefined()
  expect(capped(`sqlite3 app.db`)).toBeUndefined()
})

test('it finds the client behind sudo, env assignments, containers and shell chains', () => {
  expect(capped(`sudo -u postgres psql -c "select * from t"`)).toBe(`sudo -u postgres psql -c "select * from t LIMIT 50"`)
  expect(capped(`PGPASSWORD=x psql -h db -c "select * from t"`)).toBe(`PGPASSWORD=x psql -h db -c "select * from t LIMIT 50"`)
  expect(capped(`docker exec -it db psql -U app -c "select * from t"`)).toBe(`docker exec -it db psql -U app -c "select * from t LIMIT 50"`)
  expect(capped(`cd /app && psql -c "select * from t" | head -5 2>&1`)).toBe(`cd /app && psql -c "select * from t LIMIT 50" | head -5 2>&1`)
  expect(capped(`timeout 20 psql -c "select * from t" > out.txt`)).toBe(`timeout 20 psql -c "select * from t LIMIT 50" > out.txt`)
  expect(capped(`for t in a b; do psql -c "select * from $t"; done`)).toBe(`for t in a b; do psql -c "select * from $t LIMIT 50"; done`)
})

test('several statements in one command are each capped', () => {
  const result = capQueries(`psql -c "select * from a" -c "select count(*) from b" -c "select * from c"`, 50)
  expect(result?.command).toBe(`psql -c "select * from a LIMIT 50" -c "select count(*) from b" -c "select * from c LIMIT 50"`)
  expect(result?.count).toBe(2)
})

test('quoting inside the SQL is left exactly as it was', () => {
  expect(capped(`psql -c "select \\"Name\\" from \\"Users\\""`)).toBe(`psql -c "select \\"Name\\" from \\"Users\\" LIMIT 50"`)
  expect(capped(`psql -c 'select * from t where a = '"'x'"`)).toBe(`psql -c 'select * from t where a = '"'x' LIMIT 50"`)
  expect(capped(`psql -c "select * from t where note = 'limit 5'"`)).toBe(`psql -c "select * from t where note = 'limit 5' LIMIT 50"`)
  expect(capped(`mysql -e "select * from \\\`orders\\\` where id > 5"`)).toBe(`mysql -e "select * from \\\`orders\\\` where id > 5 LIMIT 50"`)
})

test('what is not a plain unbounded SELECT is never touched', () => {
  const untouched = [
    `psql -c "select * from t limit 10"`,
    `psql -c "select top 5 * from t"`,
    `psql -c "select * from t fetch first 5 rows only"`,
    `psql -c "select * from t offset 10"`,
    `psql -c "select count(*) from t"`,
    `psql -c "select max(id), min(id) from t where a = 1"`,
    `psql -c "select 1"`,
    `psql -c "select now(), version()"`,
    `psql -c "insert into t values (1)"`,
    `psql -c "update t set a = 1"`,
    `psql -c "delete from t"`,
    `psql -c "explain select * from t"`,
    `psql -c "\\d users"`,
    `psql -c "select * from a; select * from b"`,
    `psql -c "select * into backup from t"`,
    `psql -c "select * from t for update"`,
    `psql -c "with x as (delete from t returning *) select * from x"`,
    `psql -c "select * from t -- every row"`,
    `psql -c "select * from t /* nocap */"`,
    `psql -c "select * from t where d = '$(date)'"`,
    `mysql -e "select * from \`orders\`"`,
    `psql -c select\\ *\\ from\\ t`,
    `psql -c "$QUERY"`,
    `echo "select * from t" | psql`,
    `psql <<SQL\nselect * from t\nSQL`,
    `psql -c "select 'it\\'s' from t"`,
  ]
  for (const command of untouched) expect(`${command} => ${capped(command)}`).toBe(`${command} => undefined`)
})

test('grouped, joined and CTE queries are capped; aggregate-only ones are not', () => {
  expect(isCappable('select status, count(*) from orders group by status')).toBe(true)
  expect(isCappable('select * from a join b on a.id = b.a_id')).toBe(true)
  expect(isCappable('with recent as (select * from orders) select * from recent')).toBe(true)
  expect(isCappable('with c as (select count(*) n from t) select * from c')).toBe(true)
  expect(isCappable('select count(*) from a union all select count(*) from b')).toBe(true)
  expect(isCappable('select exists(select 1 from t)')).toBe(false)
  expect(isCappable('select count(*) as n, max(created_at) from orders where x in (select id from y)')).toBe(false)
  expect(isCappable('select count(*) over () from t')).toBe(true)
  expect(isCappable('')).toBe(false)
})

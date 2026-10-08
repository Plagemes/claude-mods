import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { findSql } from '../hooks/sql'
import { fakeHub } from './hub'

const FILE = '/repo/src/users.ts'

/** Stands in for the engine: files on disk by path (any other file holds just PLACEHOLDER), what reaches the tool, and the toasts. */
function engine(on: On, files: Record<string, string> = {}) {
  const seen = { reached: 0, toasts: [] as string[] }
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    return { value: files[e.path] ?? 'PLACEHOLDER\n' }
  })
  return seen
}

/** Whether an Edit that puts `new_string` into FILE is flagged (warn mode). */
const flagged = async ($: Engine, new_string: string, file_path = FILE) =>
  (await $.tool.call({ tool: 'Edit', file_path, old_string: 'PLACEHOLDER', new_string })).context !== undefined

test('in warn mode lets the edit through, tells Claude which statements and where, and toasts', async ($, on) => {
  const seen = engine(on, { [FILE]: 'PLACEHOLDER\n' })
  const result = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'PLACEHOLDER',
    new_string: 'await db.query("UPDATE users SET active = false")',
  })
  expect(seen.reached).toBe(1)
  expect(result.context?.[0]).toContain('line 1: UPDATE without WHERE changes every row: UPDATE users SET active = false')
  expect(seen.toasts[0]).toBe('1 risky SQL statement added to users.ts')
})

test('in block mode refuses the change before it reaches the file', { options: { mode: 'block' } }, async ($, on) => {
  const seen = engine(on)
  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/db/cleanup.sql',
    content: '-- reset\nDELETE FROM orders;\nTRUNCATE TABLE sessions;\nDELETE FROM carts WHERE abandoned = true;\n',
  })
  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('sql-safety: blocked')
  expect(result.deny).toContain('line 2: DELETE without WHERE removes every row: DELETE FROM orders')
  expect(result.deny).toContain('line 3: TRUNCATE empties the table')
  expect(result.deny).not.toContain('carts')
})

test('finds UPDATE, DELETE, DROP and TRUNCATE in .sql files and leaves the safe forms alone', async ($, on) => {
  engine(on)
  const write = async (content: string) =>
    (await $.tool.call({ tool: 'Write', file_path: '/repo/db/q.sql', content })).context !== undefined

  expect(await write('UPDATE users SET active = 0;')).toBe(true)
  expect(await write('update users u set u.active = 0')).toBe(true)
  expect(await write('DELETE FROM sessions;')).toBe(true)
  expect(await write('DROP TABLE IF EXISTS old_users;')).toBe(true)
  expect(await write('DROP DATABASE scratch;')).toBe(true)
  expect(await write('TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE;')).toBe(true)

  expect(await write('UPDATE users SET active = 0 WHERE id = 7;')).toBe(false)
  expect(await write('UPDATE users SET active = 0\n  WHERE last_login < now() - interval \'1 year\';')).toBe(false)
  expect(await write('DELETE FROM sessions WHERE expires_at < now();')).toBe(false)
  expect(await write('DROP INDEX idx_users_email;')).toBe(false)
  expect(await write('-- DELETE FROM sessions;\n/* DROP TABLE users; */\nSELECT 1;')).toBe(false)
  expect(await write('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2;')).toBe(false)
})

test('finds SQL in string and template literals of code, across languages', async ($, on) => {
  engine(on)
  expect(await flagged($, 'db.run(`DELETE FROM sessions`)')).toBe(true)
  expect(await flagged($, 'db.run(`\n  UPDATE users\n  SET active = false\n`)')).toBe(true)
  expect(await flagged($, "await pool.query('delete from sessions')")).toBe(true)

  expect(await flagged($, 'cur.execute("""\n    UPDATE accounts SET balance = 0\n""")', '/repo/app/db.py')).toBe(true)
  expect(await flagged($, 'DB.execute <<~SQL\n  DELETE FROM sessions\nSQL', '/repo/app/job.rb')).toBe(true)
  expect(await flagged($, '$pdo->exec("TRUNCATE TABLE logs");', '/repo/app/Job.php')).toBe(true)
  expect(await flagged($, 'db.Exec("DELETE FROM sessions")', '/repo/db/db.go')).toBe(true)
  expect(await flagged($, 'jdbc.update("UPDATE users SET active = 0")', '/repo/src/Users.java')).toBe(true)
})

test('does not mistake prose, comments, parts of longer queries or other languages for dangerous SQL', async ($, on) => {
  engine(on)
  expect(await flagged($, 'const msg = "Delete from cache failed"')).toBe(false)
  expect(await flagged($, 'const msg = "Update the set of rules"')).toBe(false)
  expect(await flagged($, '// db.query("DELETE FROM sessions")')).toBe(false)
  expect(await flagged($, 'db.query("UPDATE users SET active = false WHERE id = $1", [id])')).toBe(false)
  expect(await flagged($, 'db.query("UPDATE users SET active = false " + "WHERE id = 1")')).toBe(false)
  expect(await flagged($, 'db.query("UPDATE users SET active = false " + where)')).toBe(false)
  expect(await flagged($, 'db.query(`DELETE FROM users ${where}`)')).toBe(false)
  expect(await flagged($, 'cur.execute("UPDATE users SET a = 1 "\n  "WHERE id = %s", (i,))', '/repo/app/db.py')).toBe(false)
  expect(await flagged($, 'db.query("SELECT * FROM users")')).toBe(false)
  expect(await flagged($, 'const a = "UPDATE users SET a = 0"', '/repo/README.md')).toBe(false)
})

test('DROP and TRUNCATE are expected in migrations, and the directories are configurable', async ($, on) => {
  engine(on)
  const migration = '/repo/db/migrate/20260101_drop_users.rb'
  expect(await flagged($, 'execute "DROP TABLE users"', migration)).toBe(false)
  expect(await flagged($, 'execute "DELETE FROM users"', migration)).toBe(true)
  expect(await flagged($, 'execute "DROP TABLE users"', '/repo/app/models/user.rb')).toBe(true)
})

test('migrationDirs names the folders where DROP is expected', { options: { migrationDirs: 'schema/changes' } }, async ($, on) => {
  engine(on)
  expect(await flagged($, 'DROP TABLE users;', '/repo/schema/changes/001.sql')).toBe(false)
  expect(await flagged($, 'DROP TABLE users;', '/repo/db/migrate/001.sql')).toBe(true)
})

test('only counts what the change adds: existing statements stay quiet, a removed WHERE is caught', async ($, on) => {
  const existing = 'db.query("DELETE FROM sessions")\nconst keep = 1\ndb.query("UPDATE users SET a = 1 WHERE id = 2")\n'
  engine(on, { [FILE]: existing })

  const elsewhere = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const keep = 1', new_string: 'const keep = 2' })
  expect(elsewhere.context).toBeUndefined()

  const removedWhere = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'SET a = 1 WHERE id = 2',
    new_string: 'SET a = 1',
  })
  expect(removedWhere.context?.[0]).toContain('line 3: UPDATE without WHERE')

  const rewrite = await $.tool.call({ tool: 'Write', file_path: FILE, content: existing.replace('keep = 1', 'keep = 3') })
  expect(rewrite.context).toBeUndefined()
})

test('regression: big files with thousands of strings or statements scan fast, with the right line numbers', () => {
  const messages = Array.from({ length: 8000 }, (_, i) => `  key${i}: { label: 'Label ${i}', hint: "Hint ${i}" },`).join('\n')
  const code = `export const messages = {\n${messages}\n}\nconst purge = "DELETE FROM sessions"\n`
  const seed = `${Array.from({ length: 10000 }, (_, i) => `INSERT INTO users (id) VALUES (${i});`).join('\n')}\nDELETE FROM users;\n`

  const startedAt = performance.now()
  const inCode = findSql(code, 'ts')
  const inSql = findSql(seed, 'sql')
  expect(performance.now() - startedAt).toBeLessThan(1000)
  expect(inCode).toEqual([{ rule: 'delete-without-where', statement: 'DELETE FROM sessions', line: 8003 }])
  expect(inSql).toEqual([{ rule: 'delete-without-where', statement: 'DELETE FROM users', line: 10001 }])
})

test('with mods-hub: says hello, publishes lint.result for each scanned file, and warns through the hub instead of a toast', async ($, on) => {
  const seen = engine(on, { [FILE]: 'PLACEHOLDER\n' })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked', 'lint.result'], consumes: [] }])

  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'await db.query("UPDATE users SET active = false")\nawait db.query("DELETE FROM carts")\n' })
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'sql-safety', errors: 2, warnings: 0, files: [FILE] } }])
  expect(hub.notified).toEqual([{ level: 'warning', title: '2 risky SQL statements added to users.ts' }])
  expect(seen.toasts).toEqual([])

  hub.published.length = 0
  await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'DELETE FROM x' })
  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'const ok = 1\n' })
  expect(hub.published).toEqual([{ topic: 'lint.result', data: { tool: 'sql-safety', errors: 0, warnings: 0, files: [FILE] } }])
})

test('with mods-hub, block mode also publishes risk.blocked for the refusal', { options: { mode: 'block' } }, async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/db/cleanup.sql', content: 'DELETE FROM orders;\nTRUNCATE TABLE sessions;\n' })
  expect(result.deny).toContain('sql-safety: blocked')
  expect(hub.published).toEqual([
    { topic: 'lint.result', data: { tool: 'sql-safety', errors: 2, warnings: 0, files: ['/repo/db/cleanup.sql'] } },
    { topic: 'risk.blocked', data: { guard: 'sql-safety', tool: 'Edit', reason: 'adds SQL that can destroy data (delete-without-where, truncate)', severity: 'high', path: '/repo/db/cleanup.sql' } },
  ])
})

test('without mods-hub the warning is the same toast', async ($, on) => {
  const seen = engine(on)
  await $.tool.call({ tool: 'Write', file_path: FILE, content: 'await db.query("UPDATE users SET active = false")' })
  expect(seen.toasts).toEqual(['1 risky SQL statement added to users.ts'])
})

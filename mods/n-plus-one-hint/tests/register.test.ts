import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { findLoopQueries } from '../hooks/loops'

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
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? 'PLACEHOLDER\n' }))
  return seen
}

/** The note an Edit that puts `code` into `file` earns, or undefined when it earns none. */
const noteFor = async ($: Engine, code: string, file = '/repo/src/users.ts') =>
  (await $.tool.call({ tool: 'Edit', file_path: file, old_string: 'PLACEHOLDER', new_string: code })).context?.[0]

test('flags a Prisma query in a for loop, with file:line, a toast and what to do instead', async ($, on) => {
  const seen = engine(on)
  const result = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/posts.ts',
    old_string: 'PLACEHOLDER',
    new_string: 'const out = []\nfor (const id of ids) {\n  const user = await prisma.user.findUnique({ where: { id } })\n  out.push(user)\n}',
  })
  expect(seen.reached).toBe(1)
  expect(result.context?.[0]).toContain('/repo/src/posts.ts:3  prisma.user.findUnique(...) runs once per iteration')
  expect(result.context?.[0]).toContain('include/select on the outer query')
  expect(seen.toasts).toEqual(['possible N+1 query in posts.ts:3'])
})

test('sees queries in callbacks, comprehensions, blocks and brace-less loops, across languages', async ($, on) => {
  engine(on)
  expect(await noteFor($, 'await Promise.all(ids.map(id => prisma.post.findFirst({ where: { id } })))')).toContain('prisma.post.findFirst')
  expect(await noteFor($, 'items.forEach(async (item) => {\n  await Item.findOne({ _id: item.id })\n})')).toContain('Item.findOne')
  expect(await noteFor($, 'while (queue.length) {\n  const row = await db.query("select 1")\n}')).toContain('db.query')
  expect(await noteFor($, 'for (const id of ids)\n  await userRepository.findById(id)')).toContain('userRepository.findById')

  expect(await noteFor($, 'for u in users:\n    p = Profile.objects.get(user=u)\n', '/repo/app/views.py')).toContain('Profile.objects.get')
  expect(await noteFor($, 'profiles = [Profile.objects.filter(user=u).first() for u in users]', '/repo/app/views.py')).toContain('Profile.objects.filter')
  expect(await noteFor($, 'while rows:\n    r = session.query(Order).get(1)\n', '/repo/app/db.py')).toContain('session.query')

  expect(await noteFor($, 'users.each do |u|\n  Order.where(user_id: u.id).count\nend', '/repo/app/report.rb')).toContain('Order.where')
  expect(await noteFor($, 'foreach ($users as $user) {\n    $o = Order::where(\'user_id\', $user->id)->get();\n}', '/repo/app/Report.php')).toContain('Order::where')
  expect(await noteFor($, 'for _, id := range ids {\n\trow := db.QueryRow("select 1", id)\n}', '/repo/store/store.go')).toContain('db.QueryRow')
  expect(await noteFor($, 'for (Long id : ids) {\n    repository.findById(id);\n}', '/repo/src/Svc.java')).toContain('repository.findById')
})

test('leaves alone a query before the loop, the loop header, loops without queries and in-memory finds', async ($, on) => {
  engine(on)
  expect(await noteFor($, 'const users = await prisma.user.findMany({ where: { id: { in: ids } } })\nfor (const u of users) {\n  console.log(u)\n}')).toBeUndefined()
  expect(await noteFor($, 'for (const u of await prisma.user.findMany()) {\n  console.log(u)\n}')).toBeUndefined()
  expect(await noteFor($, 'const names = (await prisma.user.findMany()).map(u => u.name)')).toBeUndefined()
  expect(await noteFor($, 'for (const x of xs) {\n  total += x.price\n}\nconst one = await prisma.user.findUnique({ where: { id } })')).toBeUndefined()
  expect(await noteFor($, 'for (const x of xs) {\n  const hit = cache.find(c => c.id === x.id)\n}')).toBeUndefined()
  expect(await noteFor($, 'for (const x of xs) {\n  // await prisma.user.findUnique()\n  log("prisma.user.findUnique(")\n}')).toBeUndefined()
  expect(await noteFor($, 'for u in users:\n    print(u)\nProfile.objects.get(pk=1)', '/repo/app/views.py')).toBeUndefined()
  expect(await noteFor($, 'for _, id := range ids {\n\ttotal += id\n}', '/repo/store/store.go')).toBeUndefined()
})

test('only reports what the edit adds, and skips tests, migrations and seeds', async ($, on) => {
  const existing = 'for (const id of ids) {\n  await prisma.user.findUnique({ where: { id } })\n}\nconst keep = 1\n'
  engine(on, { '/repo/src/users.ts': existing })
  const elsewhere = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/users.ts', old_string: 'const keep = 1', new_string: 'const keep = 2' })
  expect(elsewhere.context).toBeUndefined()

  const added = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/users.ts',
    old_string: 'const keep = 1',
    new_string: 'for (const id of other) {\n  await prisma.post.findMany({ where: { id } })\n}',
  })
  expect(added.context?.[0]).toContain('users.ts:5')
  expect(added.context?.[0]).not.toContain('users.ts:2')

  const loop = 'for (const id of ids) {\n  await prisma.user.findUnique({ where: { id } })\n}'
  expect(await noteFor($, loop, '/repo/src/users.test.ts')).toBeUndefined()
  expect(await noteFor($, loop, '/repo/prisma/seeds/seed.ts')).toBeUndefined()
  expect(await noteFor($, loop, '/repo/db/migrate/001.ts')).toBeUndefined()
  expect(await noteFor($, loop, '/repo/README.md')).toBeUndefined()
})

test('findLoopQueries reports each query line once, nested loops included, with its call', () => {
  const source = [
    'for (const a of as) {',
    '  for (const b of bs) {',
    '    await Order.find({ a, b })',
    '  }',
    '}',
  ].join('\n')
  expect(findLoopQueries(source, 'ts').map(hit => [hit.line, hit.call, hit.kind])).toEqual([[3, 'Order.find', 'orm']])
})

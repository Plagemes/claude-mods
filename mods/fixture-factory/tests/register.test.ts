import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { extractBlock, parseHits, relatedBlocks, relatedNames } from '../hooks/find'
import { fileNameFor, parseArgs, parseRecords, previewOf } from '../hooks/generate'

const PLUGIN = 'fixture-factory'
const PANE_PROPS = {
  title: 'Fixtures',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const USAGE = { input_tokens: 400, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const SCHEMA = [
  'enum Role {',
  '  ADMIN',
  '  MEMBER',
  '}',
  '',
  'model User {',
  '  id    String  @id @default(uuid())',
  '  email String  @unique',
  '  role  Role    @default(MEMBER)',
  '  posts Post[]',
  '}',
].join('\n')
const RECORDS = [
  { id: '6f1c2b1e-8a43-4c4e-9a59-2b1f0c5d7e01', email: 'ana.silva@example.com', role: 'ADMIN' },
  { id: '0b7d8c52-3f0a-4d0e-8f53-7b0e7f5c9a12', email: 'li.wei@example.org', role: 'MEMBER' },
]

type World = {
  files: Map<string, string>
  greps: string[][]
  prompts: string[]
  fills: string[]
  clock: ReturnType<typeof mock.clock>
}

/** A project with a Prisma schema, a model that answers from `replies` in turn, and git or plain grep. */
const world = (on: On, replies: string[], options: { isRepo?: boolean; files?: Record<string, string>; truncated?: boolean } = {}): World => {
  const state: World = {
    files: new Map(Object.entries({ '/work/app/prisma/schema.prisma': SCHEMA, ...options.files })),
    greps: [],
    prompts: [],
    fills: [],
    clock: mock.clock(on),
  }
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    state.greps.push([...e.argv])
    const answer = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const isUser = e.argv.some(arg => arg.includes('(User|Users)'))
    if (e.argv[0] === 'git') return options.isRepo === false ? answer(128) : isUser ? answer(0, 'prisma/schema.prisma:6:model User {\n') : answer(1)
    return isUser ? answer(0, './prisma/schema.prisma:6:model User {\n') : answer(1)
  })
  on('fs.read', ($, e) => (state.files.has(e.path) ? { value: state.files.get(e.path) as string } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: [...state.files.keys()].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  on('fs.write', ($, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    state.prompts.push(e.prompt)
    const text = replies[state.prompts.length - 1] ?? '[]'
    return { value: { isAnswered: true, text, usage: options.truncated === true ? { ...USAGE, output_tokens: e.maxTokens ?? 1024 } : USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', ($, e) => {
    state.fills.push(e.text)
    return { isFilled: true }
  })
  return state
}

const fixtures = ($: Engine, args: string) =>
  $.command.run({ command: 'fixtures', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'fixtures', props: PANE_PROPS })

test('finds and cuts out definitions, with the enums they use', () => {
  const hits = parseHits('tests/user.test.ts:1:export interface User {\nnode_modules/x/a.ts:2:interface User {\nprisma/schema.prisma:6:model User {\nsrc/users.sql:1:CREATE TABLE users (\n', 'User')
  expect(hits.map(hit => `${hit.path}:${hit.kind}`)).toEqual(['prisma/schema.prisma:prisma', 'tests/user.test.ts:typescript', 'src/users.sql:sql'])

  const lines = SCHEMA.split('\n')
  const block = extractBlock(lines, 5, 'prisma')
  expect(block.split('\n')).toHaveLength(6)
  expect(relatedNames(block, 'User')).toEqual(['Role', 'Post'])
  expect(relatedBlocks(lines, ['Role', 'Post'], 'prisma', 5)).toEqual(['enum Role {\n  ADMIN\n  MEMBER\n}'])

  const ts = ["export type Money =", "  | { currency: 'EUR'; cents: number }", "  | { currency: 'USD'; cents: number }", '', 'export interface Next {}']
  expect(extractBlock(ts, 0, 'typescript').split('\n')).toHaveLength(3)
  const py = ['@dataclass', 'class Invoice:', '    id: int', '    total: float', '', 'def other():', '    pass']
  expect(extractBlock(py, 1, 'python')).toBe('@dataclass\nclass Invoice:\n    id: int\n    total: float')
  const sql = ['CREATE TABLE customers (', '  id SERIAL PRIMARY KEY,', '  balance NUMERIC(10, 2) CHECK (balance >= 0) -- (note', ');', 'CREATE TABLE other (x int);']
  expect(extractBlock(sql, 0, 'sql').split('\n')).toHaveLength(4)

  expect(parseArgs('User 25', 10)).toEqual({ name: 'User', count: 25 })
  expect(parseArgs('order_items', 10)).toEqual({ name: 'order_items', count: 10 })
  expect(parseArgs('User 5000', 10)).toEqual({ name: 'User', count: 200 })
  expect(parseArgs('../etc', 10)).toBeUndefined()
  expect(fileNameFor('OrderItem')).toBe('order-item.json')
  expect(parseRecords('Here you go:\n```json\n[{"a":1}]\n```').ok).toBe(true)
  expect(parseRecords('[1, 2]')).toEqual({ ok: false, error: 'some items of the array are not objects' })
  expect(previewOf([{ a: 'x'.repeat(50) }, { a: 'y'.repeat(50) }], 80)).toContain('… 1 more')
})

test('/fixtures User 2 generates records from the Prisma model and shows them', async ($, on) => {
  const state = world(on, [JSON.stringify(RECORDS)])
  expect((await fixtures($, 'User 2')).text).toBe('Generating 2 User records from prisma/schema.prisma:6 with sonnet…')
  expect(state.greps[0]?.slice(0, 7)).toEqual(['git', 'grep', '-n', '-I', '-i', '-E', '--untracked'])
  await state.clock.settle()

  expect(state.prompts[0]).toContain('Generate 2 records for `User`, defined in prisma/schema.prisma:6 (prisma)')
  expect(state.prompts[0]).toContain('enum Role {')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ key: 'title' }))?.text).toContain('Fixtures · 2 User records')
    expect((await ui.find({ key: 'preview' }))?.text).toContain('ana.silva@example.com')
    expect((await ui.find({ key: 'save' }))?.props.label).toBe('Save to fixtures/user.json')
    expect(await ui.find({ type: 'Code', text: /model User/ })).toBeUndefined()
    await ui.press({ key: 'toggle-definition' })
    expect(await ui.find({ type: 'Code', text: /model User/ })).toBeDefined()
    await ui.press({ key: 'toggle-definition' })
    await ui.unmount()
  }
})

test('Save writes the JSON, asking before it replaces a file; Insert then points at it', async ($, on) => {
  const state = world(on, [JSON.stringify(RECORDS)], { files: { '/work/app/tests/fixtures/user.json': '[]' } })
  await fixtures($, 'User 2')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'insert' })
  expect(state.fills[0]).toContain('Here are 2 test records for User:\n```json\n[')

  await ui.press({ key: 'save' })
  expect(state.files.get('/work/app/tests/fixtures/user.json')).toBe('[]')
  expect((await ui.find({ key: 'save' }))?.props.label).toBe('Replace tests/fixtures/user.json')
  await ui.press({ key: 'save' })
  expect(JSON.parse(state.files.get('/work/app/tests/fixtures/user.json') ?? '')).toEqual(RECORDS)

  await ui.press({ key: 'insert' })
  expect(state.fills[1]).toBe('Use the 2 User test fixtures in @tests/fixtures/user.json ')
})

test('an unusable answer is asked for again, then reported', async ($, on) => {
  const state = world(on, ['Sure! Here are some users.', JSON.stringify(RECORDS)])
  await fixtures($, 'User 2')
  await state.clock.settle()
  expect(state.prompts).toHaveLength(2)
  expect(state.prompts[1]).toContain('Your previous answer could not be used: the reply holds no JSON array.')
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'preview' }))?.text).toContain('li.wei@example.org')
})

test('two unusable answers end in an error', async ($, on) => {
  const state = world(on, ['nope', '[{"a": 1,]'], {})
  await fixtures($, 'User 3')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toContain("The model's answer was not usable: the JSON does not parse")
  expect(await ui.find({ key: 'save' })).toBeUndefined()
})

test('a reply that hit the token limit is not trusted', async ($, on) => {
  const state = world(on, [JSON.stringify(RECORDS)], { truncated: true })
  await fixtures($, 'User 150')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'error' }))?.text).toContain('did not fit in one reply')
})

test('outside a git repository it greps; an unknown name says what was searched', async ($, on) => {
  const state = world(on, [JSON.stringify(RECORDS)], { isRepo: false })
  expect((await fixtures($, 'User')).text).toContain('Generating 10 User records')
  expect(state.greps[1]?.slice(0, 2)).toEqual(['grep', '-r'])
  expect(state.greps[1]).toContain('--exclude-dir=node_modules')

  expect((await fixtures($, 'Invoice')).text).toContain('No definition of Invoice found')
  expect((await fixtures($, '')).text).toContain('Usage: /fixtures <Model|Type|table> [count]')
})

test('a short answer is flagged', { options: { count: 3 } }, async ($, on) => {
  const state = world(on, [JSON.stringify(RECORDS)])
  await fixtures($, 'User')
  await state.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'warning' }))?.text).toBe('⚠ Only 2 of 3 records came back.')
})

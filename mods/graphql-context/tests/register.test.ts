import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compactSchema, countsOf, isAboutGraphql, isGraphqlFile, parseIntrospection, parseSdl, schemaPointers } from '../hooks/sdl'

const ROOT = '/work/blog'
const SCHEMA = [
  '"""Entry points"""',
  'type Query {',
  '  "One post"',
  '  post(id: ID!): Post',
  '  posts(first: Int = 20, after: String, filter: PostFilter): PostConnection!',
  '}',
  'type Mutation { publishPost(input: PublishInput!): Post! }',
  'type Post implements Node @key(fields: "id") { id: ID! title: String! author: User status: Status! }',
  'type User implements Node { id: ID! name: String posts: [Post!]! }',
  'type PostConnection { nodes: [Post!]! cursor: String }',
  'interface Node { id: ID! }',
  'enum Status { DRAFT PUBLISHED @deprecated }',
  'input PostFilter { status: Status = PUBLISHED, authorId: ID }',
  'input PublishInput { id: ID! }',
  '# operations in the same file are not part of the schema',
  'query Feed { posts { nodes { id } } }',
  '',
].join('\n')
const RESOLVER = "import { gql } from 'graphql-tag'\nexport const resolvers = { Query: { posts: () => [] } }\n"
const COMPOSE_PROMPT = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const PANE = {
  plugin: 'graphql-context',
  component: 'Pane',
  requestId: 'gql-schema',
  props: { title: 'GraphQL schema', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
} as const
const gqlSchema = (args = '') => ({ command: 'gql-schema', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type World = { files: Map<string, string>; contexts: (readonly string[] | undefined)[]; clock: MockClock }

/** A repository on a virtual disk that git lists; prompts and tools record what the model would read. */
const world = (on: On, files: Record<string, string>): World => {
  const state: World = { files: new Map(Object.entries(files)), contexts: [], clock: mock.clock(on, { now: 5_000 }) }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: [...state.files.keys()].join('\0'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.stat', ($, e) => {
    const text = state.files.get(e.path.slice(ROOT.length + 1))
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path.slice(ROOT.length + 1))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('prompt.submit', ($, e) => {
    state.contexts.push(e.context)
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('tool.call', ($, e) => {
    const path = 'file_path' in e ? String(e.file_path).slice(ROOT.length + 1) : ''
    if (e.tool === 'Write') state.files.set(path, e.content)
    if (e.tool === 'Edit') state.files.set(path, (state.files.get(path) ?? '').replace(e.old_string, e.new_string))
    return e.tool === 'Read' ? { result: { type: 'text' }, text: state.files.get(path) ?? '' } : { result: { type: 'update' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  return state
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(gqlSchema('reload'))
}

test('reads SDL and introspection, compacts it around the root operations, and spots GraphQL work', () => {
  const schema = parseSdl([SCHEMA, 'extend type Query { me: User }'])
  expect(countsOf(schema)).toEqual({ types: 9, queries: 3, mutations: 1, subscriptions: 0 })
  const { text, isCut } = compactSchema(schema, 6000)
  expect(isCut).toBe(false)
  expect(text).toContain('type Query {\n  post(id: ID!): Post\n  posts(first: Int = 20, after: String, filter: PostFilter): PostConnection!\n  me: User\n}')
  expect(text).toContain('input PostFilter { status: Status = PUBLISHED, authorId: ID }')
  expect(text).toContain('enum Status { DRAFT, PUBLISHED }')
  expect(text).toContain('type Post implements Node { id: ID!, title: String!, author: User, status: Status! }')
  expect(text).not.toContain('Feed')
  expect(text.indexOf('PostConnection {')).toBeLessThan(text.indexOf('type User'))
  const cut = compactSchema(schema, 400)
  expect(cut.isCut).toBe(true)
  expect(cut.text).toMatch(/# … \d+ more types: /)

  const introspected = parseIntrospection(
    JSON.stringify({
      data: {
        __schema: {
          queryType: { name: 'Root' },
          types: [
            { kind: 'OBJECT', name: 'Root', fields: [{ name: 'pets', args: [], type: { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'OBJECT', name: 'Pet' } } } }] },
            { kind: 'OBJECT', name: 'Pet', fields: [{ name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID' } }] },
            { kind: 'OBJECT', name: '__Type', fields: [] },
          ],
        },
      },
    }),
  )
  expect(introspected?.roots.query).toBe('Root')
  expect(compactSchema(introspected!, 1000).text).toBe('type Root {\n  pets: [Pet]!\n}\n\ntype Pet { id: ID }')

  expect(isAboutGraphql('add pagination to the posts query', schema)).toBe(true)
  expect(isAboutGraphql('why does the Apollo cache miss?', schema)).toBe(true)
  expect(isAboutGraphql('fix the footer css', schema)).toBe(false)
  expect(isGraphqlFile('src/api/feed.ts', RESOLVER)).toBe(true)
  expect(isGraphqlFile('src/schema/post.graphql')).toBe(true)
  expect(isGraphqlFile('src/util.ts', 'export const x = 1')).toBe(false)
  expect(schemaPointers("schema:\n  - 'src/**/*.graphql'\n  - https://api.example.com/graphql\ndocuments: src/**/*.tsx\n")).toEqual(['src/**/*.graphql'])
})

test('a GraphQL prompt gets the compact schema once per conversation; other prompts do not', async ($, on) => {
  const state = world(on, { 'schema.graphql': SCHEMA, 'src/feed.ts': RESOLVER, 'src/ops/feed.graphql': 'query Feed { posts { nodes { id } } }' })
  await start($)
  await $.prompt.submit(COMPOSE_PROMPT('fix the footer css'))
  await $.prompt.submit(COMPOSE_PROMPT('add an `author` filter to the posts query'))
  await $.prompt.submit(COMPOSE_PROMPT('and to the publishPost mutation too'))
  expect(state.contexts[0]).toBeUndefined()
  expect(state.contexts[1]?.[0]).toContain("graphql-context: this project's GraphQL schema, compacted: 9 types, 2 queries, 1 mutation from schema.graphql.")
  expect(state.contexts[1]?.[0]).toContain('```graphql\ntype Query {')
  expect(state.contexts[2]).toBeUndefined()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.prompt.submit(COMPOSE_PROMPT('the publishPost mutation returns null'))
  expect(state.contexts[3]?.[0]).toContain('type Mutation {\n  publishPost(input: PublishInput!): Post!\n}')
})

test('reading a resolver hands Claude the schema with the result; editing the schema reloads it', async ($, on) => {
  const state = world(on, { 'api/schema.graphqls': SCHEMA, 'src/resolvers.ts': RESOLVER })
  await start($)
  const read = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/resolvers.ts` })
  expect(read.context?.[0]).toContain('from api/schema.graphqls')
  const again = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/resolvers.ts` })
  expect(again.context).toBeUndefined()

  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/api/schema.graphqls`, old_string: 'input PublishInput', new_string: 'type Comment { id: ID! body: String! }\ninput PublishInput' })
  expect(state.files.get('api/schema.graphqls')).toContain('type Comment')
  await state.clock.settle()
  const shown = await $.command.run(gqlSchema('Comment'))
  expect(shown.text).toBe('10 types, 2 queries, 1 mutation from api/schema.graphqls.')
})

test('codegen config and introspection JSON are found; a repo without a schema says so', async ($, on) => {
  world(on, {
    'codegen.yml': 'schema: ./graphql/schema.json\ndocuments: src/**/*.tsx\n',
    'graphql/schema.json': JSON.stringify({ __schema: { queryType: { name: 'Query' }, types: [{ kind: 'OBJECT', name: 'Query', fields: [{ name: 'hello', args: [], type: { kind: 'SCALAR', name: 'String' } }] }] } }),
  })
  await start($)
  expect((await $.command.run(gqlSchema())).text).toBe('1 type, 1 query, 0 mutations from graphql/schema.json.')
})

test('without a schema nothing is added and the command explains', async ($, on) => {
  const state = world(on, { 'README.md': '# blog' })
  await start($)
  await $.prompt.submit(COMPOSE_PROMPT('write a graphql resolver'))
  expect(state.contexts[0]).toBeUndefined()
  expect((await $.command.run(gqlSchema())).text).toContain('No GraphQL schema files found.')
})

test('/gql-schema shows the schema on terminal and desktop, filters it, and can attach it to the next prompt', async ($, on) => {
  const state = world(on, { 'schema.graphql': SCHEMA })
  await start($)
  await $.command.run(gqlSchema())
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '9 types · 2 queries · 1 mutation' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /posts\(first: Int = 20/ })).toBeDefined()
    await ui.input({ key: 'filter', text: 'status' })
    expect(await ui.find({ type: 'Text', text: '3 types match "status"' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /enum Status \{\n {2}DRAFT\n {2}PUBLISHED\n\}/ })).toBeDefined()
    await ui.input({ key: 'filter', text: '' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'attach' })
  expect(await ui.find({ type: 'Text', text: '→ goes to Claude with your next prompt' })).toBeDefined()
  await $.prompt.submit(COMPOSE_PROMPT('fix the footer css'))
  expect(state.contexts[0]?.[0]).toContain('graphql-context:')
  expect(await ui.find({ type: 'Text', text: '✓ Claude has it in this conversation' })).toBeDefined()
})

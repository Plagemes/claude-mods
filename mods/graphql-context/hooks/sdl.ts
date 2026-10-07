// Pure parts of graphql-context: a lightweight SDL reader, introspection JSON, the compact summary
// Claude reads, and the tests for "this is about GraphQL". No `$` here.

import type { GraphqlContextField, GraphqlContextSchema, GraphqlContextType } from '../types'

export type Field = GraphqlContextField
export type GqlType = GraphqlContextType
export type Schema = Omit<GraphqlContextSchema, 'files' | 'loadedAt'>

const BUILT_IN_SCALARS = new Set(['Int', 'Float', 'String', 'Boolean', 'ID'])
const DEFAULT_ROOTS = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }

type Token = { kind: 'name' | 'punct' | 'string' | 'number'; text: string }

/** Splits SDL into names, punctuation, strings and numbers; comments and commas are dropped. */
const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i] as string
    if (/[\s,﻿]/.test(char)) {
      i += 1
    } else if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1
    } else if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3)
      const stop = end === -1 ? source.length : end + 3
      tokens.push({ kind: 'string', text: source.slice(i, stop) })
      i = stop
    } else if (char === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== '"' && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
      tokens.push({ kind: 'string', text: source.slice(i, j + 1) })
      i = j + 1
    } else if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...' })
      i += 3
    } else if (/[A-Za-z_]/.test(char)) {
      const name = /^[A-Za-z_]\w*/.exec(source.slice(i))?.[0] ?? char
      tokens.push({ kind: 'name', text: name })
      i += name.length
    } else if (/[-\d]/.test(char)) {
      const number = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(source.slice(i))?.[0] ?? char
      tokens.push({ kind: 'number', text: number })
      i += number.length
    } else {
      tokens.push({ kind: 'punct', text: char })
      i += 1
    }
  }
  return tokens
}

class Reader {
  index = 0
  private readonly tokens: Token[]
  constructor(tokens: Token[]) {
    this.tokens = tokens
  }
  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }
  next(): Token | undefined {
    return this.tokens[this.index++]
  }
  isPunct(text: string): boolean {
    const token = this.peek()
    return token?.kind === 'punct' && token.text === text
  }
  eat(text: string): boolean {
    if (!this.isPunct(text)) return false
    this.index += 1
    return true
  }
  get isDone(): boolean {
    return this.index >= this.tokens.length
  }
  /** Skips a bracketed group starting here (`(…)`, `{…}`, `[…]`). */
  skipGroup(): void {
    const open = this.next()?.text
    const close = open === '(' ? ')' : open === '{' ? '}' : ']'
    for (let depth = 1; depth > 0 && !this.isDone; ) {
      const token = this.next()
      if (token?.kind !== 'punct') continue
      if (token.text === open) depth += 1
      else if (token.text === close) depth -= 1
    }
  }
  skipDescription(): void {
    while (this.peek()?.kind === 'string') this.index += 1
  }
  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.index += 2
      if (this.isPunct('(')) this.skipGroup()
    }
  }
  /** A type reference: `Name`, `[Name!]!`. */
  readType(): string {
    if (this.eat('[')) {
      const inner = this.readType()
      this.eat(']')
      return `[${inner}]${this.eat('!') ? '!' : ''}`
    }
    const name = this.next()?.text ?? '?'
    return `${name}${this.eat('!') ? '!' : ''}`
  }
  /** A default or argument value, as written. */
  readValue(): string {
    if (this.isPunct('[') || this.isPunct('{')) {
      const start = this.index
      this.skipGroup()
      let text = ''
      for (const token of this.tokens.slice(start, this.index)) {
        if (token.text === ':') text += ': '
        else if (token.kind === 'punct' && /^[\]}]$/.test(token.text)) text += token.text
        else text += `${/[^[{\s]$/.test(text) ? ', ' : ''}${token.text}`
      }
      return text
    }
    if (this.eat('$')) return `$${this.next()?.text ?? ''}`
    return this.next()?.text ?? ''
  }
  /** `(a: Int = 1, b: [String!])` → its compact text. */
  readArguments(): string {
    if (!this.eat('(')) return ''
    const args: string[] = []
    while (!this.isDone && !this.eat(')')) {
      this.skipDescription()
      const name = this.next()?.text ?? '?'
      this.eat(':')
      const type = this.readType()
      const value = this.eat('=') ? ` = ${this.readValue()}` : ''
      this.skipDirectives()
      args.push(`${name}: ${type}${value}`)
    }
    return args.length === 0 ? '' : `(${args.join(', ')})`
  }
  readFields(): Field[] {
    const fields: Field[] = []
    if (!this.eat('{')) return fields
    while (!this.isDone && !this.eat('}')) {
      this.skipDescription()
      const name = this.next()
      if (name?.kind !== 'name') continue
      const args = this.readArguments()
      if (!this.eat(':')) continue
      const type = this.readType()
      const value = this.eat('=') ? ` = ${this.readValue()}` : ''
      this.skipDirectives()
      fields.push({ name: name.text, args, type: `${type}${value}` })
    }
    return fields
  }
}

const emptyType = (kind: GqlType['kind'], name: string): GqlType => ({ kind, name, fields: [], values: [], members: [], implements: [] })

const merge = (types: Map<string, GqlType>, type: GqlType): void => {
  const known = types.get(type.name)
  if (known === undefined) {
    types.set(type.name, type)
    return
  }
  const names = new Set(known.fields.map(field => field.name))
  known.fields.push(...type.fields.filter(field => !names.has(field.name)))
  known.values.push(...type.values.filter(value => !known.values.includes(value)))
  known.members.push(...type.members.filter(member => !known.members.includes(member)))
  known.implements.push(...type.implements.filter(name => !known.implements.includes(name)))
}

const KINDS: Record<string, GqlType['kind']> = { type: 'type', input: 'input', enum: 'enum', interface: 'interface', union: 'union', scalar: 'scalar' }

/** Reads the type system definitions of SDL texts; operations and fragments in them are skipped. */
export const parseSdl = (sources: readonly string[]): Schema => {
  const types = new Map<string, GqlType>()
  const roots = { ...DEFAULT_ROOTS }
  for (const source of sources) {
    const reader = new Reader(tokenize(source))
    while (!reader.isDone) {
      reader.skipDescription()
      const keyword = reader.next()
      if (keyword === undefined) break
      if (keyword.kind === 'punct' && keyword.text === '{') {
        reader.index -= 1
        reader.skipGroup()
        continue
      }
      if (keyword.kind !== 'name') continue
      let word = keyword.text
      if (word === 'extend') word = reader.next()?.text ?? ''
      if (word === 'schema') {
        reader.skipDirectives()
        if (!reader.eat('{')) continue
        while (!reader.isDone && !reader.eat('}')) {
          const operation = reader.next()?.text
          reader.eat(':')
          const name = reader.next()?.text
          if (name !== undefined && (operation === 'query' || operation === 'mutation' || operation === 'subscription')) roots[operation] = name
        }
        continue
      }
      if (word === 'directive') {
        reader.eat('@')
        reader.next()
        if (reader.isPunct('(')) reader.skipGroup()
        if (reader.peek()?.text === 'repeatable') reader.next()
        if (reader.peek()?.text === 'on') reader.next()
        reader.eat('|')
        while (reader.peek()?.kind === 'name' && /^[A-Z_]+$/.test(reader.peek()?.text ?? '')) {
          reader.next()
          if (!reader.eat('|')) break
        }
        continue
      }
      if (['query', 'mutation', 'subscription', 'fragment'].includes(word)) {
        while (!reader.isDone && !reader.isPunct('{')) reader.next()
        if (!reader.isDone) reader.skipGroup()
        continue
      }
      const kind = KINDS[word]
      const name = reader.next()?.text
      if (kind === undefined || name === undefined) continue
      const type = emptyType(kind, name)
      if (reader.peek()?.text === 'implements') {
        reader.next()
        reader.eat('&')
        while (reader.peek()?.kind === 'name') {
          type.implements.push(reader.next()?.text as string)
          if (!reader.eat('&')) break
        }
      }
      reader.skipDirectives()
      if (kind === 'union' && reader.eat('=')) {
        reader.eat('|')
        while (reader.peek()?.kind === 'name') {
          type.members.push(reader.next()?.text as string)
          if (!reader.eat('|')) break
        }
      } else if (kind === 'enum' && reader.eat('{')) {
        while (!reader.isDone && !reader.eat('}')) {
          reader.skipDescription()
          const value = reader.next()
          if (value?.kind === 'name') type.values.push(value.text)
          reader.skipDirectives()
        }
      } else if (kind !== 'scalar' && kind !== 'union') {
        type.fields = reader.readFields()
      }
      merge(types, type)
    }
  }
  return { roots, types: [...types.values()] }
}

type TypeRef = { kind?: string; name?: string | null; ofType?: TypeRef | null }
type IntrospectionType = {
  kind?: string
  name?: string
  fields?: { name: string; args?: { name: string; type: TypeRef; defaultValue?: string | null }[]; type: TypeRef }[] | null
  inputFields?: { name: string; type: TypeRef; defaultValue?: string | null }[] | null
  enumValues?: { name: string }[] | null
  possibleTypes?: { name: string }[] | null
  interfaces?: { name: string }[] | null
}

const typeRefText = (ref: TypeRef | null | undefined): string => {
  if (ref === null || ref === undefined) return '?'
  if (ref.kind === 'NON_NULL') return `${typeRefText(ref.ofType)}!`
  if (ref.kind === 'LIST') return `[${typeRefText(ref.ofType)}]`
  return ref.name ?? '?'
}

const INTROSPECTION_KINDS: Record<string, GqlType['kind']> = {
  OBJECT: 'type',
  INPUT_OBJECT: 'input',
  ENUM: 'enum',
  INTERFACE: 'interface',
  UNION: 'union',
  SCALAR: 'scalar',
}

/** Reads an introspection result (`{ data: { __schema } }` or `{ __schema }`); undefined when it is none. */
export const parseIntrospection = (text: string): Schema | undefined => {
  let json: { data?: { __schema?: unknown }; __schema?: unknown }
  try {
    json = JSON.parse(text) as typeof json
  } catch {
    return undefined
  }
  const schema = (json.data?.__schema ?? json.__schema) as
    | { queryType?: { name?: string } | null; mutationType?: { name?: string } | null; subscriptionType?: { name?: string } | null; types?: IntrospectionType[] }
    | undefined
  if (schema === undefined || !Array.isArray(schema.types)) return undefined
  const types: GqlType[] = []
  for (const raw of schema.types) {
    const kind = INTROSPECTION_KINDS[raw.kind ?? '']
    if (kind === undefined || raw.name === undefined || raw.name.startsWith('__')) continue
    const type = emptyType(kind, raw.name)
    for (const field of raw.fields ?? []) {
      const args = (field.args ?? []).map(arg => `${arg.name}: ${typeRefText(arg.type)}${arg.defaultValue == null ? '' : ` = ${arg.defaultValue}`}`)
      type.fields.push({ name: field.name, args: args.length === 0 ? '' : `(${args.join(', ')})`, type: typeRefText(field.type) })
    }
    for (const field of raw.inputFields ?? []) type.fields.push({ name: field.name, args: '', type: typeRefText(field.type) })
    type.values = (raw.enumValues ?? []).map(value => value.name)
    type.members = (raw.possibleTypes ?? []).map(member => member.name)
    if (kind === 'interface') type.members = []
    type.implements = (raw.interfaces ?? []).map(item => item.name)
    types.push(type)
  }
  return {
    roots: {
      query: schema.queryType?.name ?? DEFAULT_ROOTS.query,
      mutation: schema.mutationType?.name ?? DEFAULT_ROOTS.mutation,
      subscription: schema.subscriptionType?.name ?? DEFAULT_ROOTS.subscription,
    },
    types,
  }
}

/** Whether an SDL text defines types (and is not only operations). */
export const definesTypes = (text: string): boolean => /^\s*(?:extend\s+)?(?:type|input|enum|interface|union|scalar|schema)\s+[\w{]/m.test(text)

const baseName = (type: string): string => type.replace(/[[\]!]/g, '')

/** One line per type: `type User { id: ID!, posts(first: Int): [Post!]! }`. */
export const compactLine = (type: GqlType): string => {
  if (type.kind === 'scalar') return `scalar ${type.name}`
  if (type.kind === 'union') return `union ${type.name} = ${type.members.join(' | ')}`
  if (type.kind === 'enum') return `enum ${type.name} { ${type.values.join(', ')} }`
  const implemented = type.implements.length === 0 ? '' : ` implements ${type.implements.join(' & ')}`
  return `${type.kind} ${type.name}${implemented} { ${type.fields.map(field => `${field.name}${field.args}: ${field.type}`).join(', ')} }`
}

/** A type as SDL, one field per line. */
export const fullText = (type: GqlType): string => {
  if (type.kind === 'scalar' || type.kind === 'union' || type.kind === 'enum') return compactLine(type).replace(/\{ (.*) \}$/, (_, body: string) => `{\n  ${body.split(', ').join('\n  ')}\n}`)
  const implemented = type.implements.length === 0 ? '' : ` implements ${type.implements.join(' & ')}`
  return `${type.kind} ${type.name}${implemented} {\n${type.fields.map(field => `  ${field.name}${field.args}: ${field.type}`).join('\n')}\n}`
}

export type Counts = { types: number; queries: number; mutations: number; subscriptions: number }

export const countsOf = (schema: Schema): Counts => {
  const fieldsOf = (name: string) => schema.types.find(type => type.name === name)?.fields.length ?? 0
  return {
    types: schema.types.length,
    queries: fieldsOf(schema.roots.query),
    mutations: fieldsOf(schema.roots.mutation),
    subscriptions: fieldsOf(schema.roots.subscription),
  }
}

/** How many names of root fields left out are still listed. */
const ROOT_NAMES_LISTED = 40

/** The compact schema: root operations one per line, then the types they reach, capped at `maxChars`. */
export const compactSchema = (schema: Schema, maxChars: number): { text: string; isCut: boolean } => {
  const byName = new Map(schema.types.map(type => [type.name, type]))
  const rootNames = [schema.roots.query, schema.roots.mutation, schema.roots.subscription]
  // Root fields one per line, but within the budget too: a generated schema (Hasura, say) can have thousands of them.
  const parts: string[] = []
  let cutFields = 0
  for (const root of rootNames.map(name => byName.get(name)).filter((type): type is GqlType => type !== undefined)) {
    const implemented = root.implements.length === 0 ? '' : ` implements ${root.implements.join(' & ')}`
    const header = `${root.kind} ${root.name}${implemented} {`
    const lines = [header]
    let used = parts.reduce((sum, part) => sum + part.length + 2, 0) + header.length + 2
    let kept = 0
    for (const field of root.fields) {
      const line = `  ${field.name}${field.args}: ${field.type}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
      kept += 1
    }
    const omitted = root.fields.slice(kept).map(field => field.name)
    if (omitted.length > 0) {
      cutFields += omitted.length
      lines.push(`  # … ${omitted.length} more ${root.name} fields: ${omitted.slice(0, ROOT_NAMES_LISTED).join(', ')}${omitted.length > ROOT_NAMES_LISTED ? ', …' : ''}`)
    }
    parts.push([...lines, '}'].join('\n'))
  }
  // Breadth first from the root fields' types and arguments: the types an operation touches come first.
  const queue: string[] = []
  const seen = new Set(rootNames)
  const visit = (type: string) => {
    for (const name of type.match(/[A-Za-z_]\w*/g) ?? []) {
      if (seen.has(name) || BUILT_IN_SCALARS.has(name) || !byName.has(name)) continue
      seen.add(name)
      queue.push(name)
    }
  }
  for (const root of rootNames) for (const field of byName.get(root)?.fields ?? []) visit(`${field.args} ${field.type}`)
  const ordered: GqlType[] = []
  while (queue.length > 0) {
    const type = byName.get(queue.shift() as string) as GqlType
    ordered.push(type)
    for (const field of type.fields) visit(`${field.args} ${field.type}`)
    for (const name of [...type.members, ...type.implements]) visit(name)
  }
  ordered.push(...schema.types.filter(type => !seen.has(type.name) && !BUILT_IN_SCALARS.has(type.name)))
  let text = parts.join('\n\n')
  let shown = 0
  for (const type of ordered) {
    const line = compactLine(type)
    if (text.length + line.length + 1 > maxChars) break
    text += `${text === '' ? '' : shown === 0 ? '\n\n' : '\n'}${line}`
    shown += 1
  }
  const left = ordered.slice(shown).map(type => baseName(type.name))
  if (left.length === 0) return { text, isCut: cutFields > 0 }
  const tail = `\n# … ${left.length} more types: ${left.slice(0, 40).join(', ')}${left.length > 40 ? ', …' : ''}`
  return { text: `${text}${tail}`, isCut: true }
}

/** Types whose name, or one of whose fields, contains `filter` (case-insensitive), rendered in full. */
export const filterSchema = (schema: Schema, filter: string): GqlType[] => {
  const word = filter.trim().toLowerCase()
  if (word === '') return schema.types
  return schema.types.filter(type => type.name.toLowerCase().includes(word) || type.fields.some(field => field.name.toLowerCase().includes(word)) || type.values.some(value => value.toLowerCase().includes(word)))
}

const GRAPHQL_WORDS = /\b(?:graphql|gql|resolvers?|apollo|urql|relay|typegraphql|pothos|hasura|__typename|typedefs|codegen)\b|\.(?:graphql|gql)\b/i
const OPERATION_WORDS = /\b(?:query|queries|mutation|mutations|subscription|resolver|field|schema)\b/i

/** Whether a prompt is about GraphQL: its words, or a root field named beside "query", "mutation", "field"… */
export const isAboutGraphql = (prompt: string, schema: Schema): boolean => {
  if (GRAPHQL_WORDS.test(prompt)) return true
  if (!OPERATION_WORDS.test(prompt)) return false
  const rootFields = [schema.roots.query, schema.roots.mutation, schema.roots.subscription].flatMap(
    root => schema.types.find(type => type.name === root)?.fields.map(field => field.name) ?? [],
  )
  return rootFields.some(name => name.length >= 3 && new RegExp(`\\b${name}\\b`).test(prompt))
}

const GRAPHQL_CODE = /\bgql\s*`|\bgraphql\s*`|\bgql\(|@Resolver\(|@(?:Query|Mutation|Subscription|FieldResolver)\(|\bresolvers\s*[:=]|\bResolvers\b|graphql-tag|@apollo\/|\btypeDefs\b|\bstrawberry\b|\bgraphene\b|\bariadne\b|\bgqlgen\b|99designs\/gqlgen|graphql-go/

/** Whether a file is GraphQL work: SDL or operations, or code with gql`` tags and resolvers. */
export const isGraphqlFile = (path: string, text = ''): boolean =>
  /\.(?:graphql|graphqls|gql)$/i.test(path) || /(?:^|\/)(?:resolvers?|schema)(?:\.[\w-]+)*\.[cm]?[jt]sx?$/i.test(path) || GRAPHQL_CODE.test(text.slice(0, 50_000))

/** The schema files a codegen / graphql-config file names (local paths and globs, not URLs). */
export const schemaPointers = (config: string): string[] => {
  const pointers: string[] = []
  const add = (value: string) => {
    const clean = value.trim().replace(/^['"]|['"],?$/g, '')
    if (clean !== '' && !/^https?:/.test(clean) && /\.(?:graphqls?|gql|json)$|\*/.test(clean)) pointers.push(clean.replace(/^\.\//, ''))
  }
  for (const match of config.matchAll(/["']?schema["']?[ \t]*[:=][ \t]*(\[[^\]]*\]|["'][^"']+["']|[^\s,{[][^\n,}]*)/g)) {
    const value = match[1] as string
    if (value.startsWith('[')) for (const item of value.slice(1, -1).split(',')) add(item)
    else add(value)
  }
  for (const match of config.matchAll(/^\s*schema\s*:\s*\n((?:\s+-\s*.+\n?)+)/gm)) {
    for (const item of (match[1] ?? '').split('\n')) if (/^\s*-/.test(item)) add(item.replace(/^\s*-\s*/, ''))
  }
  return [...new Set(pointers)]
}

/** A glob as a RegExp over `/`-separated paths: `**`, `*`, `?` and `{a,b}`. */
export const globToRegExp = (glob: string): RegExp => {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string
    if (char === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) source += '\\{'
      else {
        source += `(?:${glob.slice(i + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
      }
    } else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

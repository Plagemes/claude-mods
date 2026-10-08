import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderSurface } from 'claude-code'

import type { GraphqlContextSchema } from '../types'
import { compactSchema, countsOf, definesTypes, filterSchema, fullText, globToRegExp, isAboutGraphql, isGraphqlFile, parseIntrospection, parseSdl, schemaPointers } from './sdl'
import type { GqlType } from './sdl'
import { paneFailure } from './shared/render-safe'

const PANE = 'gql-schema'
const DEFAULT_MAX_CHARS = 6000
const MAX_FILES = 60
const MAX_FILE_BYTES = 1024 * 1024
const MAX_SHOWN_CHARS = 60_000
const GIT_TIMEOUT_MS = 10_000
const WALK_MAX_DIRS = 300
const SDL_FILE = /\.(?:graphqls?|gql)$/i
const INTROSPECTION_FILE = /(?:^|\/)(?:schema|graphql\.schema|introspection|schema\.graphql)\.json$/i
const CONFIG_FILES = [
  'codegen.yml', 'codegen.yaml', 'codegen.json', 'codegen.ts', 'codegen.js',
  '.graphqlrc', '.graphqlrc.yml', '.graphqlrc.yaml', '.graphqlrc.json',
  'graphql.config.yml', 'graphql.config.yaml', 'graphql.config.json', 'graphql.config.js', 'graphql.config.ts',
]
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', 'vendor', '__generated__'])

const schemaAtom = atom({ plugin: 'graphql-context', key: 'schema' } as const, null)
const problemAtom = atom({ plugin: 'graphql-context', key: 'problem' } as const, null)
const givenAtom = atom({ plugin: 'graphql-context', key: 'isGiven' } as const, false)
const queuedAtom = atom({ plugin: 'graphql-context', key: 'isQueued' } as const, false)
const filterAtom = atom({ plugin: 'graphql-context', key: 'filter' } as const, '')

type Settings = { schemaPaths: string[]; maxChars: number }
/** The load in flight, so a burst of edits reads the files once. */
type Loader = { running?: Promise<GraphqlContextSchema | null> }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const relativeTo = (root: string, path: string): string => {
  const base = root.replace(/[\\/]+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** `24 types · 8 queries · 5 mutations` (subscriptions only when there are some), joined by `separator`. */
const countText = (schema: GraphqlContextSchema, separator: string): string => {
  const counts = countsOf(schema)
  return [
    plural(counts.types, 'type', 'types'),
    plural(counts.queries, 'query', 'queries'),
    plural(counts.mutations, 'mutation', 'mutations'),
    ...(counts.subscriptions > 0 ? [plural(counts.subscriptions, 'subscription', 'subscriptions')] : []),
  ].join(separator)
}

const describeSchema = (schema: GraphqlContextSchema): string => {
  const from = schema.files.length === 1 ? (schema.files[0] as string) : `${schema.files[0]} and ${schema.files.length - 1} more`
  return `${countText(schema, ', ')} from ${from}`
}

/** What Claude reads: the compact schema in a fence, with where it came from. */
const contextBlock = (schema: GraphqlContextSchema, maxChars: number): string => {
  const { text, isCut } = compactSchema(schema, maxChars)
  return [
    `graphql-context: this project's GraphQL schema, compacted: ${describeSchema(schema)}. Use these exact type, field and argument names in queries, mutations and resolvers.${isCut ? ' Some types are only named; read the schema files for them.' : ''}`,
    '```graphql',
    text,
    '```',
  ].join('\n')
}

async function git($: EngineInterface, root: string, args: readonly string[]): Promise<string[] | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout.split('\0').filter(Boolean) : undefined
  } catch {
    return undefined
  }
}

/** Files under the root whose path `matches`, by git when it can, else by a capped walk. */
async function findFiles($: EngineInterface, root: string, matches: (path: string) => boolean): Promise<string[]> {
  const listed = await git($, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (listed !== undefined) return listed.filter(matches).slice(0, MAX_FILES)
  const found: string[] = []
  const queue = ['']
  for (let visited = 0; queue.length > 0 && visited < WALK_MAX_DIRS && found.length < MAX_FILES; visited += 1) {
    const dir = queue.shift() as string
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === 'dir' && !IGNORED_DIRS.has(entry.name)) queue.push(path)
      else if (entry.kind === 'file' && matches(path)) found.push(path)
    }
  }
  return found
}

/** The schema's files: configured paths, else what a codegen/graphql-config file names, else every SDL file. */
async function schemaFiles($: EngineInterface, root: string, settings: Settings): Promise<string[]> {
  let pointers = settings.schemaPaths
  if (pointers.length === 0) {
    for (const name of CONFIG_FILES) {
      const text = await $.fs.read(`${root}/${name}`).catch(() => undefined)
      if (text !== undefined) pointers = schemaPointers(text)
      if (pointers.length > 0) break
    }
  }
  if (pointers.length === 0) return findFiles($, root, path => SDL_FILE.test(path) || INTROSPECTION_FILE.test(path))
  const literal = pointers.filter(pointer => !/[*?{]/.test(pointer))
  const globs = pointers.filter(pointer => /[*?{]/.test(pointer)).map(globToRegExp)
  const globbed = globs.length === 0 ? [] : await findFiles($, root, path => globs.some(glob => glob.test(path)))
  return [...new Set([...literal, ...globbed])]
}

/** Reads and parses the schema, storing it (or why there is none) in the state. */
async function loadSchema($: EngineInterface, settings: Settings): Promise<GraphqlContextSchema | null> {
  const root = await $.session.root()
  const files = await schemaFiles($, root, settings)
  const sdl: { file: string; text: string }[] = []
  const introspected: GqlType[] = []
  let roots: GraphqlContextSchema['roots'] | undefined
  for (const file of files) {
    const stat = await $.fs.stat(`${root}/${file}`).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file' || stat.size > MAX_FILE_BYTES) continue
    const text = await $.fs.read(`${root}/${file}`).catch(() => '')
    if (/\.json$/i.test(file)) {
      const schema = parseIntrospection(text)
      if (schema === undefined) continue
      introspected.push(...schema.types)
      roots ??= schema.roots
      sdl.push({ file, text: '' })
    } else if (definesTypes(text)) {
      sdl.push({ file, text })
    }
  }
  const parsed = parseSdl(sdl.map(source => source.text))
  const names = new Set(parsed.types.map(type => type.name))
  const types = [...parsed.types, ...introspected.filter(type => !names.has(type.name))]
  if (types.length === 0) {
    await update($, schemaAtom, () => null)
    await update($, problemAtom, () => (files.length === 0 ? 'No GraphQL schema files found.' : `No type definitions in ${files.slice(0, 3).join(', ')}.`))
    return null
  }
  const schema: GraphqlContextSchema = {
    files: sdl.map(source => source.file),
    roots: introspected.length > 0 && parsed.types.length === 0 && roots !== undefined ? roots : parsed.roots,
    types,
    loadedAt: await $.clock.now(),
  }
  await update($, schemaAtom, () => schema)
  await update($, problemAtom, () => null)
  return schema
}

/** Loads the schema once at a time; a failure is kept as the problem the pane shows. */
async function reload($: EngineInterface, settings: Settings, loader: Loader): Promise<GraphqlContextSchema | null> {
  loader.running ??= loadSchema($, settings)
    .catch(async (error: unknown) => {
      await update($, problemAtom, () => `Could not read the schema: ${errorText(error)}`)
      return null
    })
    .finally(() => {
      loader.running = undefined
    })
  return loader.running
}

async function copySchema($: EngineInterface, text: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Schema copied' : `Could not copy (${copied.reason})`)
}

async function queueForClaude($: EngineInterface): Promise<void> {
  await update($, queuedAtom, () => true)
  $.ui.toast('Claude gets the schema with your next prompt')
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    schemaPaths: String(options.schemaPaths ?? '')
      .split(',')
      .map(path => path.trim().replace(/^\.\//, ''))
      .filter(Boolean),
    maxChars: Math.min(40_000, Math.max(1_000, Math.round(Number(options.maxChars) || DEFAULT_MAX_CHARS))),
  }
  const loader: Loader = {}

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'gql-schema',
      description: 'Show the compact GraphQL schema Claude is given when you work on GraphQL',
      argumentHint: '[type or field filter | reload]',
    })
    $.clock.after(0, () => void reload($, settings, loader))
    return next(e)
  })

  on('command.run', { command: 'gql-schema' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg.toLowerCase() === 'reload' || (await read($, schemaAtom)) === null) {
      const schema = await reload($, settings, loader)
      if (arg.toLowerCase() === 'reload') return { text: schema === null ? ((await read($, problemAtom)) ?? 'No schema found.') : `Reloaded: ${describeSchema(schema)}.` }
    }
    await update($, filterAtom, () => arg)
    await $.ui.open({ id: PANE, title: 'GraphQL schema', focus: true }).catch(() => undefined)
    const schema = await read($, schemaAtom)
    if (schema === null) {
      const hint = settings.schemaPaths.length === 0 ? ' Set schemaPaths in the plugin config if it lives somewhere unusual.' : ''
      return { text: `${(await read($, problemAtom)) ?? 'No schema found.'}${hint}` }
    }
    return { text: `${describeSchema(schema)}.` }
  })

  // The conversation is given the schema once; after /clear or a compaction it may need it again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, givenAtom, () => false)
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    await update($, givenAtom, () => false)
    return compacted
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') return next(e)
    const isQueued = await read($, queuedAtom)
    if (!isQueued && (await read($, givenAtom))) return next(e)
    const schema = await read($, schemaAtom)
    if (schema === null || (!isQueued && !isAboutGraphql(e.text, schema))) return next(e)
    const entered = await next({ ...e, context: [...(e.context ?? []), contextBlock(schema, settings.maxChars)] })
    if (entered.drop === undefined) {
      await update($, givenAtom, () => true)
      await update($, queuedAtom, () => false)
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Read', 'Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = e.tool === 'Write' ? e.content : e.tool === 'Edit' ? e.new_string : (ran.text ?? '')
    if (!isGraphqlFile(e.file_path, text)) return ran
    const schema = await read($, schemaAtom)
    const file = relativeTo(await $.session.root(), e.file_path)
    const isSchemaFile = schema?.files.includes(file) === true || (SDL_FILE.test(file) && definesTypes(text))
    if (e.tool !== 'Read' && isSchemaFile) $.clock.after(0, () => void reload($, settings, loader))
    if (schema === null || isSchemaFile || (await read($, givenAtom))) return ran
    await update($, givenAtom, () => true)
    return { ...ran, context: [...(ran.context ?? []), contextBlock(schema, settings.maxChars)] }
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: the tool never runs twice

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const schema = await read($, schemaAtom)
    const filter = await read($, filterAtom)
    if (schema === null) {
      const problem = await read($, problemAtom)
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{problem ?? 'Reading the GraphQL schema…'}</Text>
          <Box gap={1}>
            <Button key="reload" label="Look again" hotkey="r" onPress={() => void reload($, settings, loader)} />
            <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }
    const isGiven = await read($, givenAtom)
    const isQueued = await read($, queuedAtom)
    const matches = filter === '' ? [] : filterSchema(schema, filter)
    const source = filter === '' ? compactSchema(schema, MAX_SHOWN_CHARS).text : matches.map(fullText).join('\n\n').slice(0, MAX_SHOWN_CHARS)
    const setFilter = (value: string) => void update($, filterAtom, () => value.trim())
    const field = () => {
      if (e.surface === 'mobile') return filter === '' ? null : <Text dimColor>{`Filter: ${filter}`}</Text>
      const { Input } = $.ui.resolve(e)
      return <Input key="filter" placeholder="Filter by type or field name" submitLabel="filter" value={filter} onInput={setFilter} onSubmit={setFilter} />
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box gap={1} flexWrap="wrap">
            <Text bold>GraphQL schema</Text>
            <Text dimColor>{countText(schema, ' · ')}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`from ${schema.files.join(', ')}`}</Text>
          <Text color={isGiven ? 'success' : isQueued ? 'suggestion' : 'inactive'}>
            {isGiven ? '✓ Claude has it in this conversation' : isQueued ? '→ goes to Claude with your next prompt' : '○ given to Claude when a prompt or a file touches GraphQL'}
          </Text>
        </Box>
        {field()}
        {filter !== '' && <Text dimColor>{matches.length === 0 ? `No type or field matches "${filter}".` : `${matches.length} type${matches.length === 1 ? '' : 's'} match "${filter}"`}</Text>}
        {source !== '' && <Code source={source} language="graphql" />}
        <Box gap={1} flexWrap="wrap">
          {!isGiven && !isQueued && <Button key="attach" label="Attach to next prompt" hotkey="a" variant="primary" onPress={() => void queueForClaude($)} />}
          <Button key="copy" label="Copy" hotkey="c" onPress={press => void copySchema($, source, press.surface)} />
          <Button key="reload" label="Reload" hotkey="r" onPress={() => void reload($, settings, loader)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'graphql-context', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

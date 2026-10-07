import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecallHit, RecallMemory, RecallResults } from '../types'
import { chunkMarkdown, formatHits, search } from './search'
import type { Chunk } from './search'

const NAME = 'recall'
const TOOL_NAME = 'mcp__recall__search'
const PANE = 'recall'
const STORE_KEY = 'memories'
const MAX_MEMORIES = 500
const MAX_MEMORY_CHARS = 2_000
const MAX_FILES = 400
const MAX_FILE_BYTES = 512 * 1024
const MAX_DEPTH = 4
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const MEMORIES_SHOWN = 8
const PREVIEW_CHARS = 80
const NOTE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']
const NOTE_DIRS = ['.claude/journal', 'docs/decisions', 'docs/adr', 'doc/adr', '.claude/handoff']
const NOTE_FILE = /\.(md|mdx|markdown|txt)$/i
const GLOBAL_FLAG = /^(-g|--global)(\s+|$)/

const TOOL_DESCRIPTION =
  "Search this project's saved knowledge: memories saved with /remember, CLAUDE.md, the session journal " +
  '(.claude/journal), decision records (docs/decisions, docs/adr) and handoff notes (.claude/handoff). ' +
  'Returns the best-matching passages ranked by relevance (BM25), each with its file and line. Use it before ' +
  'deciding something that may already have been decided, when the user refers to earlier work or "what we ' +
  'agreed", or to recall project conventions. Query with a few distinctive keywords rather than a sentence.'
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'A few distinctive keywords, e.g. "postgres migration rollback".' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `How many passages to return (default ${DEFAULT_LIMIT}).` },
  },
  required: ['query'],
}

const resultsAtom = atom({ plugin: 'recall', key: 'results' } as const, null)
const memoriesAtom = atom({ plugin: 'recall', key: 'memories' } as const, [])
const busyAtom = atom({ plugin: 'recall', key: 'isBusy' } as const, false)

type Settings = { limit: number; extraPaths: string[] }

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const resolvePath = (root: string, path: string): string => (path.startsWith('/') ? path : `${root}/${path}`)

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const preview = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text)

const isMemory = (value: unknown): value is RecallMemory => {
  if (typeof value !== 'object' || value === null) return false
  const memory = value as Partial<RecallMemory>
  return typeof memory.id === 'string' && typeof memory.text === 'string' && typeof memory.createdAt === 'number'
}

const inProject = (memories: readonly RecallMemory[], root: string): RecallMemory[] =>
  memories.filter(memory => memory.project === root || memory.project === null)

const hitsMarkdown = (hits: readonly RecallHit[]): string =>
  hits
    .map((hit, index) => {
      const where = hit.source === 'memory' ? `memory · ${hit.title}` : `${hit.source} › ${hit.title} · line ${hit.line}`
      return `${index + 1}. **${where}**\n   ${hit.snippet}`
    })
    .join('\n')

async function loadMemories($: EngineInterface): Promise<RecallMemory[]> {
  try {
    const stored = await $.store.get(STORE_KEY)
    return Array.isArray(stored) ? stored.filter(isMemory) : []
  } catch {
    return []
  }
}

async function walkNotes($: EngineInterface, root: string, dir: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return
  let entries
  try {
    entries = await $.fs.list(resolvePath(root, dir))
  } catch {
    return // Not there: nothing to search.
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_FILES) return
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir') await walkNotes($, root, path, depth + 1, found)
    if (entry.kind === 'file' && NOTE_FILE.test(entry.name) && entry.size <= MAX_FILE_BYTES) found.push(path)
  }
}

async function noteFiles($: EngineInterface, root: string, extraPaths: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const path of [...NOTE_FILES, ...extraPaths]) {
    const stat = await $.fs.stat(resolvePath(root, path)).catch(() => undefined)
    if (stat?.kind === 'file' && stat.size <= MAX_FILE_BYTES) found.push(path)
    if (stat?.kind === 'dir') await walkNotes($, root, path, 1, found)
  }
  for (const dir of NOTE_DIRS) await walkNotes($, root, dir, 1, found)
  return [...new Set(found)].slice(0, MAX_FILES)
}

async function runSearch($: EngineInterface, settings: Settings, query: string, limit: number): Promise<RecallResults> {
  const root = await $.session.root()
  const files = await noteFiles($, root, settings.extraPaths)
  const chunks: Chunk[] = []
  for (const path of files) {
    try {
      chunks.push(...chunkMarkdown(path, await $.fs.read(resolvePath(root, path))))
    } catch {
      // Unreadable (binary, permissions, vanished): skip it.
    }
  }
  const memories = inProject(await loadMemories($), root)
  for (const memory of memories) {
    const title = `${day(memory.createdAt)}${memory.project === null ? ' (global)' : ''}`
    chunks.push({ source: 'memory', title, line: 0, text: memory.text })
  }
  const searched = `searched ${plural(files.length, 'file', 'files')} and ${plural(memories.length, 'memory', 'memories')}`
  const hits = search(chunks, query, limit).map(({ source, title, line, snippet, score }) => ({ source, title, line, snippet, score }))
  return { query, hits, searched }
}

async function searchIntoPane($: EngineInterface, settings: Settings, query: string): Promise<RecallResults | undefined> {
  const trimmed = query.trim()
  if (trimmed === '') return undefined
  await update($, busyAtom, () => true)
  try {
    const results = await runSearch($, settings, trimmed, settings.limit)
    await update($, resultsAtom, () => results)
    return results
  } finally {
    await update($, busyAtom, () => false)
  }
}

async function showMemories($: EngineInterface): Promise<RecallMemory[]> {
  const memories = inProject(await loadMemories($), await $.session.root())
  await update($, memoriesAtom, () => memories)
  return memories
}

async function forget($: EngineInterface, id: string): Promise<void> {
  const all = await loadMemories($)
  const gone = all.find(memory => memory.id === id)
  await $.store.set(STORE_KEY, all.filter(memory => memory.id !== id))
  await showMemories($)
  if (gone !== undefined) $.ui.toast(`Forgot "${preview(gone.text)}"`)
}

async function registerAll($: EngineInterface): Promise<void> {
  const steps = [
    () => $.tool.register({ name: 'search', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA }),
    () => $.command.register({ name: 'remember', description: 'Save a memory Claude can find with the recall tool', argumentHint: '[-g] <text>' }),
    () => $.command.register({ name: 'recall', description: 'Search your notes, decisions, journal and memories', argumentHint: '[query]' }),
  ]
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      $.ui.log(`${NAME}: registration failed: ${errorText(error)}`, { to: 'debug' })
    }
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    limit: clamp(options.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
    extraPaths: String(options.paths ?? '')
      .split(',')
      .map(path => path.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  }

  on('session.start', async ($, e, next) => {
    await registerAll($)
    return next(e)
  })

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    const query = typeof e.query === 'string' ? e.query.trim() : ''
    if (query === '') {
      return { result: `${NAME}: the query is empty; pass a few keywords, e.g. {"query": "database choice"}.` }
    }
    try {
      const results = await runSearch($, settings, query, clamp(e.limit, 1, MAX_LIMIT, settings.limit))
      return { result: formatHits(results.query, results.hits, results.searched) }
    } catch (error) {
      return { result: `${NAME}: the search failed (${errorText(error)}).` }
    }
  })

  // A read-only search of local notes: skip the permission prompt unless a rule or a ceiling asks for one.
  on('tool.check', { tool: TOOL_NAME }, async ($, e, next) => {
    const verdict = await next(e)
    const isDefaultAsk = verdict.decision === 'ask' && verdict.rule === undefined && e.ceiling === undefined
    return isDefaultAsk ? { ...verdict, decision: 'allow', reason: `${NAME}: read-only search of local notes` } : verdict
  })

  on('command.run', { command: 'remember' }, async ($, e) => {
    const raw = e.args.trim()
    const isGlobal = GLOBAL_FLAG.test(raw)
    const text = raw.replace(GLOBAL_FLAG, '').trim().slice(0, MAX_MEMORY_CHARS)
    const root = await $.session.root()
    const all = await loadMemories($)
    const here = inProject(all, root)
    if (text === '') {
      return {
        text: `Usage: /remember <something worth keeping> (add -g to share it with every project). ` +
          `${plural(here.length, 'memory', 'memories')} here; /recall lists them.`,
      }
    }
    if (here.some(memory => memory.text === text)) return { text: `Already remembered "${preview(text)}".` }
    const memory: RecallMemory = {
      id: `${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      project: isGlobal ? null : root,
      createdAt: await $.clock.now(),
    }
    await $.store.set(STORE_KEY, [...all, memory].slice(-MAX_MEMORIES))
    const count = (await showMemories($)).length
    return {
      text: `Remembered${isGlobal ? ' for every project' : ''}: "${preview(text)}" ` +
        `(${plural(count, 'memory', 'memories')} here; Claude finds them with the recall tool).`,
    }
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    const memories = await showMemories($)
    await $.ui.open({ id: PANE, title: 'Recall', rows: 22 })
    const query = e.args.trim()
    if (query === '') {
      return { text: `${plural(memories.length, 'memory', 'memories')} here. Search from the pane, or run /recall <words>.` }
    }
    const results = await searchIntoPane($, settings, query)
    const found = results?.hits.length ?? 0
    return { text: `${plural(found, 'match', 'matches')} for "${query}" (${results?.searched ?? 'nothing searched'}).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const results = await read($, resultsAtom)
    const memories = await read($, memoriesAtom)
    const isBusy = await read($, busyAtom)
    const shown = memories.slice(-MEMORIES_SHOWN).reverse()

    return (
      <Box flexDirection="column" gap={1}>
        {Input !== undefined && (
          <Input
            key="query"
            label="Search "
            placeholder="keywords from notes, decisions, journal, memories…"
            value={results?.query ?? ''}
            submitLabel="search"
            autoFocus
            onSubmit={value => void searchIntoPane($, settings, value)}
          />
        )}
        {isBusy && <Text color="suggestion">Searching…</Text>}
        {results !== null && (
          <Box flexDirection="column">
            <Text bold>{`${plural(results.hits.length, 'match', 'matches')} for "${results.query}"`}</Text>
            <Text dimColor>{results.searched}</Text>
          </Box>
        )}
        {results !== null && results.hits.length > 0 && <Markdown key="results" text={hitsMarkdown(results.hits)} />}
        <Box flexDirection="column">
          <Text bold>{`Memories (${memories.length})`}</Text>
          {shown.length === 0 && <Text dimColor>{'None yet. Save one with /remember <text>.'}</Text>}
          {shown.map(memory => (
            <Box key={`memory:${memory.id}`} gap={1}>
              <Button key={`forget:${memory.id}`} label="Forget" dimColor onPress={() => void forget($, memory.id)} />
              <Text dimColor>{day(memory.createdAt)}</Text>
              <Text wrap="truncate-end">{memory.text}</Text>
            </Box>
          ))}
          {memories.length > shown.length && <Text dimColor>{`… and ${memories.length - shown.length} older`}</Text>}
        </Box>
        <Box>
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

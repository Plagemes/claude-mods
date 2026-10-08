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
/** The hub's topics recall indexes, and how many of each it reads. */
const HUB_TOPICS = ['decision.recorded', 'lesson.learned'] as const
const MAX_HUB_EVENTS = 50

const TOOL_DESCRIPTION =
  "Search this project's saved notes: /remember memories, CLAUDE.md, the journal, decision records and handoff notes. " +
  'Returns the best-matching passages with file and line. Use it before deciding something that may already be decided, ' +
  'or when the user refers to earlier work.'
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'A few distinctive keywords.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Passages to return (default ${DEFAULT_LIMIT}).` },
  },
  required: ['query'],
}

const resultsAtom = atom({ plugin: 'recall', key: 'results' } as const, null)
const memoriesAtom = atom({ plugin: 'recall', key: 'memories' } as const, [])
const busyAtom = atom({ plugin: 'recall', key: 'isBusy' } as const, false)

type Settings = { limit: number; extraPaths: string[] }

/** Whether this load has registered the search tool (it waits until there are notes to search). */
type Offer = { isOffered: boolean }

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
      const where = hit.source === 'memory' || hit.source === 'hub' ? `${hit.source} · ${hit.title}` : `${hit.source} › ${hit.title} · line ${hit.line}`
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

// ── mods-hub: decisions and lessons other mods record ───────────────────────────────────────────────

/** A decision or lesson as another mod published it: where its file is (when it has one), and its words. */
type Recorded = { path: string | undefined; title: string; text: string }

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [...HUB_TOPICS] })
}

const field = (data: unknown, key: string): string => {
  const value = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The decisions (decision-log) and lessons (lessons-learned) published on mods-hub's bus this session; none
 * without the hub. Their files are searched like any note, even outside the folders recall knows.
 */
async function recordedOnHub($: EngineInterface): Promise<Recorded[]> {
  const recorded: Recorded[] = []
  for (const topic of HUB_TOPICS) {
    try {
      for (const event of await $.mods.recent({ topic, limit: MAX_HUB_EVENTS })) {
        const path = field(event.data, 'path') || undefined
        if (topic === 'decision.recorded') {
          const title = field(event.data, 'title')
          if (title !== '') recorded.push({ path, title: `decision · ${title}`, text: [title, field(event.data, 'summary')].filter(Boolean).join('\n') })
        } else {
          const lesson = field(event.data, 'lesson')
          if (lesson !== '') recorded.push({ path, title: 'lesson', text: [lesson, field(event.data, 'context')].filter(Boolean).join('\n') })
        }
      }
    } catch {
      return [] // No hub.
    }
  }
  return recorded
}

async function runSearch($: EngineInterface, settings: Settings, query: string, limit: number): Promise<RecallResults> {
  const root = await $.session.root()
  const recorded = await recordedOnHub($)
  const listed = await noteFiles($, root, settings.extraPaths)
  const extra = recorded.flatMap(one => (one.path !== undefined && NOTE_FILE.test(one.path) && !listed.includes(one.path) ? [one.path] : []))
  const files = [...new Set([...listed, ...extra])]
  const chunks: Chunk[] = []
  const readFiles: string[] = []
  for (const path of files) {
    try {
      chunks.push(...chunkMarkdown(path, await $.fs.read(resolvePath(root, path))))
      readFiles.push(path)
    } catch {
      // Unreadable (binary, permissions, vanished): skip it.
    }
  }
  // A recorded decision or lesson whose file was read is already searched; the others are searched as they were published.
  const events = recorded.filter(one => one.path === undefined || !readFiles.includes(one.path))
  for (const one of events) chunks.push({ source: 'hub', title: one.title, line: 0, text: one.text })
  const memories = inProject(await loadMemories($), root)
  for (const memory of memories) {
    const title = `${day(memory.createdAt)}${memory.project === null ? ' (global)' : ''}`
    chunks.push({ source: 'memory', title, line: 0, text: memory.text })
  }
  // A recorded file that could not be read was not searched (the notes recall lists count as before).
  const searchedFiles = listed.length + extra.filter(path => readFiles.includes(path)).length
  const counted = [plural(searchedFiles, 'file', 'files'), plural(memories.length, 'memory', 'memories')]
  if (events.length > 0) counted.push(plural(events.length, 'hub event', 'hub events'))
  const searched = `searched ${counted.slice(0, -1).join(', ')} and ${counted.at(-1) ?? ''}`
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

/** Whether anything is there to search: a memory for this project, or one of the note files or folders. */
async function hasNotes($: EngineInterface, settings: Settings): Promise<boolean> {
  const root = await $.session.root()
  if (inProject(await loadMemories($), root).length > 0) return true
  const paths = [...NOTE_FILES, ...settings.extraPaths, ...NOTE_DIRS]
  const stats = await Promise.all(paths.map(path => $.fs.stat(resolvePath(root, path)).catch(() => undefined)))
  return stats.some(stat => stat !== undefined)
}

/** Registers the search tool once there is something to search; a project with no notes never pays for its description. */
async function offerSearch($: EngineInterface, state: Offer, settings: Settings, isKnown = false): Promise<void> {
  if (state.isOffered) return
  try {
    if (!isKnown && !(await hasNotes($, settings))) return
    await $.tool.register({ name: 'search', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA })
    state.isOffered = true
  } catch (error) {
    $.ui.log(`${NAME}: registration failed: ${errorText(error)}`, { to: 'debug' })
  }
}

async function registerCommands($: EngineInterface): Promise<void> {
  const steps = [
    () => registerCommand($, { name: 'remember', description: 'Save a memory Claude can find with the recall tool', argumentHint: '[-g] <text>' }),
    () => registerCommand($, { name: 'recall', description: 'Search your notes, decisions, journal and memories', argumentHint: '[query]' }),
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

  const offer: Offer = { isOffered: false }

  on('session.start', async ($, e, next) => {
    await registerCommands($)
    await offerSearch($, offer, settings)
    afterStart($, 'recall', () => greetHub($))
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
    await offerSearch($, offer, settings, true)
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

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts

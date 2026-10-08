import type { EngineInterface, PluginOptions, Register } from 'claude-code'

const MOD = 'glossary'
const MARKDOWN_FILE = 'GLOSSARY.md'
const JSON_FILE = '.claude/glossary.json'
const DEFAULT_MAX_TERMS = 12
const DEFINITION_CHARS = 500
const TERM_CHARS = 60
const TERM_WORDS = 6
const LISTED_MAX = 200
/** The fact shared with mods-hub keeps each definition short and the whole under the hub's 16 000 characters. */
const FACT_DEFINITION_CHARS = 200
const FACT_CHARS = 15_000

type Source = '/define' | typeof JSON_FILE | typeof MARKDOWN_FILE
/** One term: the names it is matched by (the term and any alias in parentheses) and its definition. */
type Entry = { term: string; names: string[]; definition: string; source: Source }
type Settings = { maxTerms: number; repeat: boolean }
type FileCache = Map<string, { mtimeMs: number; entries: Entry[] }>
/** What this load remembers: parsed files by mtime, what this conversation was already told, and the fact last shared with mods-hub. */
type Memory = { files: FileCache; told: Map<string, string>; isHubbed: boolean; shared: string | undefined }

function readSettings(options: PluginOptions): Settings {
  const max = typeof options.maxTermsPerPrompt === 'number' ? Math.floor(options.maxTermsPerPrompt) : DEFAULT_MAX_TERMS

  return { maxTerms: Math.max(1, max), repeat: options.repeatDefinitions === true }
}

const storeKey = (root: string): string => `terms:${root}`
const keyOf = (term: string): string => term.trim().toLowerCase()
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Cleans a raw term and splits off an alias: "Bounded Context (BC)" names both. */
function entryOf(rawTerm: string, rawDefinition: string, source: Source): Entry | undefined {
  const term = rawTerm.replace(/\*\*|__|`/g, '').replace(/[:\s]+$/, '').trim()
  const definition = rawDefinition.replace(/\s+/g, ' ').trim()
  const isTermLike = term.length > 0 && term.length <= TERM_CHARS && term.split(/\s+/).length <= TERM_WORDS
  if (!isTermLike || !definition) return undefined

  const alias = /^(.+?)\s*\(([^)]+)\)$/.exec(term)
  const names = alias ? [alias[1]!.trim(), alias[2]!.trim()] : [term]
  const capped = definition.length > DEFINITION_CHARS ? `${definition.slice(0, DEFINITION_CHARS - 1)}…` : definition

  return { term, names, definition: capped, source }
}

const BULLET = /^[-*+]\s+(?:\*\*(.+?)\*\*|`(.+?)`|([^:—–]+?))\s*(?::|—|–|\s-\s)\s*(.+)$/
const BOLD_LINE = /^\*\*(.+?)\*\*\s*(?::|—|–|\s-\s)?\s*(.+)$/
const HEADING = /^#{2,4}\s+(.+)$/
const SEPARATOR_CELL = /^:?-{3,}:?$/

/** Reads the common glossary layouts: bullets, bold lines, tables, headings over a paragraph, `Term` / `: definition`. */
function parseMarkdown(text: string): Entry[] {
  const lines = text.split(/\r?\n/)
  const entries: Entry[] = []
  const add = (term: string | undefined, definition: string | undefined): void => {
    const entry = entryOf(term ?? '', definition ?? '', MARKDOWN_FILE)
    if (entry) entries.push(entry)
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    const next = (lines[i + 1] ?? '').trim()
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      const isHeader = next.startsWith('|') && next.replace(/^\||\|$/g, '').split('|').every(cell => SEPARATOR_CELL.test(cell.trim()))
      if (!isHeader && cells.length >= 2 && !cells.every(cell => SEPARATOR_CELL.test(cell))) add(cells[0], cells[1])
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      add(bullet[1] ?? bullet[2] ?? bullet[3], bullet[4])
      continue
    }
    const bold = BOLD_LINE.exec(line)
    if (bold) {
      add(bold[1], bold[2])
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const paragraph: string[] = []
      let j = i + 1
      while (j < lines.length && !(lines[j] ?? '').trim()) j += 1
      while (j < lines.length && (lines[j] ?? '').trim() && !/^(#|[-*+]\s|\|)/.test((lines[j] ?? '').trim())) {
        paragraph.push((lines[j] ?? '').trim())
        j += 1
      }
      if (paragraph.length > 0) add(heading[1], paragraph.join(' '))
      continue
    }
    if (line && next.startsWith(': ') && !line.startsWith('#')) add(line, next.slice(2))
  }
  return entries
}

/** `{ "term": "definition" }`, `{ "terms": {...} }` or `[{ "term", "definition" }]`. */
function parseJson(text: string): Entry[] {
  const parsed: unknown = JSON.parse(text)
  const body = typeof parsed === 'object' && parsed !== null && 'terms' in parsed ? (parsed as { terms: unknown }).terms : parsed
  const pairs: [string, unknown][] = Array.isArray(body)
    ? body.map((item: Record<string, unknown>) => [String(item?.term ?? item?.name ?? ''), item?.definition ?? item?.meaning ?? item?.description])
    : typeof body === 'object' && body !== null
      ? Object.entries(body)
      : []

  return pairs.flatMap(([term, definition]) => {
    const entry = typeof definition === 'string' ? entryOf(term, definition, JSON_FILE) : undefined
    return entry ? [entry] : []
  })
}

/** A glossary file's entries, parsed again only when its modification time moved; none when missing or broken. */
async function fileEntries($: EngineInterface, path: string, files: FileCache, parse: (text: string) => Entry[]): Promise<Entry[]> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return []
  const cached = files.get(path)
  if (cached?.mtimeMs === stat.mtimeMs) return cached.entries
  let entries: Entry[] = []
  try {
    const text = await $.fs.read(path)
    entries = typeof text === 'string' ? parse(text) : []
  } catch {
    entries = []
  }
  files.set(path, { mtimeMs: stat.mtimeMs, entries })

  return entries
}

async function definedTerms($: EngineInterface, root: string): Promise<Record<string, string>> {
  const stored = await $.store.get(storeKey(root))
  return typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {}
}

/** Every known term, one per name: /define wins over glossary.json, which wins over GLOSSARY.md. */
async function loadGlossary($: EngineInterface, files: FileCache): Promise<Entry[]> {
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  const defined = Object.entries(await definedTerms($, root)).flatMap(([term, definition]) => {
    const entry = entryOf(term, definition, '/define')
    return entry ? [entry] : []
  })
  const ordered = [
    ...defined,
    ...(await fileEntries($, `${root}/${JSON_FILE}`, files, parseJson)),
    ...(await fileEntries($, `${root}/${MARKDOWN_FILE}`, files, parseMarkdown)),
  ]
  const seen = new Set<string>()

  return ordered.filter(entry => {
    const keys = entry.names.map(keyOf)
    if (keys.some(key => seen.has(key))) return false
    keys.forEach(key => seen.add(key))
    return true
  })
}

/** The entries whose names appear in `text` as whole words (a plural `s`/`es` allowed), case-insensitively. */
function mentioned(entries: readonly Entry[], text: string): Entry[] {
  return entries.filter(entry =>
    entry.names.some(name => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?:e?s)?(?![\\p{L}\\p{N}_])`, 'iu').test(text)),
  )
}

function noteOf(entries: readonly Entry[]): string {
  const lines = entries.map(entry => `- **${entry.term}**: ${entry.definition}`)
  return `Project glossary — definitions of terms used in this message:\n${lines.join('\n')}`
}

async function define($: EngineInterface, args: string): Promise<string> {
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  const [rawTerm = '', ...rest] = args.split('=')
  const term = rawTerm.trim()
  const definition = rest.join('=').trim()
  if (!term) return `${MOD}: usage /define <term> = <meaning>, e.g. /define tenant = a customer organisation with its own data`

  const defined = await definedTerms($, root)
  const existing = Object.keys(defined).find(key => keyOf(key) === keyOf(term))
  if (!args.includes('=')) {
    return existing ? `📖 ${existing}: ${defined[existing]}` : `${MOD}: “${term}” is not defined with /define. /glossary lists every term.`
  }
  if (!definition) return `${MOD}: give a meaning after "=". To delete a term: /glossary remove ${term}`
  if (!entryOf(term, definition, '/define')) return `${MOD}: a term is at most ${TERM_WORDS} words and ${TERM_CHARS} characters.`

  const next = { ...defined }
  if (existing) delete next[existing]
  next[term] = definition
  await $.store.set(storeKey(root), next)

  return `📖 ${MOD}: ${existing ? 'updated' : 'defined'} “${term}”. Claude will see it whenever you use the term.`
}

async function glossaryCommand($: EngineInterface, args: string, files: FileCache): Promise<string> {
  const [action = '', ...rest] = args.trim().split(/\s+/)
  if (action === 'remove') {
    const term = rest.join(' ')
    const root = (await $.session.root()).replace(/[\\/]+$/, '')
    const defined = await definedTerms($, root)
    const existing = Object.keys(defined).find(key => keyOf(key) === keyOf(term))
    if (!existing) return `${MOD}: “${term}” was not added with /define; edit ${MARKDOWN_FILE} or ${JSON_FILE} to change file terms.`
    const next = { ...defined }
    delete next[existing]
    await $.store.set(storeKey(root), next)
    return `🗑 ${MOD}: removed “${existing}”.`
  }
  const entries = await loadGlossary($, files)
  if (entries.length === 0) {
    return `${MOD}: no terms yet. Add ${MARKDOWN_FILE} or ${JSON_FILE} to the project, or /define <term> = <meaning>.`
  }
  const lines = entries.slice(0, LISTED_MAX).map(entry => `- ${entry.term}: ${entry.definition} (${entry.source})`)
  const more = entries.length > LISTED_MAX ? `\n… and ${entries.length - LISTED_MAX} more` : ''

  return `📖 ${entries.length} glossary terms\n${lines.join('\n')}${more}`
}

/** The entries to define for `text`, at most `maxTerms`; marks them told so a conversation hears each once. */
async function termsFor($: EngineInterface, text: string, memory: Memory, settings: Settings): Promise<Entry[]> {
  const all = await loadGlossary($, memory.files)
  await shareTerms($, memory, all)
  const found = mentioned(all, text)
  const fresh = settings.repeat ? found : found.filter(entry => memory.told.get(keyOf(entry.term)) !== entry.definition)
  const chosen = fresh.slice(0, settings.maxTerms)
  for (const entry of chosen) memory.told.set(keyOf(entry.term), entry.definition)

  return chosen
}

/** Shares the glossary as it is now, after a command changed it; nothing without a hub. */
async function refreshTerms($: EngineInterface, memory: Memory): Promise<void> {
  if (memory.isHubbed) await shareTerms($, memory, await loadGlossary($, memory.files))
}

/** The fact `glossary.terms`: every term with a short definition and where it came from, cut to the hub's limit. */
function factOf(entries: readonly Entry[]): { count: number; isCut: boolean; terms: { term: string; definition: string; source: Source }[] } {
  const fact = { count: entries.length, isCut: false, terms: [] as { term: string; definition: string; source: Source }[] }
  let size = JSON.stringify(fact).length
  for (const entry of entries) {
    const definition = entry.definition.length > FACT_DEFINITION_CHARS ? `${entry.definition.slice(0, FACT_DEFINITION_CHARS - 1)}…` : entry.definition
    const term = { term: entry.term, definition, source: entry.source }
    size += JSON.stringify(term).length + 1
    if (size > FACT_CHARS) {
      fact.isCut = true
      break
    }
    fact.terms.push(term)
  }
  return fact
}

/** Puts the glossary on mods-hub's blackboard (read by other mods as `glossary.terms`) when it changed; nothing without a hub. */
async function shareTerms($: EngineInterface, memory: Memory, entries: readonly Entry[]): Promise<void> {
  if (!memory.isHubbed) return
  const fact = factOf(entries)
  const json = JSON.stringify(fact)
  if (json === memory.shared) return
  try {
    await $.mods.share({ name: 'terms', value: fact })
    memory.shared = json
  } catch {
    // The hub refused the fact or went away: the glossary still works for this mod.
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed, and shares the terms. */
async function greetHub($: EngineInterface, memory: Memory): Promise<void> {
  if ((await hubMode($)) === undefined) return
  memory.isHubbed = true
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
  await shareTerms($, memory, await loadGlossary($, memory.files))
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const memory: Memory = { files: new Map(), told: new Map(), isHubbed: false, shared: undefined }

  on('session.start', async ($, e, next) => {
    memory.told.clear()
    await registerCommand($, { name: 'define', description: 'Add a term to the project glossary', argumentHint: '<term> = <meaning>' })
    await registerCommand($, { name: 'glossary', description: 'List glossary terms, or remove one', argumentHint: '[remove <term>]' })
    afterStart($, 'glossary', () => greetHub($, memory))

    return next(e)
  })

  on('command.run', { command: 'define' }, async ($, e) => {
    const text = await define($, e.args)
    await refreshTerms($, memory)
    return { text }
  })

  on('command.run', { command: 'glossary' }, async ($, e) => {
    const text = await glossaryCommand($, e.args, memory.files)
    await refreshTerms($, memory)
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (!text || text.startsWith('/')) return next(e)

    const chosen = await termsFor($, text, memory, settings)
    if (chosen.length === 0) return next(e)
    $.ui.status(`📖 ${chosen.length === 1 ? `glossary: ${chosen[0]?.term}` : `glossary: ${chosen.length} terms`}`)

    return next({ ...e, context: [...(e.context ?? []), noteOf(chosen)] })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) $.ui.status(undefined)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    memory.told.clear()

    return result
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') memory.told.clear()

    return next(e)
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

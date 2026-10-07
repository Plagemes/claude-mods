/**
 * The catalog and the `claude plugin` CLI, pure: reading catalog.json (or the
 * marketplace file when that is all there is), the CLI's JSON, READMEs and
 * what `/mods-advisor` was typed with.
 */
import type { ProcessRunResult } from 'claude-code'

import type { AdvisorCatalog, AdvisorCategory, AdvisorInstall, AdvisorMod, AdvisorSignals } from '../types'

export const DEFAULT_REPOSITORY = 'plagemes/claude-mods'
export const DEFAULT_BRANCH = 'main'
export const DEFAULT_MARKETPLACE = 'claude-mods'
export const CATALOG_PATH = 'catalog.json'
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^[A-Za-z0-9._/-]+$/
const COMMAND = /(?:^|[\s(`'"“,])(\/[a-z][a-z0-9-]*(?::[a-z0-9-]+)?)(?=$|[\s)`'"”,.;:!?])/g
const CLAUDE_BINARY = /(^|[\\/])claude(\.exe)?$/i
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Where the catalog lives: a GitHub repository and the branch read raw. */
export type Source = { repository: string; branch: string }

export const isModName = (value: string): boolean => NAME.test(value)
export const isRepository = (value: string): boolean => REPOSITORY.test(value)
export const isBranch = (value: string): boolean => BRANCH.test(value) && !value.includes('..')

export const rawUrl = (source: Source, path: string): string =>
  `https://raw.githubusercontent.com/${source.repository}/${source.branch}/${path}`

export const readmeRawUrl = (source: Source, name: string): string => rawUrl(source, `mods/${name}/README.md`)

export const readmeUrl = (source: Source, name: string): string =>
  `https://github.com/${source.repository}/blob/${source.branch}/mods/${name}/README.md`

/** The line a person types to install a mod once the marketplace is added. */
export const installLine = (name: string, marketplace: string): string => `/plugin install ${name}@${marketplace}`

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asTexts = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asText).filter((item): item is string => item !== undefined) : []

const titleOf = (id: string): string => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())

/** A command as typed: with its slash. */
const slashed = (command: string): string => (command.startsWith('/') ? command : `/${command}`)

function parseSignals(value: unknown): AdvisorSignals | undefined {
  const record = asRecord(value)
  if (record === undefined) {
    return undefined
  }
  const signals: AdvisorSignals = {}
  if (Array.isArray(record.files)) signals.files = asTexts(record.files)
  if (Array.isArray(record.deps)) signals.deps = asTexts(record.deps)
  if (Array.isArray(record.intents)) signals.intents = asTexts(record.intents)
  if (typeof record.always === 'boolean') signals.always = record.always

  return signals
}

/** One catalog entry, or undefined when it names no valid mod. Unknown fields are ignored, missing ones tolerated. */
export function parseMod(entry: unknown): AdvisorMod | undefined {
  const record = asRecord(entry)
  const name = asText(record?.name)
  if (record === undefined || name === undefined || !isModName(name)) {
    return undefined
  }
  const tier = asText(record.tier)
  const commands = asTexts(record.commands).map(slashed)
  const keywords = asTexts(record.keywords)
  const signals = parseSignals(record.signals)

  return {
    name,
    category: (asText(record.category) ?? 'other').toLowerCase(),
    description: asText(record.description) ?? '',
    ...(tier === undefined ? {} : { tier }),
    ...(commands.length === 0 ? {} : { commands }),
    ...(keywords.length === 0 ? {} : { keywords }),
    ...(signals === undefined ? {} : { signals }),
  }
}

function parseCategories(value: unknown): AdvisorCategory[] {
  const categories: AdvisorCategory[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    const record = asRecord(entry)
    const id = asText(record?.id)?.toLowerCase()
    if (id !== undefined && !categories.some(known => known.id === id)) {
      categories.push({ id, title: asText(record?.title) ?? titleOf(id), tagline: asText(record?.tagline) ?? '' })
    }
  }

  return categories
}

function uniqueMods(entries: readonly unknown[]): AdvisorMod[] {
  const mods: AdvisorMod[] = []
  for (const entry of entries) {
    const mod = parseMod(entry)
    if (mod !== undefined && !mods.some(known => known.name === mod.name)) {
      mods.push(mod)
    }
  }

  return mods
}

/** Reads catalog.json; throws on anything that is not one. */
export function parseCatalog(text: string, source: Source, fetchedAt: number, origin: AdvisorCatalog['origin']): AdvisorCatalog {
  const root = asRecord(JSON.parse(text))
  if (root === undefined || !Array.isArray(root.mods)) {
    throw new Error('catalog.json lists no mods')
  }
  const mods = uniqueMods(root.mods)
  if (mods.length === 0) {
    throw new Error('catalog.json lists no valid mod')
  }

  return { version: asText(root.version) ?? '', ...source, fetchedAt, origin, categories: parseCategories(root.categories), mods }
}

/** Reads a marketplace file as a catalog (names, descriptions, categories and keywords; no signals); throws when it is none. */
export function parseMarketplaceCatalog(text: string, source: Source, fetchedAt: number): AdvisorCatalog {
  const root = asRecord(JSON.parse(text))
  if (root === undefined || !Array.isArray(root.plugins)) {
    throw new Error('the marketplace file lists no plugins')
  }
  const version = asText(asRecord(root.metadata)?.version) ?? asText(root.version) ?? ''

  return { version, ...source, fetchedAt, origin: 'local', categories: [], mods: uniqueMods(root.plugins) }
}

/** Whether a value read back from the store is a catalog of this source. */
export function isCatalogOf(value: unknown, source: Source): value is AdvisorCatalog {
  const record = asRecord(value)
  return (
    record !== undefined &&
    record.repository === source.repository &&
    record.branch === source.branch &&
    typeof record.version === 'string' &&
    typeof record.fetchedAt === 'number' &&
    Array.isArray(record.categories) &&
    Array.isArray(record.mods)
  )
}

// ── Commands, usage and README ───────────────────────────────────────────────

/** The slash commands a text names (`/commit`, `/eli5`), in order, each once; never a path like `pass/fail`. */
export function commandsIn(text: string): string[] {
  return [...new Set([...text.matchAll(COMMAND)].map(match => match[1] ?? '').filter(command => command !== ''))]
}

/**
 * What to type for a mod: the catalog's `commands`, the commands it registered
 * in this session (`live`), and those its description names.
 */
export const commandsOf = (mod: AdvisorMod, live: readonly string[] = []): string[] =>
  [...new Set([...(mod.commands ?? []), ...live.map(slashed), ...commandsIn(mod.description)])]

/** The one line of a tip: the description when it starts with what to type, else the command and the description. */
export function tipLine(mod: AdvisorMod, command: string): string {
  const description = mod.description.replace(/\.$/, '')
  return description.startsWith(command) ? description : `${command} — ${description.charAt(0).toLowerCase()}${description.slice(1)}`
}

/** The body of a README's `## Usage` section (up to the next `## ` heading), or '' when it has none. */
export function usageOf(readme: string): string {
  const lines = readme.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => /^##\s+usage\s*$/i.test(line.trim()))
  if (start < 0) {
    return ''
  }
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

// ── The claude CLI ───────────────────────────────────────────────────────────

/** The `claude` executable: the session's own when CLAUDE_CODE_EXECPATH names a claude binary, else `claude` from PATH. */
export const claudeBinary = (execPath: string | undefined): string =>
  execPath !== undefined && CLAUDE_BINARY.test(execPath.trim()) ? execPath.trim() : 'claude'

export const pluginId = (name: string, marketplace: string): string => `${name}@${marketplace}`

/** The argument vectors of every CLI call the advisor makes; never a shell. */
export const argv = {
  list: (bin: string): string[] => [bin, 'plugin', 'list', '--json'],
  marketplaces: (bin: string): string[] => [bin, 'plugin', 'marketplace', 'list', '--json'],
  addMarketplace: (bin: string, repository: string): string[] => [bin, 'plugin', 'marketplace', 'add', repository, '--json'],
  refreshMarketplace: (bin: string, marketplace: string): string[] => [bin, 'plugin', 'marketplace', 'update', marketplace, '--json'],
  install: (bin: string, name: string, marketplace: string): string[] =>
    [bin, 'plugin', 'install', pluginId(name, marketplace), '--scope', 'user', '--json'],
  uninstall: (bin: string, name: string, marketplace: string, scope: string): string[] =>
    [bin, 'plugin', 'uninstall', pluginId(name, marketplace), '--scope', scope, '--json'],
}

/** What one `claude plugin ... --json` run said. */
export type CliOutcome = { isOk: boolean; message: string; failureCode?: string }

const lastLine = (text: string): string =>
  text.trim().split('\n').map(line => line.replace(/^[×✖✗]\s*/, '').trim()).filter(line => line !== '').pop() ?? ''

/** Reads a `--json` run: its last JSON line with an `outcome`, else its exit code and stderr. */
export function parseOutcome(result: ProcessRunResult): CliOutcome {
  for (const line of result.stdout.trim().split('\n').reverse()) {
    let record: Record<string, unknown> | undefined
    try {
      record = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    if (record === undefined || typeof record.outcome !== 'string') {
      continue
    }
    const failureCode = asText(record.failureCode)
    return {
      isOk: record.outcome === 'ok' && result.exitCode === 0,
      message: asText(record.message) ?? lastLine(result.stderr),
      ...(failureCode === undefined ? {} : { failureCode }),
    }
  }

  return { isOk: result.exitCode === 0, message: lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.exitCode}` }
}

/** The mods of `marketplace` that `claude plugin list --json` reports, by name; throws when it printed no list. */
export function parseInstalled(stdout: string, marketplace: string): Record<string, AdvisorInstall> {
  const list: unknown = JSON.parse(stdout)
  if (!Array.isArray(list)) {
    throw new Error('claude plugin list printed no list')
  }
  const mods: Record<string, AdvisorInstall> = {}
  for (const entry of list) {
    const record = asRecord(entry)
    const id = asText(record?.id) ?? ''
    const at = id.lastIndexOf('@')
    const name = id.slice(0, at)
    if (record === undefined || at <= 0 || id.slice(at + 1) !== marketplace || mods[name] !== undefined) {
      continue
    }
    mods[name] = { version: asText(record.version) ?? '', scope: asText(record.scope) ?? 'user', isEnabled: record.enabled !== false }
  }

  return mods
}

/** One marketplace `claude plugin marketplace list --json` reports. */
export type KnownMarketplace = { name: string; repo?: string; installLocation?: string }

export function parseMarketplaces(stdout: string): KnownMarketplace[] {
  const list: unknown = JSON.parse(stdout)
  return (Array.isArray(list) ? list : []).flatMap(entry => {
    const record = asRecord(entry)
    const name = asText(record?.name)
    const repo = asText(record?.repo)
    const installLocation = asText(record?.installLocation)
    return name === undefined
      ? []
      : [{ name, ...(repo === undefined ? {} : { repo }), ...(installLocation === undefined ? {} : { installLocation }) }]
  })
}

/** The marketplace that serves `repository`: the one added from it, else the default name. */
export function marketplaceOf(known: readonly KnownMarketplace[], repository: string): KnownMarketplace | undefined {
  const lower = repository.toLowerCase()
  return known.find(one => one.repo?.toLowerCase() === lower) ?? known.find(one => one.name === DEFAULT_MARKETPLACE)
}

// ── /mods-advisor ────────────────────────────────────────────────────────────

export type AdvisorCommand =
  | { kind: 'open'; query: string }
  | { kind: 'refresh' }
  | { kind: 'quiet'; value: boolean | undefined }
  | { kind: 'why'; name: string }
  | { kind: 'reset' }
  | { kind: 'usage'; reason: string }

/** Reads what `/mods-advisor` was typed with; words it does not know are a search. */
export function parseArgs(args: string): AdvisorCommand {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const verb = first.toLowerCase()
  const tail = rest.join(' ').trim()
  switch (verb) {
    case '':
      return { kind: 'open', query: '' }
    case 'refresh':
      return { kind: 'refresh' }
    case 'reset':
      return { kind: 'reset' }
    case 'quiet': {
      const value = tail.toLowerCase()
      return value === '' ? { kind: 'quiet', value: undefined }
        : value === 'on' ? { kind: 'quiet', value: true }
        : value === 'off' ? { kind: 'quiet', value: false }
        : { kind: 'usage', reason: '/mods-advisor quiet takes on or off.' }
    }
    case 'why':
      return isModName(tail) ? { kind: 'why', name: tail } : { kind: 'usage', reason: '/mods-advisor why needs the name of one mod.' }
    default:
      return { kind: 'open', query: args.trim() }
  }
}

export const plural = (count: number, word: string, words = `${word}s`): string => `${count} ${count === 1 ? word : words}`

export function formatAge(ms: number): string {
  const age = Math.max(0, ms)
  return age < MINUTE_MS ? 'just now'
    : age < HOUR_MS ? `${Math.floor(age / MINUTE_MS)} min ago`
    : age < DAY_MS ? `${Math.floor(age / HOUR_MS)} h ago`
    : `${Math.floor(age / DAY_MS)} d ago`
}

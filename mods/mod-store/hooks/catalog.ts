import type { SelectOption } from 'claude-code'

import type { StoreCatalog, StoreCategory, StoreInstall, StoreInstalled, StoreMod } from '../types'

export const DEFAULT_REPOSITORY = 'plagemes/claude-mods'
export const DEFAULT_BRANCH = 'main'
export const DEFAULT_MARKETPLACE = 'claude-mods'
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json'
export const CATALOG_PATH = 'catalog.json'

export const FILTER_ALL = 'all'
export const FILTER_INSTALLED = '@installed'
export const FILTER_UPDATES = '@updates'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH = /^[A-Za-z0-9._/-]+$/
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Where the catalog lives: a GitHub repository and the branch read raw. */
export type Source = { repository: string; branch: string }

/** A marketplace file as the store reads it: its name and its valid entries. */
export type Marketplace = { name: string; mods: StoreMod[] }

/** What catalog.json adds: category titles and taglines, and each mod's tier. */
export type CatalogMeta = { categories: StoreCategory[]; tiers: Record<string, string> }

/** Where a mod stands for this person. */
export type ModStatus =
  | { kind: 'available' }
  | { kind: 'installed'; install: StoreInstall }
  | { kind: 'update'; install: StoreInstall }

/** One line of the list: a category heading, or a mod. */
export type Row =
  | { kind: 'heading'; category: StoreCategory; count: number; isContinued: boolean }
  | { kind: 'mod'; mod: StoreMod }

/** What `/mods <args>` asks for. */
export type ModsCommand =
  | { kind: 'open'; query?: string }
  | { kind: 'refresh' }
  | { kind: 'update-all' }
  | { kind: 'install' | 'update' | 'uninstall'; name: string }
  | { kind: 'usage'; reason: string }

export const isModName = (value: string): boolean => NAME.test(value)
export const isRepository = (value: string): boolean => REPOSITORY.test(value)
export const isBranch = (value: string): boolean => BRANCH.test(value) && !value.includes('..')

export const rawUrl = (source: Source, path: string): string =>
  `https://raw.githubusercontent.com/${source.repository}/${source.branch}/${path}`

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asTexts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const titleOf = (id: string): string =>
  id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())

function parseEntry(entry: unknown): StoreMod | undefined {
  const record = asRecord(entry)
  const name = asText(record?.name)
  if (record === undefined || name === undefined || !isModName(name)) {
    return undefined
  }
  const source = asText(record.source)
  const author = asText(record.author) ?? asText(asRecord(record.author)?.name)

  return {
    name,
    description: asText(record.description) ?? '',
    version: asText(record.version) ?? '',
    category: (asText(record.category) ?? 'other').toLowerCase(),
    keywords: asTexts(record.keywords),
    ...(author === undefined ? {} : { author }),
    ...(source?.startsWith('./') ? { path: source.slice(2).replace(/\/+$/, '') } : {}),
  }
}

/** Reads `.claude-plugin/marketplace.json`; throws on anything that is not one. */
export function parseMarketplace(text: string): Marketplace {
  const root = asRecord(JSON.parse(text))
  const name = asText(root?.name)
  if (root === undefined || name === undefined || !isModName(name) || !Array.isArray(root.plugins)) {
    throw new Error('the marketplace file is not valid')
  }
  const seen = new Set<string>()
  const mods: StoreMod[] = []
  for (const entry of root.plugins) {
    const mod = parseEntry(entry)
    if (mod !== undefined && !seen.has(mod.name)) {
      seen.add(mod.name)
      mods.push(mod)
    }
  }

  return { name, mods }
}

/** Reads catalog.json's categories and tiers; throws when it is not JSON. */
export function parseCatalogMeta(text: string): CatalogMeta {
  const root = asRecord(JSON.parse(text))
  const categories: StoreCategory[] = []
  for (const entry of Array.isArray(root?.categories) ? root.categories : []) {
    const record = asRecord(entry)
    const id = asText(record?.id)?.toLowerCase()
    if (id !== undefined && !categories.some(known => known.id === id)) {
      categories.push({ id, title: asText(record?.title) ?? titleOf(id), tagline: asText(record?.tagline) ?? '' })
    }
  }
  const tiers: Record<string, string> = {}
  for (const entry of Array.isArray(root?.mods) ? root.mods : []) {
    const record = asRecord(entry)
    const name = asText(record?.name)
    const tier = asText(record?.tier)
    if (name !== undefined && tier !== undefined) {
      tiers[name] = tier
    }
  }

  return { categories, tiers }
}

/** Merges the marketplace with catalog.json (when it was readable) into the catalog the store shows. */
export function buildCatalog(
  marketplace: Marketplace,
  meta: CatalogMeta | undefined,
  source: Source,
  fetchedAt: number,
): StoreCatalog {
  const mods = marketplace.mods.map(mod => {
    const tier = meta?.tiers[mod.name]
    return tier === undefined ? mod : { ...mod, tier }
  })
  const used = new Set(mods.map(mod => mod.category))
  const categories = (meta?.categories ?? []).filter(category => used.has(category.id))
  for (const id of used) {
    if (!categories.some(category => category.id === id)) {
      categories.push({ id, title: titleOf(id), tagline: '' })
    }
  }

  return { marketplace: marketplace.name, ...source, fetchedAt, categories, mods }
}

/** Whether a value read back from the store is a catalog of this source. */
export function isCatalogOf(value: unknown, source: Source): value is StoreCatalog {
  const record = asRecord(value)
  return (
    record !== undefined &&
    record.repository === source.repository &&
    record.branch === source.branch &&
    typeof record.marketplace === 'string' &&
    typeof record.fetchedAt === 'number' &&
    Array.isArray(record.categories) &&
    Array.isArray(record.mods)
  )
}

/** Compares two versions numerically (`1.10.0` after `1.9.2`); a pre-release sorts before its release. */
export function compareVersions(left: string, right: string): number {
  const split = (version: string): { parts: number[]; isPre: boolean } => {
    const [core = '', ...pre] = version.trim().replace(/^v/i, '').split(/[-+]/)
    return { parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), isPre: pre.length > 0 }
  }
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) {
      return Math.sign(difference)
    }
  }

  return a.isPre === b.isPre ? 0 : a.isPre ? -1 : 1
}

export function statusOf(mod: StoreMod, installed: StoreInstalled | null): ModStatus {
  const install = installed?.isKnown === true ? installed.mods[mod.name] : undefined
  if (install === undefined) {
    return { kind: 'available' }
  }
  const hasUpdate = mod.version !== '' && install.version !== '' && compareVersions(mod.version, install.version) > 0

  return { kind: hasUpdate ? 'update' : 'installed', install }
}

export const updatesOf = (catalog: StoreCatalog, installed: StoreInstalled | null): StoreMod[] =>
  catalog.mods.filter(mod => statusOf(mod, installed).kind === 'update')

export function countsOf(
  catalog: StoreCatalog,
  installed: StoreInstalled | null,
): { mods: number; installed: number; updates: number } {
  const kinds = catalog.mods.map(mod => statusOf(mod, installed).kind)
  return {
    mods: kinds.length,
    installed: kinds.filter(kind => kind !== 'available').length,
    updates: kinds.filter(kind => kind === 'update').length,
  }
}

export const categoryOf = (catalog: StoreCatalog, id: string): StoreCategory =>
  catalog.categories.find(category => category.id === id) ?? { id, title: titleOf(id), tagline: '' }

/** How well a mod matches every word of the query: 0 when one word matches nothing. */
export function scoreOf(mod: StoreMod, words: readonly string[], category: StoreCategory): number {
  const name = mod.name.toLowerCase()
  const keywords = mod.keywords.map(keyword => keyword.toLowerCase())
  const description = mod.description.toLowerCase()
  const categoryText = `${category.id} ${category.title}`.toLowerCase()
  let total = 0
  for (const word of words) {
    const score =
      name === word ? 100
      : name.startsWith(word) ? 60
      : name.includes(word) ? 40
      : keywords.includes(word) ? 30
      : keywords.some(keyword => keyword.includes(word)) ? 20
      : categoryText.includes(word) ? 15
      : description.includes(word) ? 10
      : 0
    if (score === 0) {
      return 0
    }
    total += score
  }

  return total
}

/**
 * The mods the list shows: those the filter keeps and the query matches. With
 * a query, best match first; without, in category order then catalog order.
 */
export function matchMods(
  catalog: StoreCatalog,
  installed: StoreInstalled | null,
  query: string,
  filter: string,
): StoreMod[] {
  const kept = catalog.mods.filter(mod => {
    const kind = statusOf(mod, installed).kind
    return filter === FILTER_INSTALLED ? kind !== 'available'
      : filter === FILTER_UPDATES ? kind === 'update'
      : filter === FILTER_ALL || mod.category === filter
  })
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) {
    const order = catalog.categories.map(category => category.id)
    return kept
      .map((mod, index) => ({ mod, index }))
      .sort((a, b) => order.indexOf(a.mod.category) - order.indexOf(b.mod.category) || a.index - b.index)
      .map(({ mod }) => mod)
  }

  return kept
    .map(mod => ({ mod, score: scoreOf(mod, words, categoryOf(catalog, mod.category)) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.mod.name.localeCompare(b.mod.name))
    .map(({ mod }) => mod)
}

/** The list's lines: grouped under category headings, or flat (a ranked search). */
export function rowsOf(mods: readonly StoreMod[], catalog: StoreCatalog, isGrouped: boolean): Row[] {
  if (!isGrouped) {
    return mods.map(mod => ({ kind: 'mod', mod }))
  }
  const rows: Row[] = []
  let current: string | undefined
  for (const mod of mods) {
    if (mod.category !== current) {
      current = mod.category
      const count = mods.filter(other => other.category === current).length
      rows.push({ kind: 'heading', category: categoryOf(catalog, current), count, isContinued: false })
    }
    rows.push({ kind: 'mod', mod })
  }

  return rows
}

/**
 * Cuts the rows into pages of `size` lines: a page that opens mid-category
 * repeats its heading, and no page ends on a heading.
 */
export function paginate(rows: readonly Row[], size: number): Row[][] {
  const room = Math.max(2, Math.floor(size))
  const pages: Row[][] = []
  let page: Row[] = []
  let heading: Row | undefined
  for (const row of rows) {
    const isFull = page.length >= room || (row.kind === 'heading' && page.length >= room - 1)
    if (isFull && page.length > 0) {
      pages.push(page)
      page = []
    }
    if (row.kind === 'heading') {
      heading = row
    } else if (page.length === 0 && heading?.kind === 'heading') {
      page.push({ ...heading, isContinued: true })
    }
    page.push(row)
  }
  if (page.length > 0) {
    pages.push(page)
  }

  return pages
}

/** The category picker's options, each with its count. */
export function filterOptions(catalog: StoreCatalog, installed: StoreInstalled | null): SelectOption[] {
  const counts = countsOf(catalog, installed)
  return [
    { value: FILTER_ALL, label: `All categories (${counts.mods})` },
    { value: FILTER_INSTALLED, label: `Installed (${counts.installed})` },
    { value: FILTER_UPDATES, label: `Updates (${counts.updates})` },
    ...catalog.categories.map(category => ({
      value: category.id,
      label: `${category.title} (${catalog.mods.filter(mod => mod.category === category.id).length})`,
    })),
  ]
}

const ACTIONS: Readonly<Record<string, 'install' | 'update' | 'uninstall'>> = {
  install: 'install',
  update: 'update',
  uninstall: 'uninstall',
  remove: 'uninstall',
}

/** Reads what `/mods` was typed with; words it does not know are a search. */
export function parseArgs(args: string): ModsCommand {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const verb = first.toLowerCase()
  const tail = rest.join(' ')
  const action = ACTIONS[verb]
  if (action !== undefined) {
    return isModName(tail)
      ? { kind: action, name: tail }
      : { kind: 'usage', reason: `/mods ${verb} needs the name of one mod.` }
  }

  return verb === '' ? { kind: 'open' }
    : verb === 'search' ? { kind: 'open', query: tail }
    : verb === 'refresh' ? { kind: 'refresh' }
    : verb === 'update-all' ? { kind: 'update-all' }
    : { kind: 'open', query: args.trim() }
}

export function formatAge(ms: number): string {
  const age = Math.max(0, ms)
  return age < MINUTE_MS ? 'just now'
    : age < HOUR_MS ? `${Math.floor(age / MINUTE_MS)} min ago`
    : age < DAY_MS ? `${Math.floor(age / HOUR_MS)} h ago`
    : `${Math.floor(age / DAY_MS)} d ago`
}

export const plural = (count: number, word: string, words = `${word}s`): string => `${count} ${count === 1 ? word : words}`

/** The line a person types to install the mod in a terminal session. */
export const installLine = (name: string, repository: string): string =>
  `/plugin install ${name} --marketplace ${repository}`

const folderOf = (mod: StoreMod): string => mod.path ?? `mods/${mod.name}`

export const readmeUrl = (catalog: StoreCatalog, mod: StoreMod): string =>
  `https://github.com/${catalog.repository}/blob/${catalog.branch}/${folderOf(mod)}/README.md`

export const readmeRawUrl = (catalog: StoreCatalog, mod: StoreMod): string =>
  rawUrl(catalog, `${folderOf(mod)}/README.md`)

/** A README without its title and tagline, which the detail view already shows. */
export function trimReadme(text: string, mod: StoreMod): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const isTitle = (line: string | undefined): boolean => line?.trim().toLowerCase() === `# ${mod.name}`.toLowerCase()
  const dropBlank = (): void => {
    while (lines.length > 0 && lines[0]?.trim() === '') {
      lines.shift()
    }
  }
  dropBlank()
  if (isTitle(lines[0])) {
    lines.shift()
    dropBlank()
  }
  while (lines[0]?.startsWith('>') === true) {
    lines.shift()
  }

  return lines.join('\n').trim()
}

export type Style = 'timestamp' | 'laravel' | 'epoch' | 'date' | 'flyway' | 'sequence' | 'hash'
export type Casing = 'snake' | 'kebab' | 'pascal'
export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

/** What the migrations next to each other have in common. */
export type Convention = {
  style: Style
  separator: string
  casing: Casing
  /** Digits of the number, for the sequence style (0001 is 4). */
  width: number
  /** The highest number used so far, for the sequence and Flyway styles. */
  last: number
  /** True when each migration is a folder holding migration.sql (Prisma). */
  isNested: boolean
  /** A real sibling entry, to show what the convention looks like. */
  example: string | undefined
}

export type Problem = 'generic' | 'unnumbered'

const GENERIC_WORDS = new Set([
  'migration', 'migrations', 'migrate', 'new', 'temp', 'tmp', 'update', 'updates', 'change', 'changes', 'test', 'tests', 'untitled',
  'fix', 'fixes', 'wip', 'draft', 'foo', 'bar', 'baz', 'x', 'y', 'misc', 'stuff', 'file', 'script', 'sql', 'db', 'database', 'schema',
  'auto', 'generated', 'copy', 'final', 'up', 'down',
])
const STOP_WORDS = new Set(['a', 'an', 'the'])
const IGNORED_ENTRY = /^(\..*|__init__\.py|__pycache__|env\.py|script\.py\.mako|schema\.rb|index\.[jt]s|migration_lock\.toml|readme.*|.*\.(md|lock|toml|txt|mako))$/i

const PREFIXES: ReadonlyArray<{ style: Style; pattern: RegExp }> = [
  { style: 'laravel', pattern: /^(\d{4}_\d{2}_\d{2}_\d{6})([_-])(.*)$/s },
  { style: 'timestamp', pattern: /^(\d{14})([_-])(.*)$/s },
  { style: 'epoch', pattern: /^(\d{13}|\d{10})([_-])(.*)$/s },
  { style: 'date', pattern: /^(\d{8})([_-])(.*)$/s },
  { style: 'flyway', pattern: /^(V\d+(?:[._]\d+)*)(__)(.*)$/s },
  { style: 'sequence', pattern: /^(\d{1,6})([_-])(.*)$/s },
  { style: 'hash', pattern: /^([0-9a-f]{12})([_-])(.*)$/s },
]
const LONG_NUMBER = /^\d{4,}/
const MAX_SLUG_WORDS = 6
const MAX_SLUG_CHARS = 48

/** A file name without its extension (`.sql`, `.up.sql`); a folder keeps its whole name. */
export const splitEntry = (name: string, isDirectory: boolean): { stem: string; ext: string } => {
  if (isDirectory) return { stem: name, ext: '' }
  const match = /^(.+?)((?:\.(?:up|down))?\.[A-Za-z0-9]+)$/.exec(name)
  return match?.[1] === undefined ? { stem: name, ext: '' } : { stem: match[1], ext: match[2] ?? '' }
}

export const parsePrefix = (stem: string): { style: Style; prefix: string; separator: string; rest: string } | undefined => {
  // "0001.sql" has a number and no description: a sentinel separator lets the same patterns read it.
  for (const candidate of [stem, `${stem}_`]) {
    for (const { style, pattern } of PREFIXES) {
      const match = pattern.exec(candidate)
      if (match?.[1] !== undefined) return { style, prefix: match[1], separator: match[2] ?? '_', rest: candidate === stem ? (match[3] ?? '') : '' }
    }
  }
  return undefined
}

export const wordsOf = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '')

const isGenericDescription = (rest: string): boolean => {
  const words = wordsOf(rest).filter(word => !/^\d+$/.test(word))
  return words.length === 0 || words.every(word => GENERIC_WORDS.has(word))
}

/** What is wrong with a migration's name: empty of meaning, or nothing that orders it. */
export const judgeName = (stem: string): Problem[] => {
  const parsed = parsePrefix(stem)
  if (parsed !== undefined) return isGenericDescription(parsed.rest) ? ['generic'] : []
  if (LONG_NUMBER.test(stem)) return []
  return isGenericDescription(stem) ? ['generic', 'unnumbered'] : ['unnumbered']
}

const casingOf = (rest: string): Casing => {
  if (rest.includes('_')) return 'snake'
  if (rest.includes('-')) return 'kebab'
  return /^[A-Z][a-z0-9]+[A-Z]/.test(rest) ? 'pascal' : 'snake'
}

const numberOf = (prefix: string): number => Number.parseInt(prefix.replace(/^V/, '').split(/[._]/)[0] ?? '0', 10) || 0

/** The convention the existing entries follow, or undefined when none of them is numbered. */
export const detectConvention = (entries: readonly Entry[]): Convention | undefined => {
  const numbered = entries
    .filter(entry => !IGNORED_ENTRY.test(entry.name))
    .flatMap(entry => {
      const parsed = parsePrefix(splitEntry(entry.name, entry.kind === 'dir').stem)
      return parsed === undefined ? [] : [{ entry, parsed }]
    })
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
  const newest = numbered.at(-1)
  if (newest === undefined) return undefined

  const counts = new Map<Style, number>()
  for (const { parsed } of numbered) counts.set(parsed.style, (counts.get(parsed.style) ?? 0) + 1)
  // The most used style wins; on a tie the style of the newest migration does.
  const style = [...counts].reduce((best, current) => (current[1] > best[1] || (current[1] === best[1] && current[0] === newest.parsed.style) ? current : best))[0]
  const same = numbered.filter(item => item.parsed.style === style)
  const described = same.filter(item => item.parsed.rest !== '')

  return {
    style,
    separator: newest.parsed.style === style ? newest.parsed.separator : (same.at(-1)?.parsed.separator ?? '_'),
    casing: casingOf(described.at(-1)?.parsed.rest ?? ''),
    width: Math.max(...same.map(item => item.parsed.prefix.length)),
    last: Math.max(...same.map(item => numberOf(item.parsed.prefix))),
    isNested: same.filter(item => item.entry.kind === 'dir').length > same.length / 2,
    example: same.at(-1)?.entry.name,
  }
}

export const defaultConvention = (style: 'timestamp' | 'sequence'): Convention => ({
  style,
  separator: '_',
  casing: 'snake',
  width: 4,
  last: 0,
  isNested: false,
  example: undefined,
})

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** YYYYMMDDHHMMSS in UTC, or Laravel's YYYY_MM_DD_HHMMSS. */
export const formatTimestamp = (ms: number, style: 'timestamp' | 'laravel' | 'date'): string => {
  const date = new Date(ms)
  const day = [pad(date.getUTCFullYear(), 4), pad(date.getUTCMonth() + 1, 2), pad(date.getUTCDate(), 2)]
  const time = [pad(date.getUTCHours(), 2), pad(date.getUTCMinutes(), 2), pad(date.getUTCSeconds(), 2)]
  if (style === 'laravel') return `${day.join('_')}_${time.join('')}`
  return style === 'date' ? day.join('') : day.join('') + time.join('')
}

export const limitWords = (words: readonly string[]): string[] => {
  const kept: string[] = []
  for (const word of words.filter(word => !STOP_WORDS.has(word))) {
    if (kept.length >= MAX_SLUG_WORDS || [...kept, word].join('_').length > MAX_SLUG_CHARS) break
    kept.push(word)
  }
  return kept
}

const withCasing = (words: readonly string[], casing: Casing): string => {
  if (casing === 'kebab') return words.join('-')
  return casing === 'pascal' ? words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('') : words.join('_')
}

/** The new entry's name without extension: prefix, separator and description. */
export const buildStem = (convention: Convention, words: readonly string[], now: number): string => {
  const description = withCasing(words, convention.casing)
  switch (convention.style) {
    case 'sequence':
      return `${pad(convention.last + 1, convention.width)}${convention.separator}${description}`
    case 'flyway':
      return `V${convention.last + 1}__${words.join('_')}`
    case 'epoch':
      return `${now}${convention.separator}${description}`
    case 'laravel':
      return `${formatTimestamp(now, 'laravel')}_${words.join('_')}`
    case 'date':
      return `${formatTimestamp(now, 'date')}${convention.separator}${description}`
    default:
      // A hash prefix (Alembic) cannot be copied by hand, so a timestamp orders the new one.
      return `${formatTimestamp(now, 'timestamp')}${convention.separator === '-' ? '-' : '_'}${description}`
  }
}

const SHAPES: Record<Style, string> = {
  timestamp: 'YYYYMMDDHHMMSS_description',
  laravel: 'YYYY_MM_DD_HHMMSS_description',
  epoch: 'epoch-milliseconds_description',
  date: 'YYYYMMDD_description',
  flyway: 'V<number>__description',
  sequence: '<number>_description',
  hash: 'YYYYMMDDHHMMSS_description',
}
export const describeShape = (convention: Convention): string => {
  const casing = convention.casing === 'pascal' ? 'PascalCase' : convention.casing === 'kebab' ? 'kebab-case' : 'snake_case'
  return SHAPES[convention.style].replace('description', casing)
}

/** The extension most numbered files use, for a suggestion that has none of its own. */
export const dominantExtension = (entries: readonly Entry[]): string | undefined => {
  const counts = new Map<string, number>()
  for (const entry of entries.filter(entry => entry.kind === 'file' && !IGNORED_ENTRY.test(entry.name))) {
    const { stem, ext } = splitEntry(entry.name, false)
    if (ext !== '' && parsePrefix(stem) !== undefined) counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

// ── Where the migrations are ────────────────────────────────────────────────

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "db/migrate" matches /repo/db/migrate/x.rb and /repo/api/db/migrate/x.rb, but not /repo/mydb/migrate/x.rb. */
export const directoryPatterns = (list: string): RegExp[] =>
  list
    .split(',')
    .map(directory => directory.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
    .filter(directory => directory !== '')
    .map(directory => new RegExp(`(?:^|/)${escapeRegExp(directory)}/`))

const MIGRATION_FILE = /\.(sql|py|rb|js|ts|mjs|cjs|php|java|kt|go|cs|exs|xml|ya?ml)$/i
const NESTED_FILE = /^(migration|up|down)\.[A-Za-z0-9]+$/i

export type Placement = {
  /** The migration directory with its trailing slash, as spelled in the path. */
  directory: string
  /** The migration's own entry: a file, or the folder that holds migration.sql. */
  entry: string
  /** The file name inside the entry's folder, for the nested (Prisma) layout. */
  innerFile: string | undefined
}

/** Where a path sits in a migrations directory; undefined for anything that is not a migration file. */
export const placeMigration = (path: string, patterns: readonly RegExp[]): Placement | undefined => {
  const normalized = path.replace(/\\/g, '/')
  for (const pattern of patterns) {
    const match = pattern.exec(normalized)
    if (match === null) continue
    const directory = normalized.slice(0, match.index + match[0].length)
    const rest = normalized.slice(directory.length).split('/').filter(part => part !== '')
    const first = rest[0]
    const last = rest.at(-1)
    if (first === undefined || last === undefined || !MIGRATION_FILE.test(last) || IGNORED_ENTRY.test(last)) return undefined
    if (rest.length === 1) return { directory, entry: first, innerFile: undefined }
    return rest.length === 2 && NESTED_FILE.test(last) ? { directory, entry: first, innerFile: last } : undefined
  }
  return undefined
}

// ── What the migration does ─────────────────────────────────────────────────

const IDENT = String.raw`[\`"\[]?([A-Za-z_][\w]*)[\`"\]]?`
const TABLE = String.raw`(?:[\`"\[]?\w+[\`"\]]?\.)?${IDENT}`
const CONTENT_RULES: ReadonlyArray<{ pattern: RegExp; words: (match: RegExpExecArray) => string }> = [
  { pattern: new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${TABLE}`, 'i'), words: m => `create ${m[1]} table` },
  {
    pattern: new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${TABLE}\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(?!constraint\b|primary\b|foreign\b|unique\b|check\b|index\b|key\b)${IDENT}`, 'i'),
    words: m => `add ${m[2]} to ${m[1]}`,
  },
  { pattern: new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${TABLE}\s+drop\s+(?:column\s+)?(?:if\s+exists\s+)?${IDENT}`, 'i'), words: m => `drop ${m[2]} from ${m[1]}` },
  { pattern: new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${TABLE}`, 'i'), words: m => `alter ${m[1]} table` },
  { pattern: new RegExp(String.raw`create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?${IDENT}\s+on\s+(?:only\s+)?${TABLE}`, 'i'), words: m => `add ${m[1]} index` },
  { pattern: new RegExp(String.raw`drop\s+table\s+(?:if\s+exists\s+)?${TABLE}`, 'i'), words: m => `drop ${m[1]} table` },
  { pattern: new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(view|function|type|trigger)\s+${TABLE}`, 'i'), words: m => `create ${m[2]} ${m[1]}` },
  { pattern: /create_table\s*\(?\s*:(\w+)/, words: m => `create ${m[1]}` },
  { pattern: /add_column\s*\(?\s*:(\w+),\s*:(\w+)/, words: m => `add ${m[2]} to ${m[1]}` },
  { pattern: /remove_column\s*\(?\s*:(\w+),\s*:(\w+)/, words: m => `remove ${m[2]} from ${m[1]}` },
  { pattern: /add_index\s*\(?\s*:(\w+),\s*:?\[?:?(\w+)/, words: m => `add index to ${m[1]} ${m[2]}` },
  { pattern: /drop_table\s*\(?\s*:(\w+)/, words: m => `drop ${m[1]} table` },
  { pattern: /op\.create_table\(\s*['"](\w+)/, words: m => `create ${m[1]} table` },
  { pattern: /op\.add_column\(\s*['"](\w+)['"],\s*sa\.Column\(\s*['"](\w+)/, words: m => `add ${m[2]} to ${m[1]}` },
  { pattern: /op\.drop_column\(\s*['"](\w+)['"],\s*['"](\w+)/, words: m => `drop ${m[2]} from ${m[1]}` },
  { pattern: /migrations\.CreateModel\(\s*name=['"](\w+)/, words: m => `create ${m[1]} model` },
  { pattern: /migrations\.AddField\(\s*model_name=['"](\w+)['"],\s*name=['"](\w+)/, words: m => `add ${m[2]} to ${m[1]}` },
  { pattern: /createTable\(\s*['"](\w+)/, words: m => `create ${m[1]} table` },
  { pattern: /alterTable\(\s*['"](\w+)/, words: m => `alter ${m[1]} table` },
  { pattern: /dropTable(?:IfExists)?\(\s*['"](\w+)/, words: m => `drop ${m[1]} table` },
]

/** A few words saying what the migration's content does, or undefined when nothing is recognisable. */
export const describeContent = (content: string): string[] | undefined => {
  for (const rule of CONTENT_RULES) {
    const match = rule.pattern.exec(content)
    if (match !== null) return limitWords(wordsOf(rule.words(match)))
  }
  return undefined
}

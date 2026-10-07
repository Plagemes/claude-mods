/** How a Drizzle config locates the schema and the migrations. */
export type DrizzleConfig = { schema: string[]; out: string }

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const PRISMA_BLOCK = /^\s*(model|enum|view|type)\s+(\w+)\s*\{/gm
const DRIZZLE_TABLE = /export\s+const\s+(\w+)\s*=\s*(?:\w+\.)?(\w*(?:Table|Enum|View|Schema))\s*\(/g

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** The text with comments and blank space folded away, so a reformat is no change. */
export const normalize = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** The text of each brace block that opens at `pattern`'s matches, by name. */
const blocks = (text: string, pattern: RegExp, nameAt: (match: RegExpMatchArray) => string): Map<string, string> => {
  const found = new Map<string, string>()
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length - 1
    let depth = 0
    let end = start
    for (; end < text.length; end += 1) {
      if (text[end] === '{' || text[end] === '(') depth += 1
      else if ((text[end] === '}' || text[end] === ')') && --depth === 0) break
    }
    found.set(nameAt(match), normalize(text.slice(match.index ?? 0, end + 1)))
  }
  return found
}

const prismaBlocks = (text: string) => blocks(text, PRISMA_BLOCK, match => `${match[2]}${match[1] === 'model' ? '' : ` (${match[1]})`}`)
const drizzleBlocks = (text: string) => blocks(text, DRIZZLE_TABLE, match => match[1] ?? '')

/**
 * What changed between two versions of a schema: `Order (changed)`,
 * `Invoice (new)`, `Legacy (removed)`; `schema (changed)` when only text
 * outside the models changed; empty when only comments or spacing did.
 */
export const schemaChanges = (kind: 'prisma' | 'drizzle', before: string, after: string): string[] => {
  if (normalize(before) === normalize(after)) return []
  const read = kind === 'prisma' ? prismaBlocks : drizzleBlocks
  const old = read(before)
  const now = read(after)
  const changes: string[] = []
  for (const [name, text] of now) {
    if (!old.has(name)) changes.push(`${name} (new)`)
    else if (old.get(name) !== text) changes.push(`${name} (changed)`)
  }
  for (const name of old.keys()) if (!now.has(name)) changes.push(`${name} (removed)`)
  return changes.length > 0 ? changes : ['schema (changed)']
}

/** The `schema` and `out` a drizzle.config sets (strings or a list of strings); `./drizzle` when `out` is not set. */
export const parseDrizzleConfig = (text: string): DrizzleConfig | undefined => {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const list = /\bschema\s*:\s*\[([^\]]*)\]/.exec(code)
  const single = /\bschema\s*:\s*(['"`])([^'"`]+)\1/.exec(code)
  const schema = list !== null ? [...(list[1] ?? '').matchAll(/(['"`])([^'"`]+)\1/g)].map(match => match[2] ?? '') : single !== null ? [single[2] ?? ''] : []
  if (schema.length === 0) return undefined
  const out = /\bout\s*:\s*(['"`])([^'"`]+)\1/.exec(code)?.[2] ?? './drizzle'
  return { schema, out }
}

/** Whether `file` is one a Drizzle schema entry names: the file, a file under the folder, or a glob's match. */
export const matchesSchema = (entry: string, file: string): boolean => {
  if (!/[*?{]/.test(entry)) return file === entry || file.startsWith(`${entry.replace(/\/$/, '')}/`)
  const source = entry
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{([^}]+)\}/g, (_, options: string) => `(?:${options.split(',').join('|')})`)
    .replace(/\u0000/g, '(?:.*/)?')
  return new RegExp(`^${source}$`).test(file)
}

/** `./src/db/schema.ts` against `/app` → `/app/src/db/schema.ts`. */
export const resolveFrom = (dir: string, path: string): string =>
  path.startsWith('/') ? path : `${dir.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`.replace(/\/\.\//g, '/')

/** The few lines that say why `prisma generate` failed: the first `error:` with its location, else the first error line. */
export const generateError = (output: string): string => {
  const lines = stripAnsi(output).split('\n')
  const first = lines.findIndex(line => /^error:/i.test(line.trim()) && !/^Error:\s*Prisma schema validation/i.test(line.trim()))
  if (first >= 0) {
    const location = lines.slice(first + 1, first + 3).find(line => line.trim().startsWith('-->'))
    return [lines[first]?.trim(), location?.trim()].filter(Boolean).join(' ')
  }
  return (lines.find(line => /error/i.test(line))?.trim() ?? lines.find(line => line.trim() !== '')?.trim() ?? 'unknown error').slice(0, 400)
}

/** What a Bash command did to the database's schema: made migrations, pushed without them, or neither. */
export const migrationCommand = (command: string): 'migrate' | 'push' | undefined => {
  if (/\bprisma\s+db\s+push\b|\bdrizzle-kit\s+push\b/.test(command)) return 'push'
  if (/\bprisma\s+migrate\s+(?:dev|reset|deploy|resolve)\b|\bdrizzle-kit\s+(?:generate|migrate|drop)\b/.test(command)) return 'migrate'
  return undefined
}

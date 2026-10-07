import type { FixtureFactoryKind as Kind } from '../types'

/** Where a definition was found by grep: file, 1-based line, and what kind of definition. */
export type Hit = { path: string; line: number; kind: Kind; text: string }

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const FILE_GLOBS = ['*.prisma', '*.ts', '*.tsx', '*.py', '*.sql', '*.go', '*.rs']
export const SKIPPED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', 'vendor', 'target', 'coverage']

/** `User` also finds `users`, `users` also finds `user`: tables are often plural, models singular. */
export const nameVariants = (name: string): string[] => {
  const variants = new Set([name])
  if (/ies$/i.test(name)) variants.add(name.replace(/ies$/i, 'y'))
  else if (/s$/i.test(name)) variants.add(name.replace(/s$/i, ''))
  else variants.add(/y$/i.test(name) ? name.replace(/y$/i, 'ies') : `${name}s`)
  return [...variants]
}

/** Extended POSIX regexes (run case-insensitively; no word-boundary escapes, which BSD grep lacks), one per kind of definition. */
export const grepPatterns = (name: string): string[] => {
  const names = `(${nameVariants(name).join('|')})`
  const s = '[[:space:]]'
  const end = '([^A-Za-z0-9_]|$)'
  return [
    `^${s}*model${s}+${names}${s}*[{]`,
    `^${s}*(export${s}+)?(declare${s}+)?interface${s}+${names}${end}`,
    `^${s}*(export${s}+)?(declare${s}+)?type${s}+${names}${s}*(<[^=]*>)?${s}*=`,
    `^${s}*(export${s}+)?const${s}+${names}(Schema)?${s}*=${s}*z[.]object`,
    `^${s}*class${s}+${names}${s}*[(:]`,
    `create${s}+table${s}+(if${s}+not${s}+exists${s}+)?([[\`"]?[a-z_][a-z0-9_]*[]\`"]?[.])?[[\`"]?${names}[]\`"]?(${s}|[(]|$)`,
    `^${s}*type${s}+${names}${s}+struct${end}`,
    `^${s}*(pub${s}+)?struct${s}+${names}${end}`,
  ]
}

const kindOf = (path: string, text: string): Kind | undefined => {
  if (path.endsWith('.prisma')) return 'prisma'
  if (path.endsWith('.sql')) return 'sql'
  if (path.endsWith('.py')) return 'python'
  if (path.endsWith('.go')) return 'go'
  if (path.endsWith('.rs')) return 'rust'
  if (/\.tsx?$/.test(path)) return /z\.object/.test(text) ? 'zod' : 'typescript'
  return undefined
}

const RANK: Record<Kind, number> = { prisma: 0, sql: 1, zod: 2, typescript: 3, python: 4, go: 5, rust: 6 }

/** Reads `path:line:text` grep lines, best first: exact-case names, schema files, then source files outside tests. */
export const parseHits = (output: string, name: string): Hit[] => {
  const hits: Hit[] = []
  for (const line of output.split('\n')) {
    const match = /^(.+?):(\d+):(.*)$/.exec(line)
    if (match === null) continue
    const [, rawPath = '', number = '0', text = ''] = match
    const path = rawPath.replace(/^\.\//, '')
    const kind = kindOf(path, text)
    if (kind === undefined || SKIPPED_DIRS.some(dir => path.split('/').includes(dir))) continue
    hits.push({ path, line: Number(number), kind, text: text.trim() })
  }
  const exact = new RegExp(`\\b${name}\\b`)
  const score = (hit: Hit) =>
    (exact.test(hit.text) ? 0 : 100) + RANK[hit.kind] * 10 + (/(^|\/)(tests?|__tests__|spec)\//.test(hit.path) || /\.(test|spec)\./.test(hit.path) ? 5 : 0)
  return hits.sort((a, b) => score(a) - score(b))
}

const MAX_BLOCK_LINES = 150

/** Counts `{`/`}` (or `(`/`)` in SQL) outside strings and comments on one line. */
const depthChange = (line: string, kind: Kind): number => {
  const [open, close] = kind === 'sql' ? ['(', ')'] : ['{', '}']
  const code = line.replace(kind === 'sql' ? /--.*$/ : /\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')
  let depth = 0
  for (const char of code) {
    if (char === open) depth += 1
    else if (char === close) depth -= 1
  }
  return depth
}

/** The definition that starts at 0-based `start`: its braces, parentheses or Python indentation. */
export const extractBlock = (lines: readonly string[], start: number, kind: Kind): string => {
  const end = Math.min(lines.length, start + MAX_BLOCK_LINES)
  if (kind === 'python') {
    let first = start
    while (first > 0 && /^\s*@/.test(lines[first - 1] ?? '')) first -= 1
    const indent = (lines[start] ?? '').search(/\S/)
    let last = start
    for (let index = start + 1; index < end; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '') continue
      if (line.search(/\S/) <= indent) break
      last = index
    }
    return lines.slice(first, last + 1).join('\n')
  }
  const open = kind === 'sql' ? '(' : '{'
  let depth = 0
  let isOpened = false
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? ''
    depth += depthChange(line, kind)
    isOpened ||= line.includes(open)
    if (kind === 'typescript') {
      // An interface ends with its brace; an alias (`type Money =` then `| {…}` lines) with its last union member.
      const continues = /[=|&<,(]\s*$/.test(line) || /^\s*[|&.]/.test(lines[index + 1] ?? '')
      if (depth <= 0 && (/;\s*$/.test(line) || !continues)) return lines.slice(start, index + 1).join('\n')
    } else if (isOpened && depth <= 0) {
      return lines.slice(start, index + 1).join('\n')
    }
  }
  return lines.slice(start, end).join('\n')
}

const KEYWORDS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Date', 'Array', 'Record', 'Partial', 'Promise', 'Optional', 'List', 'Dict', 'Any', 'Union', 'Literal', 'Field', 'Column', 'None', 'True', 'False', 'Map', 'Set', 'Readonly'])

/** Capitalised type names the block refers to (enums, related models), its own name excluded. */
export const relatedNames = (block: string, name: string): string[] => {
  const names = new Set<string>()
  for (const match of block.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    const found = match[1] ?? ''
    if (found !== name && !KEYWORDS.has(found) && !/^[A-Z0-9_]+$/.test(found)) names.add(found)
  }
  return [...names].slice(0, 12)
}

/** Definitions of `names` in the same file (enums, other models, aliases): context the records must agree with. */
export const relatedBlocks = (lines: readonly string[], names: readonly string[], kind: Kind, skipStart: number): string[] => {
  const blocks: string[] = []
  for (const name of names) {
    const start = lines.findIndex(
      (line, index) =>
        index !== skipStart &&
        new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:enum|model|type|interface|class|const)\\s+${name}\\b`).test(line),
    )
    if (start === -1) continue
    const isEnumLike = /\benum\b/.test(lines[start] ?? '')
    const block = extractBlock(lines, start, kind === 'prisma' || isEnumLike ? 'prisma' : kind)
    // Enums are worth their whole body; related models only their head, so the prompt stays small.
    blocks.push(isEnumLike ? block : block.split('\n').slice(0, 25).join('\n'))
    if (blocks.length >= 6) break
  }
  return blocks
}

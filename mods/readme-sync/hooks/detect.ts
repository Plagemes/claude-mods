// Pure detection of documented surface (exports, CLI flags, env vars) in code text. No `$` here.

import type { ReadmeSyncChange, ReadmeSyncChangeKind, ReadmeSyncKind } from '../types'

export type SurfaceKind = ReadmeSyncKind
export type ChangeKind = ReadmeSyncChangeKind
export type SurfaceChange = ReadmeSyncChange

/** Name → signature: the declaration line for exports, the name itself otherwise. */
export type Surface = Map<string, string>

const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|py|go|rs|rb|java|kt|swift|php|cs|ex|exs|sh)$/i
const JS_FILE = /\.(m?[jt]sx?|c[jt]s)$/i
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i
const DOC_DIR = /(^|\/)(docs?|documentation|man)\//i
const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]*\.py$/i

const JS_EXPORT =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/
const JS_EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/
const JS_EXPORT_STAR = /^\s*export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/
const PY_PUBLIC = /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/
const GO_PUBLIC = /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Z]\w*)/
const RS_PUBLIC = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/
const FLAG_LINE = /(option|argument|flag|arg|opt)s?\s*\(|#\[arg\(|\bcommand\(/i
const FLAG = /(?<![\w-])--[a-zA-Z][\w-]*/g
const LONG_NAME = /\blong\s*(?:=\s*|\(\s*)"([\w-]+)"/g
const GO_FLAG = /\bflag\.\w+\(\s*(?:&?[\w.]+\s*,\s*)?"([\w-]+)"/g
const ENV_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Za-z_]\w*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Za-z_]\w*)['"]/g,
  /os\.environ\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Za-z_]\w*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_]\w*)['"]/g,
  /os\.Getenv\(\s*"([A-Za-z_]\w*)"/g,
  /env::var(?:_os)?\(\s*"([A-Za-z_]\w*)"/g,
  /ENV\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g,
  /System\.getenv\(\s*"([A-Za-z_]\w*)"/g,
  /\bgetenv\(\s*['"]([A-Za-z_]\w*)['"]/g,
]

export const isCodePath = (path: string): boolean => CODE_FILE.test(path) && !TEST_PATH.test(path)
export const isDocPath = (path: string): boolean => DOC_FILE.test(path) || DOC_DIR.test(path)

const signature = (line: string): string => line.trim().replace(/\s*[{=].*$/, '').replace(/\s+/g, ' ')

const exportsOf = (path: string, text: string, into: Surface): void => {
  const lines = text.split('\n')
  for (const line of lines) {
    if (JS_FILE.test(path)) {
      const declared = JS_EXPORT.exec(line)
      if (declared?.[2] !== undefined) into.set(`export:${declared[2]}`, signature(line))
      else if (/^\s*export\s+default\b/.test(line)) into.set('export:default', signature(line))
      const listed = JS_EXPORT_LIST.exec(line)?.[1]
      for (const part of listed?.split(',') ?? []) {
        const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim()
        if (name !== undefined && name !== '') into.set(`export:${name}`, name)
      }
      const star = JS_EXPORT_STAR.exec(line)
      if (star !== null) into.set(`export:${star[1] ?? `* from ${star[2]}`}`, signature(line))
      continue
    }
    const match = (/\.py$/i.test(path) ? PY_PUBLIC : /\.go$/i.test(path) ? GO_PUBLIC : /\.rs$/i.test(path) ? RS_PUBLIC : undefined)?.exec(line)
    if (match?.[1] !== undefined) into.set(`export:${match[1]}`, signature(line))
  }
}

/** The names a code text exposes, keyed `kind:name`. */
export const surfaceOf = (path: string, text: string, watchExports: boolean): Surface => {
  const surface: Surface = new Map()
  if (!isCodePath(path)) return surface
  if (watchExports) exportsOf(path, text, surface)
  for (const line of text.split('\n')) {
    for (const goFlag of line.matchAll(GO_FLAG)) surface.set(`flag:--${goFlag[1]}`, `--${goFlag[1]}`)
    if (!FLAG_LINE.test(line)) continue
    for (const flag of line.match(FLAG) ?? []) surface.set(`flag:${flag}`, flag)
    for (const long of line.matchAll(LONG_NAME)) surface.set(`flag:--${long[1]}`, `--${long[1]}`)
  }
  for (const pattern of ENV_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) surface.set(`env:${match[1]}`, match[1])
    }
  }
  return surface
}

/** What changed between two versions of a file's text (an Edit's strings, or a file before and after a Write). */
export const diffSurface = (file: string, before: Surface, after: Surface): SurfaceChange[] => {
  const changes: SurfaceChange[] = []
  const split = (key: string): { kind: SurfaceKind; name: string } => {
    const at = key.indexOf(':')
    return { kind: key.slice(0, at) as SurfaceKind, name: key.slice(at + 1) }
  }
  for (const [key, sig] of after) {
    const old = before.get(key)
    if (old === undefined) changes.push({ ...split(key), change: 'added', file })
    else if (old !== sig) changes.push({ ...split(key), change: 'changed', file })
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changes.push({ ...split(key), change: 'removed', file })
  }
  return changes
}

const KIND_WORDS: Record<SurfaceKind, [string, string]> = {
  export: ['export', 'exports'],
  flag: ['CLI flag', 'CLI flags'],
  env: ['env var', 'env vars'],
}

/** "2 exports, 1 env var" */
export const summarize = (changes: readonly SurfaceChange[]): string =>
  (['export', 'flag', 'env'] as const)
    .map(kind => {
      const n = changes.filter(change => change.kind === kind).length
      return n === 0 ? '' : `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`
    })
    .filter(Boolean)
    .join(', ')

const MARK: Record<ChangeKind, string> = { added: '+', removed: '−', changed: '~' }

/** "+ export parseConfig (src/config.ts)" */
export const describeChange = (change: SurfaceChange): string =>
  `${MARK[change.change]} ${KIND_WORDS[change.kind][0]} ${change.name} (${change.file})`

/** Keeps the latest change per kind, name and file; an add then a remove cancel out. */
export const mergeChanges = (earlier: readonly SurfaceChange[], later: readonly SurfaceChange[]): SurfaceChange[] => {
  const merged = new Map<string, SurfaceChange>()
  for (const change of [...earlier, ...later]) {
    const key = `${change.kind}:${change.name}:${change.file}`
    const previous = merged.get(key)
    if (previous?.change === 'added' && change.change === 'removed') merged.delete(key)
    else if (previous?.change === 'added') merged.set(key, previous)
    else merged.set(key, change)
  }
  return [...merged.values()]
}

export type Finding = {
  kind: 'needs-client' | 'error-boundary' | 'server-import' | 'metadata' | 'needless-client'
  /** Line, counting from 1; 0 for the file as a whole. */
  line: number
  message: string
}

const SERVER_MODULES = new Set([
  'server-only', 'fs', 'fs/promises', 'node:fs', 'node:fs/promises', 'child_process', 'node:child_process', 'os', 'node:os', 'net', 'dns',
  'next/headers', 'next/cache', 'dotenv', 'pg', 'mysql2', 'mysql2/promise', 'mongoose', 'mongodb', '@prisma/client', 'prisma', 'better-sqlite3',
  'knex', 'typeorm', 'sequelize', 'redis', 'ioredis', '@vercel/postgres', '@neondatabase/serverless', 'postgres', '@libsql/client',
  '@planetscale/database', 'nodemailer', 'stripe', '@clerk/nextjs/server',
])
const SERVER_MODULE_PREFIXES = ['drizzle-orm', '@prisma/client/', 'node:']
/** `./db`, `@/lib/prisma`, `../server/users`, `./users.server`: local modules that read as server code. */
const LOCAL_SERVER_PATH = /(?:^|\/)(?:server|db|database|prisma|drizzle)(?:\/|$)|\.server$/
const LOCAL_SPECIFIER = /^(?:\.{1,2}\/|@\/|~\/|#)/
/** Specifiers that cannot tell whether a file needs the client: React, Next.js and local modules. */
const NEUTRAL_SPECIFIER = /^(?:\.{1,2}\/|@\/|~\/|#|react(?:\/|$)|react-dom(?:\/|$)|next(?:\/|$))/

/** Hooks that are fine in a Server Component, so calling them is no sign of a Client Component. */
const SERVER_SAFE_HOOK = /^(?:useMemo|useCallback|useId|useDebugValue|useTranslations|useLocale|useFormatter|useMessages|useNow|useTimeZone)$/
const HOOK_CALL = /\b(use[A-Z]\w*)\s*\(/g
const EVENT_HANDLER = /\b(on[A-Z][A-Za-z]*)\s*=\s*\{/g
const BROWSER_GLOBAL = /\b(window|document|localStorage|sessionStorage|navigator)\s*[.[]/g
const BROWSER_API = /\b(matchMedia|requestAnimationFrame|IntersectionObserver|ResizeObserver|MutationObserver|addEventListener)\b/g
const OTHER_CLIENT_ONLY: readonly (readonly [string, RegExp])[] = [
  ['createContext', /\bcreateContext\s*\(/],
  ['a class component', /\bclass\s+\w+\s+extends\s+(?:React\.)?(?:Pure)?Component\b/],
  ['ssr: false', /\bssr\s*:\s*false\b/],
]
const IMPORT = /^[ \t]*import\s+(?!type\s)(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/gm
const JSX = /<\/[A-Za-z]|\/>|<>/
const ROUTE_FILE = /(?:^|[\\/])(?:route|middleware)\.[jt]s$|\.d\.ts$/
const ERROR_BOUNDARY = /(?:^|[\\/])(?:global-)?error\.[jt]sx?$/
const METADATA_EXPORT = /\bexport\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/
const MAX_LABELS = 3

const TOKENS = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g
const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

/** The source without comments (strings kept: imports need them). */
const withoutComments = (source: string): string => source.replace(TOKENS, token => (token.startsWith('//') || token.startsWith('/*') ? blank(token) : token))

/** The source without comments and with the inside of strings blanked: what is left is code. */
const codeOnly = (source: string): string =>
  source.replace(TOKENS, token => (token.startsWith('//') || token.startsWith('/*') ? blank(token) : `${token[0]}${blank(token.slice(1, -1))}${token.slice(-1)}`))

/** A finder of 1-based line numbers in `text`: the newline offsets are found once, then each lookup is a binary search. */
const lineFinder = (text: string): ((index: number) => number) => {
  const newlines: number[] = []
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) newlines.push(at)
  return index => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((newlines[middle] ?? Infinity) < index) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

const hasDirective = (text: string, directive: string): boolean => new RegExp(`^\\s*(['"])${directive}\\1`).test(text)

/** The client-only features a file uses, named (hooks, handlers, browser APIs ...); comments and strings do not count. */
export function clientFeatures(source: string): string[] {
  const code = codeOnly(source)
  const found: string[] = []
  for (const match of code.matchAll(HOOK_CALL)) if (!SERVER_SAFE_HOOK.test(match[1] as string)) found.push(match[1] as string)
  for (const match of code.matchAll(EVENT_HANDLER)) found.push(match[1] as string)
  for (const match of code.matchAll(BROWSER_GLOBAL)) found.push(match[1] as string)
  for (const match of code.matchAll(BROWSER_API)) found.push(match[1] as string)
  for (const [label, pattern] of OTHER_CLIENT_ONLY) if (pattern.test(code)) found.push(label)
  return [...new Set(found)]
}

const isServerOnly = (specifier: string): boolean =>
  SERVER_MODULES.has(specifier) || SERVER_MODULE_PREFIXES.some(prefix => specifier.startsWith(prefix)) || (LOCAL_SPECIFIER.test(specifier) && LOCAL_SERVER_PATH.test(specifier))

const labelList = (labels: readonly string[]): string => labels.slice(0, MAX_LABELS).join(', ') + (labels.length > MAX_LABELS ? ', ...' : '')

/** What is off about a file of the App Router with respect to 'use client', read from its text. */
export function checkComponent(source: string, path: string, options: { hintUnneeded: boolean }): Finding[] {
  if (ROUTE_FILE.test(path)) return []
  const text = withoutComments(source)
  if (hasDirective(text, 'use server')) return []

  const isClient = hasDirective(text, 'use client')
  const code = codeOnly(source)
  const features = clientFeatures(source)
  const lineOf = lineFinder(text)
  const imports = [...text.matchAll(IMPORT)].map(match => ({ specifier: match[1] as string, line: lineOf(match.index ?? 0) }))
  const findings: Finding[] = []

  if (!isClient) {
    const isComponent = /\.[jt]sx$/.test(path) && JSX.test(code)
    if (ERROR_BOUNDARY.test(path)) {
      findings.push({ kind: 'error-boundary', line: 0, message: "error boundaries (error.tsx, global-error.tsx) must be Client Components; add 'use client' as the first line" })
    } else if (isComponent && features.length > 0) {
      findings.push({
        kind: 'needs-client',
        line: 0,
        message: `uses ${labelList(features)} but has no 'use client'; in the App Router this file is a Server Component, so it fails. Add 'use client' as the first line, or move the interactive part into a client component`,
      })
    }
    return findings
  }

  for (const { specifier, line } of imports) {
    if (isServerOnly(specifier)) {
      findings.push({
        kind: 'server-import',
        line,
        message: `a 'use client' file imports ${specifier}, which only works on the server; keep that code in a Server Component, server action or route handler and pass the data down as props`,
      })
    }
  }
  if (METADATA_EXPORT.test(code)) {
    findings.push({ kind: 'metadata', line: 0, message: "a 'use client' file cannot export metadata or generateMetadata; move it to a Server Component (layout.tsx or page.tsx)" })
  }
  const hasForeignImports = imports.some(({ specifier }) => !NEUTRAL_SPECIFIER.test(specifier))
  if (options.hintUnneeded && features.length === 0 && !hasForeignImports && !ERROR_BOUNDARY.test(path)) {
    findings.push({
      kind: 'needless-client',
      line: 0,
      message: "marked 'use client' but no hooks, event handlers or browser APIs were found; if nothing here needs the browser, remove the directive so it stays a Server Component and ships less JavaScript",
    })
  }
  return findings
}

/**
 * Every folder that holds an `app/` or `src/app/` the path is in, deepest first: `/app/app/page.tsx` (a
 * Docker WORKDIR named app) may be the project `/app` or the root. Empty when the path is in no App Router folder.
 */
export function nextProjectDirs(path: string): string[] {
  const dirs: string[] = []
  for (const match of path.matchAll(/[\\/](?:src[\\/])?app(?=[\\/])/g)) dirs.unshift(path.slice(0, match.index))
  return [...new Set(dirs)]
}

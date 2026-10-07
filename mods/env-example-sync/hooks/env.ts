const NAME = '([A-Z][A-Z0-9_]+)'
const QUOTED = `\\s*['"]${NAME}['"]\\s*`

/** Ways code reads an environment variable; group 1 is the variable's name. */
const READS: readonly RegExp[] = [
  new RegExp(`\\bprocess\\.env\\.${NAME}\\b`, 'g'),
  new RegExp(`\\bprocess\\.env\\[${QUOTED}\\]`, 'g'),
  new RegExp(`\\bimport\\.meta\\.env\\.${NAME}\\b`, 'g'),
  new RegExp(`\\bimport\\.meta\\.env\\[${QUOTED}\\]`, 'g'),
  new RegExp(`\\bBun\\.env\\.${NAME}\\b`, 'g'),
  new RegExp(`\\bDeno\\.env\\.get\\(${QUOTED}\\)`, 'g'),
  new RegExp(`\\benviron\\[${QUOTED}\\]`, 'g'),
  new RegExp(`\\benviron\\.get\\(${QUOTED}[,)]`, 'g'),
  new RegExp(`\\bgetenv\\(${QUOTED}[,)]`, 'g'),
  new RegExp(`\\bENV\\[${QUOTED}\\]`, 'g'),
  new RegExp(`\\bENV\\.fetch\\(${QUOTED}[,)]`, 'g'),
  new RegExp(`(?<![\\w.])env\\(${QUOTED}[,)]`, 'g'),
  new RegExp(`\\$_ENV\\[${QUOTED}\\]`, 'g'),
  new RegExp(`\\bos\\.(?:Getenv|LookupEnv)\\(${QUOTED}\\)`, 'g'),
  new RegExp(`\\benv::var(?:_os)?\\(${QUOTED}\\)`, 'g'),
  new RegExp(`\\bSystem\\.getenv\\(${QUOTED}\\)`, 'g'),
  new RegExp(`\\bEnvironment\\.GetEnvironmentVariable\\(${QUOTED}[,)]`, 'g'),
]

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--)/

/** Variables every machine has, or that frameworks set: never worth a line in .env.example. */
export const BUILT_IN_IGNORED: readonly string[] = [
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'USERNAME', 'PWD', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'CI', 'HOSTNAME',
  'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL',
]

/** Names of the environment variables the code reads, in order of first appearance. Comment lines are skipped. */
export function envReads(source: string): string[] {
  const code = source
    .split('\n')
    .filter(line => !COMMENT_LINE.test(line))
    .join('\n')
  const found: { name: string; index: number }[] = []
  for (const pattern of READS) {
    for (const match of code.matchAll(pattern)) found.push({ name: match[1] as string, index: match.index ?? 0 })
  }
  return [...new Set(found.sort((a, b) => a.index - b.index).map(read => read.name))]
}

/** Variables that `after` reads and `before` did not. */
export function addedReads(before: string, after: string, ignored: ReadonlySet<string>): string[] {
  const known = new Set(envReads(before))
  return envReads(after).filter(name => !known.has(name) && !ignored.has(name))
}

/** Names an example file already lists, commented-out ones (`# NAME=`) included. */
export function listedNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(/^[ \t]*(?:#[ \t]*)?(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) names.add(match[1] as string)
  return names
}

export const MARKER = '# added by env-example-sync'

/** The example file's text with `NAME=` lines for `names` added at the end, under a marker comment. */
export function withNames(text: string, names: readonly string[]): string {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${base}${base === '' ? '' : '\n'}${MARKER}\n${names.map(name => `${name}=`).join('\n')}\n`
}

/** A file name that holds real values (`.env`, `.env.local`, `.env.production`) and so is never touched. */
export const isRealEnvFile = (name: string): boolean => /^\.env(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w-]+)*$/i.test(name)

/** Names the user may configure: they must read as an example, so a real `.env` cannot be named by mistake. */
export const isExampleName = (name: string): boolean => /example|sample|template|dist|default/i.test(name) && !isRealEnvFile(name)

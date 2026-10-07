/** The package managers whose installs are audited, by the auditor that checks them. */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'

/** One install a shell command ran: which manager, in which folder (relative to where the command started, '' for there). */
export type Install = { manager: Manager; dir: string }

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env'])
const NPM_VERBS = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'update', 'up', 'upgrade'])
const PNPM_VERBS = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade'])
const YARN_VERBS = new Set(['install', 'add', 'up', 'upgrade'])
const PIP = /^pip(?:3(?:\.\d+)?)?$/
const PYTHON = /^python(?:3(?:\.\d+)?)?$/
const HELP = new Set(['-h', '--help', '--version', '-V', '--dry-run'])

/** The words of a simple command, past env assignments and wrappers such as `sudo`. */
const wordsOf = (part: string): string[] => {
  const words = part.trim().split(/\s+/).filter(word => word !== '')
  let start = 0
  while (start < words.length && (ASSIGNMENT.test(words[start] as string) || PREFIXES.has(words[start] as string))) start += 1
  return words.slice(start)
}

const verbOf = (args: readonly string[]): string | undefined => args.find(arg => !arg.startsWith('-'))

/** The manager a simple command installs packages with, if it does. */
export const installOf = (words: readonly string[]): Manager | undefined => {
  const program = (words[0] ?? '').replace(/^.*\//, '')
  const args = words.slice(1)
  if (args.some(arg => HELP.has(arg))) return undefined
  const verb = verbOf(args)
  if (program === 'npm' && verb !== undefined && NPM_VERBS.has(verb)) return 'npm'
  if (program === 'pnpm' && verb !== undefined && PNPM_VERBS.has(verb)) return 'pnpm'
  if (program === 'yarn' && (verb === undefined || YARN_VERBS.has(verb))) return 'yarn'
  if (PIP.test(program) && verb === 'install') return 'pip'
  if (PYTHON.test(program) && args[0] === '-m' && PIP.test(args[1] ?? '') && verbOf(args.slice(2)) === 'install') return 'pip'
  if (program === 'uv' && (verb === 'add' || verb === 'sync' || (verb === 'pip' && verbOf(args.slice(args.indexOf('pip') + 1)) === 'install'))) {
    return 'pip'
  }
  if (program === 'poetry' && (verb === 'add' || verb === 'install' || verb === 'update')) return 'pip'
  if (program === 'cargo' && (verb === 'add' || verb === 'update')) return 'cargo'
  return undefined
}

/** `a/b` joined to `dir` the way `cd` would, `..` popping a segment. */
const changeDir = (dir: string, to: string): string => {
  if (to.startsWith('/') || to.startsWith('~')) return to
  const parts = dir === '' ? [] : dir.split('/')
  for (const segment of to.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * The installs a shell command runs, in order, following `cd` between
 * them (`cd web && npm install` installs in `web`). Quoted text is never
 * read as a command; each manager is listed once per folder.
 */
export const installsIn = (command: string): Install[] => {
  const found: Install[] = []
  let dir = ''
  const bare = command.replace(QUOTED, match => match.replace(/[;&|\n]/g, ' '))
  for (const part of bare.split(/\|\||&&|[;|&\n()]/)) {
    const words = wordsOf(part)
    if (words[0] === 'cd' || words[0] === 'pushd') {
      dir = changeDir(dir, (words[1] ?? '').replace(/^["']|["']$/g, ''))
      continue
    }
    const manager = installOf(words)
    if (manager !== undefined && !found.some(one => one.manager === manager && one.dir === dir)) found.push({ manager, dir })
  }
  return found
}

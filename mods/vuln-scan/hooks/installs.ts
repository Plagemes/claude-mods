import { simpleCommands } from './shared/shell'

/** The package managers whose installs are audited, by the auditor that checks them. */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'

/** One install a shell command ran: which manager, in which folder (relative to where the command started, '' for there). */
export type Install = { manager: Manager; dir: string }

const NPM_VERBS = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'update', 'up', 'upgrade'])
const PNPM_VERBS = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade'])
const YARN_VERBS = new Set(['install', 'add', 'up', 'upgrade'])
const PIP = /^pip(?:3(?:\.\d+)?)?$/
const PYTHON = /^python(?:3(?:\.\d+)?)?$/
const HELP = new Set(['-h', '--help', '--version', '-V', '--dry-run'])

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
 * The installs a shell command runs, in order, following `cd` between them (`cd web && npm install` installs in
 * `web`). Commands come from the shared shell reader, so quoted text is never read as a command, wrappers
 * (`sudo`, `env`, `timeout`…) are peeled and `bash -c "…"` scripts are opened (a `cd` inside one does not leak out
 * of it); each manager is listed once per folder.
 */
export const installsIn = (command: string): Install[] => {
  const found: Install[] = []
  const add = (install: Install): void => {
    if (!found.some(one => one.manager === install.manager && one.dir === install.dir)) found.push(install)
  }
  // The folder each script (the line itself is script 0, each nested one a new number) is in: a nested script starts where its parent was.
  const dirs = new Map<number, string>([[0, '']])
  let last = ''
  for (const { argv, script } of simpleCommands(command)) {
    if (!dirs.has(script)) dirs.set(script, last)
    const dir = dirs.get(script) ?? ''
    if (argv[0] === 'cd' || argv[0] === 'pushd') {
      dirs.set(script, changeDir(dir, argv[1] ?? ''))
    } else {
      const manager = installOf(argv)
      if (manager !== undefined) add({ manager, dir })
    }
    last = dirs.get(script) ?? ''
  }
  return found
}

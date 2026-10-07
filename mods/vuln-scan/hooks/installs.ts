/** The package managers whose installs are audited, by the auditor that checks them. */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'

/** One install a shell command ran: which manager, in which folder (relative to where the command started, '' for there). */
export type Install = { manager: Manager; dir: string }

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  command: new Set(),
  exec: new Set(['-a']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set(),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `-c`, or `-c` grouped with other short options: `bash -lc`, `sh -ec`. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** The quoted script after a shell's `-c` flag. */
const SHELL_SCRIPT = /\s-[a-zA-Z]*c[a-zA-Z]*\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/
const SEPARATOR = /\|\||&&|[;|&\n()]/g
const MAX_NESTING = 3
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
  for (;;) {
    while (start < words.length && ASSIGNMENT.test(words[start] as string)) start += 1
    const wrapper = words[start] ?? ''
    const valued = Object.hasOwn(WRAPPERS, wrapper) ? WRAPPERS[wrapper] : undefined
    if (valued === undefined) return words.slice(start)
    start += 1
    // `sudo -u me npm ci`, `timeout 120 npm ci`: the wrapper's options (and their values) are not the command.
    while (start < words.length && (words[start] as string).startsWith('-')) start += valued.has(words[start] as string) ? 2 : 1
    if (wrapper === 'timeout') start += 1
  }
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
export const installsIn = (command: string, depth = 0): Install[] => {
  const found: Install[] = []
  const add = (install: Install): void => {
    if (!found.some(one => one.manager === install.manager && one.dir === install.dir)) found.push(install)
  }
  let dir = ''
  // Separators inside quotes become spaces, so `bare` lines up with `command` character for character.
  const bare = command.replace(QUOTED, match => match.replace(/[;&|\n]/g, ' '))
  const bounds = [...bare.matchAll(SEPARATOR)].map(match => [match.index, match.index + match[0].length] as const)
  const parts = [0, ...bounds.map(([, end]) => end)].map((start, index) => ({ start, end: bounds[index]?.[0] ?? bare.length }))
  for (const { start, end } of parts) {
    const words = wordsOf(bare.slice(start, end))
    if (words[0] === 'cd' || words[0] === 'pushd') {
      dir = changeDir(dir, (words[1] ?? '').replace(/^["']|["']$/g, ''))
      continue
    }
    const program = (words[0] ?? '').replace(/^.*\//, '')
    if (SHELLS.has(program) && words.some(word => SHELL_COMMAND_FLAG.test(word)) && depth < MAX_NESTING) {
      // `bash -lc "cd web && npm ci"`: the installs of the script, from the folder the shell starts in.
      const quoted = SHELL_SCRIPT.exec(command.slice(start, end))
      const script = quoted?.[1] ?? quoted?.[2]?.replace(/\\(["\\$`])/g, '$1')
      for (const install of script === undefined ? [] : installsIn(script, depth + 1)) add({ ...install, dir: changeDir(dir, install.dir) })
      continue
    }
    const manager = installOf(words)
    if (manager !== undefined) add({ manager, dir })
  }
  return found
}

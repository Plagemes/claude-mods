import type { Ecosystem } from './popular'

/** One package an install command asks for, by its registry name. */
export type PackageRequest = { ecosystem: Ecosystem; name: string; spec: string }

/** A cheap test before parsing: does the command mention an installer at all? */
export const INSTALLER_HINT = /\b(?:npm|pnpm|yarn|bun|npx|bunx|pip3?|pipx|uv|poetry|cargo|go)\b/

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup'])

/** Splits a command line into simple commands, each a list of words; quotes are honoured, expansions kept as text. */
export const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  const endWord = (): void => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string
    if (char === '\\' && i + 1 < command.length) {
      word += command[i + 1]
      hasWord = true
      i += 1
    } else if (char === "'" || char === '"') {
      const end = command.indexOf(char, i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      hasWord = true
      i = stop
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '(' || char === ')') {
      endCommand()
    } else {
      word += char
      hasWord = true
    }
  }
  endCommand()
  return commands
}

/** Drops options (and the values of the ones listed in `valued`), keeping operands. */
const operandsOf = (args: readonly string[], valued: ReadonlySet<string>): string[] => {
  const result: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      result.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-')) {
      if (valued.has(arg)) i += 1
      continue
    }
    result.push(arg)
  }
  return result
}

const NPM_INSTALL = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall'])
const NPM_VALUED = new Set(['--registry', '--tag', '--prefix', '-w', '--workspace', '--omit', '--include', '--filter', '-F', '-C', '--dir', '--cwd'])
const PIP_VALUED = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f',
  '--find-links', '-t', '--target', '--prefix', '--root', '--platform', '--python-version', '--implementation', '--abi',
  '--src', '--upgrade-strategy', '--python', '-p', '--group', '-G', '--extra', '--source', '--only-binary', '--no-binary',
])
const CARGO_VALUED = new Set([
  '--features', '-F', '--rename', '--registry', '--package', '-p', '--manifest-path', '--target', '--branch', '--tag',
  '--rev', '--version', '--vers', '--root', '--bin', '--index', '--example', '--profile', '-j', '--jobs',
])
const GO_VALUED = new Set(['-modfile', '-tags', '-ldflags', '-gcflags', '-o'])

/** `@scope/name@1.2` -> `@scope/name`; undefined for paths, URLs, git and tarball specs. */
export const npmName = (spec: string): string | undefined => {
  const aliased = /^[^@/]+@npm:(.+)$/.exec(spec)?.[1]
  const target = aliased ?? spec
  if (/^[./~]|:|\.t(?:ar\.)?gz$/.test(target)) return undefined
  if (!target.startsWith('@') && target.includes('/')) return undefined // GitHub shorthand `user/repo`
  const at = target.indexOf('@', 1)
  const name = (at === -1 ? target : target.slice(0, at)).toLowerCase()
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) ? name : undefined
}

/** `Requests[security]>=2` -> `requests` (PEP 503 normalized); undefined for paths, URLs and archives. */
export const pypiName = (spec: string): string | undefined => {
  if (/^[./~]|:\/\/|^git\+|\.(?:whl|zip|tar\.gz)$/.test(spec)) return undefined
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec)?.[0]
  return name === undefined ? undefined : name.toLowerCase().replace(/[-_.]+/g, '-')
}

const crateName = (spec: string): string | undefined => {
  const name = spec.split('@')[0] as string
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? name : undefined
}

/** `github.com/x/y@v1` -> `github.com/x/y`; undefined for local, `all` and standard-library paths. */
const goModule = (spec: string): string | undefined => {
  const module = spec.split('@')[0] as string
  const host = module.split('/')[0] as string
  return host.includes('.') && !module.startsWith('.') ? module : undefined
}

const requestsOf = (
  ecosystem: Ecosystem,
  specs: readonly string[],
  nameOf: (spec: string) => string | undefined,
): PackageRequest[] =>
  specs.flatMap(spec => {
    const name = nameOf(spec)
    return name === undefined ? [] : [{ ecosystem, name, spec }]
  })

/** The packages one simple command installs or runs from a registry. */
const installsOf = (argv: readonly string[]): PackageRequest[] => {
  let start = 0
  while (start < argv.length && (PREFIXES.has(argv[start] as string) || ASSIGNMENT.test(argv[start] as string))) start += 1
  const [tool = '', sub = '', third = '', ...rest] = argv.slice(start)
  const afterSub = argv.slice(start + 2)
  const name = tool.replace(/^.*\//, '')

  if (name === 'npm' || name === 'pnpm' || name === 'bun') {
    if (NPM_INSTALL.has(sub) || (name === 'bun' && sub === 'a')) return requestsOf('npm', operandsOf(afterSub, NPM_VALUED), npmName)
    if (name === 'pnpm' && sub === 'dlx') return requestsOf('npm', operandsOf(afterSub, NPM_VALUED).slice(0, 1), npmName)
    if (name === 'npm' && (sub === 'exec' || sub === 'x')) return requestsOf('npm', operandsOf(afterSub, NPM_VALUED).slice(0, 1), npmName)
    return []
  }
  if (name === 'yarn') {
    if (sub === 'add') return requestsOf('npm', operandsOf(afterSub, NPM_VALUED), npmName)
    if (sub === 'global' && third === 'add') return requestsOf('npm', operandsOf(rest, NPM_VALUED), npmName)
    if (sub === 'dlx') return requestsOf('npm', operandsOf(afterSub, NPM_VALUED).slice(0, 1), npmName)
    return []
  }
  if (name === 'npx' || name === 'bunx') {
    const args = argv.slice(start + 1)
    const packages = args.flatMap((arg, index) =>
      arg === '-p' || arg === '--package' ? [args[index + 1] ?? ''] : arg.startsWith('--package=') ? [arg.slice(10)] : [],
    )
    const runs = operandsOf(args, new Set(['-p', '--package', '-c', '--call'])).slice(0, 1)
    return requestsOf('npm', packages.length > 0 ? packages : runs, npmName)
  }
  if (/^pip(?:3(?:\.\d+)?)?$/.test(name) || name === 'pipx') {
    return sub === 'install' ? requestsOf('pypi', operandsOf(afterSub, PIP_VALUED), pypiName) : []
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(name) && sub === '-m' && /^pip3?$/.test(third) && rest[0] === 'install') {
    return requestsOf('pypi', operandsOf(rest.slice(1), PIP_VALUED), pypiName)
  }
  if (name === 'uv') {
    if (sub === 'add') return requestsOf('pypi', operandsOf(afterSub, PIP_VALUED), pypiName)
    if (sub === 'pip' && third === 'install') return requestsOf('pypi', operandsOf(rest, PIP_VALUED), pypiName)
    return []
  }
  if (name === 'poetry' && sub === 'add') return requestsOf('pypi', operandsOf(afterSub, PIP_VALUED), pypiName)
  if (name === 'cargo' && (sub === 'add' || sub === 'install')) {
    // A git or path source is not a registry download.
    if (afterSub.some(arg => arg === '--git' || arg === '--path' || arg.startsWith('--git=') || arg.startsWith('--path='))) return []
    return requestsOf('crates', operandsOf(afterSub, CARGO_VALUED), crateName)
  }
  if (name === 'go' && (sub === 'get' || sub === 'install')) return requestsOf('go', operandsOf(afterSub, GO_VALUED), goModule)
  return []
}

/** Every registry package `command` would install, each once. */
export const packageRequests = (command: string): PackageRequest[] => {
  if (!INSTALLER_HINT.test(command)) return []
  const seen = new Set<string>()
  return simpleCommands(command)
    .flatMap(installsOf)
    .filter(request => {
      const key = `${request.ecosystem}:${request.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

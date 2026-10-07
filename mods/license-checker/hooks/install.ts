export type Ecosystem = 'npm' | 'pypi'

/** One package an install command adds to the project. */
export type InstallRequest = { ecosystem: Ecosystem; name: string; version?: string; isDev: boolean }

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
const MAX_NESTING = 3
/** A cheap test before parsing: does the command mention an installer at all? */
const INSTALLER_HINT = /\b(?:npm|pnpm|yarn|bun|pip3?|python3?|uv|poetry)\b/

/** Splits a command line into simple commands, each a list of words; quotes are honoured, expansions kept as text. */
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let isOpen = false
  const endWord = (): void => {
    if (isOpen) words.push(word)
    word = ''
    isOpen = false
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
      isOpen = true
      i += 1
    } else if (char === "'" || char === '"') {
      const end = command.indexOf(char, i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      isOpen = true
      i = stop
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '(' || char === ')') {
      endCommand()
    } else {
      word += char
      isOpen = true
    }
  }
  endCommand()
  return commands
}

type Parsed = { operands: string[]; isDev: boolean; isGlobal: boolean }

/** Splits arguments into operands and the two flags that matter, skipping the values of the options in `valued`. */
const parseArguments = (args: readonly string[], valued: ReadonlySet<string>, devFlags: ReadonlySet<string>): Parsed => {
  const parsed: Parsed = { operands: [], isDev: false, isGlobal: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      parsed.operands.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('-')) {
      parsed.operands.push(arg)
    } else if (arg === '-g' || arg === '--global') {
      parsed.isGlobal = true
    } else if (devFlags.has(arg)) {
      parsed.isDev = true
    } else if (arg === '--group' || arg === '-G') {
      // `--group dev` is a dev dependency; `--group main` is not.
      parsed.isDev = parsed.isDev || (args[i + 1] ?? '') !== 'main'
      i += 1
    } else if (valued.has(arg)) {
      i += 1
    }
  }
  return parsed
}

const NPM_VALUED = new Set(['--registry', '--tag', '--prefix', '-w', '--workspace', '--filter', '-F', '-C', '--dir', '--cwd', '--omit', '--include'])
const NPM_DEV = new Set(['-D', '--save-dev', '--dev'])
const PIP_VALUED = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links',
  '-t', '--target', '--prefix', '--root', '--platform', '--python-version', '--implementation', '--abi', '--src', '--upgrade-strategy',
  '--python', '-p', '--extra', '--optional', '--source', '--only-binary', '--no-binary',
])
const PY_DEV = new Set(['--dev', '-D', '-d'])
const NPM_INSTALL = new Set(['install', 'i', 'add'])
const NPM_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i
const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `left-pad@1.3.0`, `@scope/pkg`, `pkg@latest`; undefined for paths, URLs, git and tarball specs. */
const npmRequest = (spec: string, isDev: boolean): InstallRequest | undefined => {
  const alias = /^[^@/]+@npm:(.+)$/.exec(spec)?.[1]
  const target = alias ?? spec
  if (/^[./~]|:|\.t(?:ar\.)?gz$/.test(target)) return undefined
  if (!target.startsWith('@') && target.includes('/')) return undefined
  const at = target.indexOf('@', 1)
  const name = at === -1 ? target : target.slice(0, at)
  const version = at === -1 ? undefined : target.slice(at + 1)
  return NPM_NAME.test(name) ? { ecosystem: 'npm', name: name.toLowerCase(), version: version === '' ? undefined : version, isDev } : undefined
}

/** `requests==2.31.0`, `Django>=4`, `pkg[extra]`; undefined for paths, URLs and archives. */
const pypiRequest = (spec: string, isDev: boolean): InstallRequest | undefined => {
  if (/^[./~]|:\/\/|^git\+|\.(?:whl|zip|tar\.gz)$/.test(spec)) return undefined
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec)?.[0]
  if (name === undefined || !PIP_NAME.test(name)) return undefined
  const exact = /==\s*([A-Za-z0-9][A-Za-z0-9._+!-]*)(?=$|[\s,;])/.exec(spec.slice(name.length))?.[1]
  return { ecosystem: 'pypi', name: name.toLowerCase().replace(/[-_.]+/g, '-'), version: exact, isDev }
}

const installsOf = (argv: readonly string[], depth: number): InstallRequest[] => {
  let start = 0
  for (;;) {
    while (start < argv.length && ASSIGNMENT.test(argv[start] as string)) start += 1
    const wrapper = argv[start] ?? ''
    const valued = Object.hasOwn(WRAPPERS, wrapper) ? WRAPPERS[wrapper] : undefined
    if (valued === undefined) break
    start += 1
    // `sudo -H -u me pip install ...`, `timeout 120 npm i x`: the wrapper's options (and their values) are not the command.
    while ((argv[start] ?? '').startsWith('-')) start += valued.has(argv[start] as string) ? 2 : 1
    if (wrapper === 'timeout') start += 1
  }
  const [tool = '', sub = '', third = '', ...rest] = argv.slice(start)
  const name = tool.replace(/^.*\//, '')
  const afterSub = argv.slice(start + 2)

  if (SHELLS.has(name) || name === 'eval') {
    // `bash -lc "npm i left-pad"`, `eval "pip install x"`: the script's own installs.
    const flag = argv.findIndex((word, index) => index > start && SHELL_COMMAND_FLAG.test(word))
    const script = name === 'eval' ? argv.slice(start + 1).join(' ') : flag === -1 ? undefined : argv[flag + 1]
    return script === undefined || depth >= MAX_NESTING ? [] : requestsIn(script, depth + 1)
  }

  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    const isAdd = name === 'yarn' ? sub === 'add' : NPM_INSTALL.has(sub) || (name === 'bun' && sub === 'a')
    if (!isAdd) return []
    const parsed = parseArguments(afterSub, NPM_VALUED, name === 'bun' ? new Set([...NPM_DEV, '-d']) : NPM_DEV)
    if (parsed.isGlobal) return []
    return parsed.operands.flatMap(spec => npmRequest(spec, parsed.isDev) ?? [])
  }
  const isPip = /^pip3?(?:\.\d+)?$/.test(name) && sub === 'install'
  const isPythonPip = /^python3?(?:\.\d+)?$/.test(name) && sub === '-m' && /^pip3?$/.test(third) && rest[0] === 'install'
  const isUvPip = name === 'uv' && sub === 'pip' && third === 'install'
  if (isPip || isPythonPip || isUvPip) {
    const args = isPip ? afterSub : isPythonPip ? rest.slice(1) : rest
    const parsed = parseArguments(args, PIP_VALUED, PY_DEV)
    return parsed.operands.flatMap(spec => pypiRequest(spec, false) ?? [])
  }
  if ((name === 'uv' || name === 'poetry') && sub === 'add') {
    const parsed = parseArguments(afterSub, PIP_VALUED, PY_DEV)
    return parsed.operands.flatMap(spec => pypiRequest(spec, parsed.isDev) ?? [])
  }
  return []
}

const requestsIn = (command: string, depth: number): InstallRequest[] => simpleCommands(command).flatMap(argv => installsOf(argv, depth))

/** Every registry package `command` installs into a project (not globally), each once. */
export const installsIn = (command: string): InstallRequest[] => {
  if (!INSTALLER_HINT.test(command)) return []
  const seen = new Set<string>()
  return requestsIn(command, 0)
    .filter(request => {
      const key = `${request.ecosystem}:${request.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/
const DIST_TAG = /^[a-z][\w.-]*$/i

/** The registry document to ask for, and the part of it that names the version, for the cache key. */
export const lookupOf = (request: InstallRequest): { url: string; key: string } => {
  if (request.ecosystem === 'npm') {
    const version = request.version ?? ''
    const pick = EXACT_VERSION.test(version) ? version.replace(/^v/, '') : DIST_TAG.test(version) ? version : 'latest'
    return { url: `https://registry.npmjs.org/${request.name.replace('/', '%2f')}/${pick}`, key: `npm:${request.name}@${pick}` }
  }
  const exact = request.version
  const path = exact === undefined ? `${request.name}/json` : `${request.name}/${exact}/json`
  return { url: `https://pypi.org/pypi/${path}`, key: `pypi:${request.name}@${exact ?? 'latest'}` }
}

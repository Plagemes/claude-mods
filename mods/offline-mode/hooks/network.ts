const MAX_NESTING = 3

/** Programs that always talk to the network (curl and friends are judged by their targets, see LOOPBACK_OK). */
const NETWORK_PROGRAMS = new Set([
  'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'netcat', 'mosh', 'ping', 'ping6', 'traceroute', 'dig', 'nslookup', 'whois',
  'gh', 'glab', 'aws', 'gcloud', 'gsutil', 'bq', 'az', 'kubectl', 'helm', 'terraform', 'pulumi', 'vercel', 'netlify', 'firebase',
  'wrangler', 'heroku', 'flyctl', 'fly', 'supabase', 'doctl', 'railway',
  'bunx', 'pnpx', 'uvx',
])
const FETCHERS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs'])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'exec', 'timeout', 'stdbuf', 'xargs'])
const WRAPPER_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-n', '-I', '-L', '-P'])
const OFFLINE_FLAGS = new Set(['--offline', '--no-index', '--local'])
const INFO_FLAGS = new Set(['--version', '-V', '--help', '-h'])

/** Subcommands that go to the network, by program. A multi-word entry is a subcommand with its own subcommand. */
const SUBCOMMANDS: Record<string, readonly string[]> = {
  npm: ['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'outdated', 'view', 'info', 'show', 'search', 'publish', 'audit', 'login', 'logout', 'whoami', 'access', 'dist-tag', 'deprecate', 'unpublish', 'owner', 'team', 'token', 'fund', 'create', 'init'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'outdated', 'dlx', 'fetch', 'publish', 'audit', 'view', 'info', 'search', 'login', 'logout', 'create'],
  yarn: ['install', 'add', 'upgrade', 'up', 'upgrade-interactive', 'dlx', 'audit', 'npm', 'publish', 'info', 'create', 'global add'],
  bun: ['install', 'i', 'add', 'update', 'upgrade', 'x', 'create', 'publish'],
  pip: ['install', 'download', 'wheel'],
  pip3: ['install', 'download', 'wheel'],
  uv: ['sync', 'add', 'lock', 'remove', 'pip install', 'pip download', 'tool install', 'tool run', 'python install'],
  poetry: ['install', 'add', 'update', 'lock', 'publish', 'search', 'self'],
  pipenv: ['install', 'update', 'sync', 'lock'],
  pipx: ['install', 'run', 'upgrade', 'upgrade-all', 'install-all'],
  cargo: ['install', 'fetch', 'update', 'add', 'search', 'publish', 'login'],
  go: ['get', 'install', 'mod download', 'mod tidy'],
  gem: ['install', 'update', 'fetch', 'push', 'search'],
  bundle: ['install', 'update', 'outdated', 'add', 'lock'],
  composer: ['install', 'update', 'require', 'create-project', 'outdated'],
  brew: ['install', 'update', 'upgrade', 'tap', 'fetch', 'reinstall', 'search'],
  apt: ['install', 'update', 'upgrade', 'dist-upgrade', 'full-upgrade', 'download', 'source'],
  'apt-get': ['install', 'update', 'upgrade', 'dist-upgrade', 'full-upgrade', 'download', 'source'],
  dnf: ['install', 'update', 'upgrade', 'makecache', 'check-update', 'reinstall'],
  yum: ['install', 'update', 'upgrade', 'makecache', 'check-update', 'reinstall'],
  apk: ['add', 'update', 'upgrade'],
  conda: ['install', 'update', 'create', 'search'],
  mamba: ['install', 'update', 'create', 'search'],
  micromamba: ['install', 'update', 'create', 'search'],
  dotnet: ['restore', 'add package', 'tool install'],
  docker: ['pull', 'push', 'login', 'logout', 'search', 'image pull', 'image push', 'compose pull'],
  podman: ['pull', 'push', 'login', 'logout', 'search', 'image pull', 'image push'],
  dart: ['pub get', 'pub add', 'pub upgrade', 'pub outdated', 'pub publish'],
  flutter: ['pub get', 'pub add', 'pub upgrade', 'pub outdated', 'pub publish'],
}
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'remote update', 'submodule update', 'submodule sync', 'lfs pull', 'lfs push', 'lfs fetch', 'subtree pull', 'subtree push', 'svn', 'send-email'])
const OPTIONS_WITH_VALUE = new Set(['--prefix', '-C', '--cwd', '-w', '--workspace', '--filter', '-F', '--registry', '--project', '-p', '--directory', '-c', '--git-dir', '--work-tree', '-f', '--file'])

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Words of each simple command, quotes resolved. */
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = [[]]
  let word: string | undefined
  let index = 0
  const endWord = (): void => {
    if (word !== undefined) commands.at(-1)?.push(word)
    word = undefined
  }
  while (index < command.length) {
    const char = command[index] ?? ''
    if (char === "'" || char === '"') {
      let close = index + 1
      while (close < command.length && command[close] !== char) close += char === '"' && command[close] === '\\' ? 2 : 1
      if (close >= command.length) break
      const inner = command.slice(index + 1, close)
      word = (word ?? '') + (char === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner)
      index = close + 1
    } else if (char === '\\') {
      word = (word ?? '') + (command[index + 1] ?? '')
      index += 2
    } else if (/[ \t]/.test(char)) {
      endWord()
      index += 1
    } else if ('|;&\n(){}<>'.includes(char)) {
      endWord()
      if (commands.at(-1)?.length !== 0) commands.push([])
      index += 1
    } else {
      word = (word ?? '') + char
      index += 1
    }
  }
  endWord()
  return commands.filter(words => words.length > 0)
}

/** The text of every `$(...)` and `` `...` `` that is not inside single quotes: commands that run inside other commands. */
const substitutions = (command: string): string[] => {
  const found: string[] = []
  let isSingleQuoted = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === "'") isSingleQuoted = !isSingleQuoted
    else if (char === '\\') index += 1
    else if (!isSingleQuoted && char === '$' && command[index + 1] === '(') {
      let depth = 0
      for (let end = index + 1; end < command.length; end += 1) {
        if (command[end] === '(') depth += 1
        if (command[end] === ')') depth -= 1
        if (depth === 0) {
          found.push(command.slice(index + 2, end))
          break
        }
      }
    } else if (!isSingleQuoted && char === '`') {
      const end = command.indexOf('`', index + 1)
      if (end > index) {
        found.push(command.slice(index + 1, end))
        index = end
      }
    }
  }
  return found
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The program a simple command runs and its arguments, past env assignments and wrappers such as sudo and timeout. */
const programOf = (words: readonly string[]): { name: string; args: string[] } | undefined => {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1
    } else if (WRAPPERS.has(basename(word))) {
      const wrapper = basename(word)
      index += 1
      while (words[index]?.startsWith('-') === true) index += WRAPPER_OPTIONS_WITH_VALUE.has(words[index] ?? '') && wrapper === 'sudo' ? 2 : 1
      if (wrapper === 'timeout') index += 1
    } else break
  }
  const name = basename(words[index] ?? '')
  return name === '' ? undefined : { name, args: words.slice(index + 1) }
}

/** Non-option words, skipping the values of options that take one. */
const positionals = (args: readonly string[]): string[] => {
  const found: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg.startsWith('-')) index += OPTIONS_WITH_VALUE.has(arg) ? 1 : 0
    else found.push(arg)
  }
  return found
}

const LOOPBACK_TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]*@)?(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)|^:\d+(?:[/?#]|$)/i
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i
const REMOTE_SPEC = /^(?:rsync:\/\/|[\w.-]+@[\w.-]+:|(?:[\w-]+\.)+[\w-]+:(?!\/\/)|[A-Za-z][\w-]+:(?![\\/]))/

/** curl and friends are fine when every target is this machine; with no recognisable target they are not. */
const fetchesOnlyLocally = (args: readonly string[]): boolean => {
  const targets = args.flatMap((arg, index) => (ANY_URL.test(arg) || LOOPBACK_TARGET.test(arg) ? [arg] : arg === '--url' && args[index + 1] !== undefined ? [args[index + 1] ?? ''] : []))
  return targets.length > 0 && targets.every(target => LOOPBACK_TARGET.test(target))
}

const isLocalGitSource = (source: string | undefined): boolean => source !== undefined && /^(?:\.{0,2}\/|file:\/\/|~)/.test(source)

/** The network operation a simple command performs, as a short label, or undefined. */
const networkLabel = (words: readonly string[]): string | undefined => {
  const program = programOf(words)
  if (program === undefined) return undefined
  const { name, args } = program
  if (FETCHERS.has(name)) return args.some(arg => INFO_FLAGS.has(arg)) || fetchesOnlyLocally(args) ? undefined : name
  if (NETWORK_PROGRAMS.has(name)) return name
  if (name === 'rsync') return args.some(arg => REMOTE_SPEC.test(arg)) ? 'rsync to a remote host' : undefined
  if (args.some(arg => OFFLINE_FLAGS.has(arg))) return undefined

  if (name === 'git') {
    const [first = '', second = ''] = positionals(args)
    const subcommand = GIT_NETWORK.has(`${first} ${second}`) ? `${first} ${second}` : first
    if (!GIT_NETWORK.has(subcommand)) return undefined
    return subcommand === 'clone' && isLocalGitSource(second) ? undefined : `git ${subcommand}`
  }
  if (name === 'python' || name === 'python3') {
    const [flag, module, ...rest] = args
    return flag === '-m' && (module === 'pip' || module === 'pip3') && ['install', 'download', 'wheel'].includes(positionals(rest)[0] ?? '') ? `pip ${positionals(rest)[0]}` : undefined
  }

  const subcommands = SUBCOMMANDS[name]
  if (subcommands === undefined) return undefined
  const words2 = positionals(args)
  // A package manager run with no subcommand at all (bare `yarn`) installs.
  if (name === 'yarn' && words2.length === 0 && !args.some(arg => INFO_FLAGS.has(arg))) return 'yarn install'
  const subcommand = subcommands.find(entry => entry.split(' ').every((part, index) => words2[index] === part))
  return subcommand === undefined ? undefined : `${name} ${subcommand}`
}

/** What a shell command does with the network, as a short label such as "git push" or "npm install"; undefined when nothing. */
export const networkUse = (command: string, depth = 0): string | undefined => {
  for (const words of simpleCommands(command)) {
    const label = networkLabel(words)
    if (label !== undefined) return label

    // `bash -c "..."` and `eval ...` run a command line of their own.
    const program = programOf(words)
    if (depth < MAX_NESTING && program !== undefined) {
      const flagAt = program.args.indexOf('-c')
      const isShell = /^(?:ba|z|da|k)?sh$/.test(program.name) && flagAt >= 0
      const script = isShell ? program.args[flagAt + 1] : program.name === 'eval' ? program.args.join(' ') : undefined
      const inner = script === undefined ? undefined : networkUse(script, depth + 1)
      if (inner !== undefined) return inner
    }
  }
  if (depth < MAX_NESTING) {
    for (const inner of substitutions(command)) {
      const label = networkUse(inner, depth + 1)
      if (label !== undefined) return label
    }
  }
  return undefined
}

import { simpleCommands } from './shared/shell'


/** Programs that always talk to the network (curl and friends are judged by their targets, see LOOPBACK_OK). */
const NETWORK_PROGRAMS = new Set([
  'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'netcat', 'mosh', 'ping', 'ping6', 'traceroute', 'dig', 'nslookup', 'whois',
  'gh', 'glab', 'aws', 'gcloud', 'gsutil', 'bq', 'az', 'kubectl', 'helm', 'terraform', 'pulumi', 'vercel', 'netlify', 'firebase',
  'wrangler', 'heroku', 'flyctl', 'fly', 'supabase', 'doctl', 'railway',
  'bunx', 'pnpx', 'uvx',
])
const FETCHERS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs'])
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

/** The network operation a simple command performs (its program's name and arguments), as a short label, or undefined. */
const networkLabel = (name: string, args: readonly string[]): string | undefined => {
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

/**
 * What a shell command does with the network, as a short label such as "git push" or "npm install"; undefined
 * when nothing. The shared shell reader splits the line, peels wrappers (`sudo`, `env VAR=x`, `time`, `timeout`,
 * `xargs`; `command -v curl` only looks a program up) and reads `bash -c "..."`, `su -c`, `eval`, `$(...)`,
 * backticks and heredocs fed to a shell.
 */
export const networkUse = (command: string): string | undefined => {
  for (const { name, argv } of simpleCommands(command)) {
    const label = name === '' ? undefined : networkLabel(name, argv.slice(1))
    if (label !== undefined) return label
  }
  return undefined
}

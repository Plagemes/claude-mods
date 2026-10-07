import { baseName, simpleCommands } from './shared/shell'

export type Server = { tool: string; port: number }

/** `npm run dev`, `pnpm dev`, `yarn start`: a package script the caller can read and analyse in turn. */
export type ScriptRef = { name: string; args: string[]; env: Readonly<Record<string, string>>; directory: string }

export type Analysis = { servers: Server[]; scripts: ScriptRef[] }

type Spec = {
  tool: string
  port: number
  /** Flags that set the port: `--port 4000`, `--port=4000`, `-p 4000`, `-p4000`; the value may be `host:port`. */
  flags?: readonly string[]
  /** Environment variables the tool reads the port from. */
  env?: readonly string[]
}

const RUNNERS: readonly (readonly string[])[] = [['npx'], ['bunx'], ['pnpx'], ['npm', 'exec'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn', 'exec'], ['yarn', 'dlx'], ['bun', 'x'], ['bundle', 'exec'], ['poetry', 'run'], ['pipenv', 'run'], ['uv', 'run']]
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** Package-manager words that are commands of their own, not script names. */
const NOT_SCRIPTS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'up', 'init', 'dlx', 'exec', 'x', 'create', 'link', 'unlink',
  'publish', 'pack', 'audit', 'outdated', 'ls', 'list', 'why', 'cache', 'config', 'set', 'get', 'info', 'view', 'login', 'logout', 'whoami',
  'version', 'patch', 'rebuild', 'store', 'import', 'test', 'build', 'lint', 'format', 'typecheck', 'tsc', 'clean', 'help',
])
/** Programs that start another program: `--port N` on them is likely a server's own flag. */
const LAUNCHERS = new Set(['node', 'nodemon', 'ts-node', 'ts-node-dev', 'tsx', 'bun', 'deno', 'python', 'python3', 'ruby', 'php', 'java', 'npx', 'pnpx', 'bunx'])
/** Programs that run several commands given as arguments: `concurrently "vite" "npm:api"`. */
const CONCURRENT = new Set(['concurrently', 'npm-run-all', 'run-p', 'run-s'])
const PYTHON = /^(?:python|py)\d*(?:\.\d+)*(?:\.exe)?$/

const runnerOf = (words: readonly string[]): readonly string[] | undefined =>
  RUNNERS.find(prefix => prefix.every((word, index) => words[index] === word))

function withoutRunners(words: readonly string[]): string[] {
  let rest = [...words]
  for (let runner = runnerOf(rest); runner !== undefined; runner = runnerOf(rest)) {
    rest = rest.slice(runner.length)
    while (rest[0]?.startsWith('-')) rest = rest.slice(1)
  }
  return rest
}

/** The port in `4000`, `0.0.0.0:4000`, `[::]:4000` or `tcp://0.0.0.0:4000`; undefined for anything else. */
export function portIn(text: string | undefined): number | undefined {
  const match = /^(?:[\w.:/[\]-]*:)?(\d{2,5})$/.exec(text ?? '')
  const port = match === null ? Number.NaN : Number(match[1])
  return port >= 1 && port <= 65535 ? port : undefined
}

function flagPort(args: readonly string[], flags: readonly string[]): number | undefined {
  for (const [index, arg] of args.entries()) {
    for (const flag of flags) {
      if (arg === flag) return portIn(args[index + 1])
      if (arg.startsWith(`${flag}=`)) return portIn(arg.slice(flag.length + 1))
      if (flag.length === 2 && !flag.startsWith('--') && arg.startsWith(flag)) {
        const attached = portIn(arg.slice(flag.length))
        if (attached !== undefined) return attached
      }
    }
  }
  return undefined
}

const firstPositional = (args: readonly string[]): string | undefined => args.find(arg => !arg.startsWith('-'))

/** The server a program starts, with its default port; undefined when it starts none. */
function specOf(exe: string, args: readonly string[]): Spec | undefined {
  const [first, second] = args
  const sub = (...names: string[]) => first !== undefined && names.includes(first)
  switch (exe) {
    case 'vite':
      return first === 'build' || first === 'optimize' ? undefined : { tool: 'vite', port: first === 'preview' ? 4173 : 5173, flags: ['--port'] }
    case 'next':
      return sub('dev', 'start') ? { tool: 'next', port: 3000, flags: ['-p', '--port'], env: ['PORT'] } : undefined
    case 'react-scripts':
      return sub('start') ? { tool: 'react-scripts', port: 3000, env: ['PORT'] } : undefined
    case 'nuxt': case 'nuxi': case 'nuxt3':
      return sub('dev') ? { tool: 'nuxt', port: 3000, flags: ['-p', '--port'], env: ['PORT', 'NUXT_PORT'] } : undefined
    case 'astro':
      return sub('dev', 'preview') ? { tool: 'astro', port: 4321, flags: ['--port'] } : undefined
    case 'remix':
      return sub('dev') ? { tool: 'remix', port: 3000, flags: ['--port'] } : sub('vite:dev') ? { tool: 'remix', port: 5173, flags: ['--port'] } : undefined
    case 'webpack':
      return args.some(arg => ['serve', 's', 'server'].includes(arg)) ? { tool: 'webpack', port: 8080, flags: ['--port'] } : undefined
    case 'webpack-dev-server':
      return { tool: 'webpack-dev-server', port: 8080, flags: ['--port'] }
    case 'ng':
      return sub('serve', 's') ? { tool: 'ng', port: 4200, flags: ['--port'] } : undefined
    case 'vue-cli-service':
      return sub('serve') ? { tool: 'vue-cli-service', port: 8080, flags: ['--port'], env: ['PORT'] } : undefined
    case 'svelte-kit':
      return sub('dev', 'preview') ? { tool: 'svelte-kit', port: first === 'preview' ? 4173 : 5173, flags: ['--port'] } : undefined
    case 'gatsby':
      return sub('develop', 'serve') ? { tool: 'gatsby', port: first === 'serve' ? 9000 : 8000, flags: ['-p', '--port'] } : undefined
    case 'storybook':
      return sub('dev') ? { tool: 'storybook', port: 6006, flags: ['-p', '--port'] } : undefined
    case 'start-storybook':
      return { tool: 'storybook', port: 6006, flags: ['-p', '--port'] }
    case 'serve':
      return { tool: 'serve', port: 3000, flags: ['-l', '--listen'] }
    case 'http-server':
      return { tool: 'http-server', port: 8080, flags: ['-p', '--port'] }
    case 'live-server':
      return { tool: 'live-server', port: 8080, flags: ['--port'] }
    case 'rails':
      return sub('s', 'server') ? { tool: 'rails', port: 3000, flags: ['-p', '--port'], env: ['PORT'] } : undefined
    case 'rackup':
      return { tool: 'rackup', port: 9292, flags: ['-p', '--port'] }
    case 'flask':
      return args.includes('run') ? { tool: 'flask', port: 5000, flags: ['-p', '--port'], env: ['FLASK_RUN_PORT'] } : undefined
    case 'uvicorn': case 'hypercorn':
      return { tool: exe, port: 8000, flags: ['--port', '-b', '--bind'] }
    case 'gunicorn':
      return { tool: 'gunicorn', port: 8000, flags: ['-b', '--bind'] }
    case 'daphne':
      return { tool: 'daphne', port: 8000, flags: ['-p', '--port'] }
    case 'fastapi':
      return sub('dev', 'run') ? { tool: 'fastapi', port: 8000, flags: ['--port'] } : undefined
    case 'streamlit':
      return sub('run') ? { tool: 'streamlit', port: 8501, flags: ['--server.port'] } : undefined
    case 'jupyter':
      return sub('notebook', 'lab') ? { tool: 'jupyter', port: 8888, flags: ['--port'] } : undefined
    case 'mkdocs':
      return sub('serve') ? { tool: 'mkdocs', port: 8000, flags: ['-a', '--dev-addr'] } : undefined
    case 'waitress-serve':
      return { tool: 'waitress', port: 8080, flags: ['--port'] }
    case 'symfony':
      return sub('serve') ? { tool: 'symfony', port: 8000, flags: ['--port'] } : undefined
    case 'hugo':
      return sub('server') ? { tool: 'hugo', port: 1313, flags: ['-p', '--port'] } : undefined
    case 'jekyll':
      return sub('serve', 's') ? { tool: 'jekyll', port: 4000, flags: ['-P', '--port'] } : undefined
    case 'php':
      if (args.includes('artisan') && args.includes('serve')) return { tool: 'php artisan serve', port: 8000, flags: ['--port'] }
      return args.includes('-S') ? { tool: 'php -S', port: 8000, flags: ['-S'] } : undefined
    case 'django-admin':
      return sub('runserver') ? { tool: 'runserver', port: 8000 } : undefined
    default:
      if (PYTHON.test(exe) && baseName(first ?? '') === 'manage.py' && second === 'runserver') return { tool: 'runserver', port: 8000 }
      return undefined
  }
}

/** `runserver [addr:]port`: the port is the first plain argument after it. */
function runserverPort(args: readonly string[]): number | undefined {
  return portIn(firstPositional(args.slice(args.indexOf('runserver') + 1)))
}

/** The server a command line (or one segment's words) starts: its tool, and the port it will listen on. */
function serverOf(words: readonly string[], env: Readonly<Record<string, string>>): Server | undefined {
  const [first = '', ...args] = withoutRunners(words)
  const exe = baseName(first)
  let spec = specOf(exe, args)
  let toolArgs = args
  if (spec === undefined && PYTHON.test(exe) && args[0] === '-m' && args[1] !== undefined) {
    if (args[1] === 'http.server') {
      const port = portIn(firstPositional(args.slice(2))) ?? 8000
      return { tool: 'http.server', port }
    }
    toolArgs = args.slice(2)
    spec = specOf(args[1], toolArgs)
  }
  if (spec !== undefined) {
    const fromFlag = spec.flags === undefined ? undefined : flagPort(toolArgs, spec.flags)
    const fromEnv = (spec.env ?? []).map(name => portIn(env[name])).find(port => port !== undefined)
    const fromPositional = spec.tool === 'runserver' ? runserverPort(toolArgs) : undefined
    return { tool: spec.tool, port: fromFlag ?? fromPositional ?? fromEnv ?? spec.port }
  }
  if (LAUNCHERS.has(exe)) {
    const port = flagPort(args, ['--port'])
    if (port !== undefined) return { tool: exe, port }
  }
  return undefined
}

/** Package-manager options that take the next word as their value: `--filter web`, `--prefix web`. */
const MANAGER_VALUE_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--cwd', '--workspace', '-w', '--dir'])

/** The words before the script name, without the manager's own options (`pnpm --filter web dev` -> `dev`). */
function withoutManagerFlags(words: readonly string[]): string[] {
  const rest: string[] = []
  let isLeading = true
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    if (isLeading && word.startsWith('-')) index += MANAGER_VALUE_FLAGS.has(word) ? 1 : 0
    else {
      isLeading = false
      rest.push(word)
    }
  }
  return rest
}

/** The package script a `npm run x`, `pnpm x` or `yarn x` command line runs, with the arguments passed on to it. */
function scriptOf(words: readonly string[]): { name: string; args: string[] } | undefined {
  const [manager = '', ...all] = words
  if (!PACKAGE_MANAGERS.has(baseName(manager))) return undefined
  const kind = baseName(manager)
  const [first, ...after] = withoutManagerFlags(all)
  const isRun = first === 'run' || first === 'run-script'
  const name = isRun ? after[0] : kind === 'npm' ? (first === 'start' ? first : undefined) : first
  if (name === undefined || name.startsWith('-') || (!isRun && NOT_SCRIPTS.has(name))) return undefined
  const passed = (isRun ? after.slice(1) : after).filter(word => word !== '--')
  return { name, args: passed }
}

function moveTo(directory: string, target: string): string {
  if (target.startsWith('/') || target.startsWith('~')) return target
  const parts = directory === '' ? [] : directory.split('/')
  for (const part of target.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/**
 * The dev servers a command line (or a package script's text) starts and the package scripts it runs.
 * `inherited` are variables set by whoever runs it (`PORT=4000 npm run dev`); `extra` are arguments
 * passed on to it (`npm run dev -- --port 4000`). Reads text; runs nothing.
 */
export function analyze(text: string, inherited: Readonly<Record<string, string>> = {}, extra: readonly string[] = []): Analysis {
  const servers: Server[] = []
  const scripts: ScriptRef[] = []
  let directory = ''
  for (const { argv: words, assignments } of simpleCommands(text)) {
    const env = { ...inherited, ...assignments }
    if (words[0] === 'cd' && words[1] !== undefined) {
      directory = moveTo(directory, words[1])
      continue
    }
    if (words[0] !== undefined && CONCURRENT.has(baseName(words[0]))) {
      for (const part of words.slice(1).filter(word => !word.startsWith('-'))) {
        const named = /^(?:npm|pnpm|yarn|bun):([\w:.-]+)$/.exec(part)
        if (named !== null) scripts.push({ name: named[1] as string, args: [...extra], env, directory })
        else {
          const inner = analyze(part, env, extra)
          servers.push(...inner.servers)
          scripts.push(...inner.scripts.map(script => ({ ...script, directory: moveTo(directory, script.directory) })))
        }
      }
      continue
    }
    const server = serverOf([...words, ...extra], env)
    if (server !== undefined) {
      servers.push(server)
      continue
    }
    const script = scriptOf(words)
    if (script !== undefined) scripts.push({ ...script, args: [...script.args, ...extra], env, directory })
  }
  return { servers, scripts }
}

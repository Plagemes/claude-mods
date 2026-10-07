import { simpleCommands } from './shared/shell'

/** One command of a command line, as words, and whether the shell sent it to the background with `&`. */
export type Segment = { words: string[]; isBackground: boolean }

/** A command that never ends on its own, and what to run instead. */
export type Verdict = { command: string; instead: string }

type Invocation = { program: string; args: string[]; env: Map<string, string> }

/** Runners the shared shell reader leaves on: `npx jest --watch` runs jest. */
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx'])
/** `bundle exec rails s`, `poetry run flask run`, `pnpm exec jest`: the program is what comes after. */
const EXEC_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  bundle: ['exec'], poetry: ['run'], uv: ['run'], pipenv: ['run'], pdm: ['run'], rye: ['run'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], npm: ['exec'], bun: ['x'],
}
const WRAPPER_FLAGS_WITH_VALUE = new Set(['-n', '-u', '-g', '-C'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Package scripts that by convention start something that keeps running (`dev`, `start:prod`, `test:watch`; not `build:dev` or `test:unit`). */
const isLongRunningScript = (script: string): boolean =>
  /^watch$|^watch[:-]|[:-]watch$/.test(script) ||
  (!/^(?:build|lint|compile|bundle|generate|format|clean|test)/.test(script) &&
    !/[:-](?:build|lint|compile|bundle|generate|format|clean|check|typecheck)$/.test(script) &&
    /^(?:dev|start|serve|develop|preview|storybook|server|live|hot)(?:[:-]\S+)?$|[:-](?:dev|serve)$/.test(script))

/** What to say about a server or other command with no "once" form. */
export const BACKGROUND_ONLY = 'Start it with run_in_background: true and check its output while it runs.'
const WITHOUT_WATCH = 'Run the same command without the watch flag so it runs once.'

/** Programs that are a server or a watcher whatever they are given. */
const ALWAYS_RUNNING = new Set([
  'nodemon', 'ts-node-dev', 'supervisor', 'webpack-dev-server', 'live-server', 'http-server', 'json-server', 'browser-sync', 'serve', 'uvicorn',
  'gunicorn', 'hypercorn', 'daphne', 'rackup', 'puma', 'unicorn', 'air', 'start-storybook', 'cargo-watch', 'watchexec', 'entr', 'watch', 'htop',
  'ngrok',
])
/** The subcommand that starts a server, a dev server or a watcher, per program. */
const SERVING_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  next: ['dev', 'start'], nuxt: ['dev', 'preview'], nuxi: ['dev', 'preview'], astro: ['dev', 'preview'], remix: ['dev'], gatsby: ['develop', 'serve'],
  ng: ['serve', 's'], 'react-scripts': ['start'], docusaurus: ['start', 'serve'], wrangler: ['dev'], vercel: ['dev'], netlify: ['dev'], expo: ['start'],
  storybook: ['dev'], hugo: ['server', 'serve'], jekyll: ['serve', 's', 'server'], mkdocs: ['serve'], rails: ['s', 'server'], fastapi: ['dev', 'run'],
  flask: ['run'], streamlit: ['run'], jupyter: ['notebook', 'lab'], symfony: ['server:start', 'serve'], dotnet: ['watch'], cargo: ['watch'],
  mix: ['phx.server'], gulp: ['watch'], grunt: ['watch'], parcel: ['watch', 'serve'], firebase: ['serve', 'emulators:start'],
}
/** The flags that turn a program into a watcher, and what to run instead when it is not just "without the flag". */
const WATCH_FLAGS: Readonly<Record<string, { flags: readonly string[]; instead?: string }>> = {
  jest: { flags: ['--watch', '--watchAll'], instead: 'Run `jest --ci` (without --watch) so it runs once.' },
  tsc: { flags: ['--watch', '-w'], instead: 'Run `tsc --noEmit` once for a type check, or `tsc` without --watch for a build.' },
  mocha: { flags: ['--watch', '-w'] },
  ava: { flags: ['--watch', '-w'] },
  webpack: { flags: ['--watch', '-w'], instead: 'Run `webpack` without --watch for a one-off build.' },
  rollup: { flags: ['--watch', '-w'] },
  esbuild: { flags: ['--watch', '--serve'] },
  tsup: { flags: ['--watch'] },
  swc: { flags: ['--watch', '-w'] },
  babel: { flags: ['--watch', '-w'] },
  sass: { flags: ['--watch'] },
  tailwindcss: { flags: ['--watch', '-w'] },
  postcss: { flags: ['--watch', '-w'] },
  node: { flags: ['--watch', '--watch-path'] },
  bun: { flags: ['--watch', '--hot'] },
  deno: { flags: ['--watch'] },
  tsx: { flags: ['--watch'] },
  gradle: { flags: ['--continuous', '-t'] },
  gradlew: { flags: ['--continuous', '-t'] },
}
const PYTHON_SERVER_MODULES = new Set(['http.server', 'SimpleHTTPServer', 'uvicorn', 'gunicorn', 'hypercorn', 'streamlit', 'mkdocs'])
const FOLLOW = ['-f', '-F', '--follow']

const baseName = (program: string): string => program.split('/').at(-1) ?? program

/** Whether one of `names` is among `args`, bare or as `--name=value`. */
const hasFlag = (args: readonly string[], names: readonly string[]): boolean => args.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)))

/** Whether a watch flag is on: `--watch`, but not `--watch=false` or `--watchAll=0`. */
const hasWatchFlag = (args: readonly string[], names: readonly string[]): boolean =>
  args.some(arg => names.some(name => arg === name || (arg.startsWith(`${name}=`) && !/^(?:false|0|no)$/i.test(arg.slice(name.length + 1)))))

/** Flags that only print something and exit (`vite --help`, `nodemon --version`). */
const PRINT_AND_EXIT = ['--help', '--version']

/** Whether a bundle of short flags (`-fn`, `-nf`) holds one of `letters`. */
const hasShortFlag = (args: readonly string[], letters: string): boolean => args.some(arg => /^-[A-Za-z]+$/.test(arg) && [...letters].some(letter => arg.includes(letter)))

/**
 * The commands of a line, from the shared claude-mods shell reader (quotes, line continuations and here-document
 * bodies understood, wrappers such as `sudo` and `env` peeled, redirections set apart), and whether each was sent
 * to the background with `&`. Only the line itself: scripts handed to a shell are read by findNeverEnding.
 */
export const segmentsOf = (command: string): Segment[] =>
  simpleCommands(command)
    .filter(cmd => cmd.depth === 0 && cmd.argv.length > 0)
    .map(cmd => ({ words: cmd.argv, isBackground: cmd.isBackground }))

const withoutLeadingFlags = (words: readonly string[]): string[] => {
  let skipped = 0
  while (words[skipped]?.startsWith('-') === true) skipped += WRAPPER_FLAGS_WITH_VALUE.has(words[skipped] ?? '') ? 2 : 1
  return words.slice(skipped)
}

/** The program a command runs and its arguments, with `npx`, `bundle exec` and the like in front taken off. */
const invocationOf = (words: readonly string[], env: Map<string, string>): Invocation => {
  let rest = [...words]
  for (;;) {
    const [first = '', second = ''] = rest
    if (WRAPPERS.has(first)) {
      rest = withoutLeadingFlags(rest.slice(1))
    } else if (EXEC_WRAPPERS[first]?.includes(second) === true) {
      rest = withoutLeadingFlags(rest.slice(2))
    } else {
      return { program: baseName(first), args: rest.slice(1), env }
    }
  }
}

const isSet = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'

/** The script `npm run x`, `yarn x` or `pnpm run x` would start; for `npm` only `start` is a command of its own. */
const scriptOf = (program: string, args: readonly string[]): string | undefined => {
  const first = args.find(arg => !arg.startsWith('-'))
  if (first === 'run' || first === 'run-script') return args.slice(args.indexOf(first) + 1).find(arg => !arg.startsWith('-'))
  return program === 'npm' && first !== 'start' ? undefined : first
}

const packageVerdict = (program: string, args: readonly string[]): string | undefined => {
  if (hasWatchFlag(args, ['--watch', '--watchAll'])) return WITHOUT_WATCH
  const script = scriptOf(program, args)
  return script !== undefined && isLongRunningScript(script) ? BACKGROUND_ONLY : undefined
}

const vitestVerdict = (args: readonly string[], subcommand: string | undefined, isCi: boolean): string | undefined => {
  const isWatchOff = hasFlag(args, ['--no-watch', '--watch=false']) || args.join(' ').includes('--watch false')
  const isWatchOn = hasFlag(args, ['--watch']) && !isWatchOff
  const isOnce = subcommand === 'run' || ['bench', 'list', 'init'].includes(subcommand ?? '') || hasFlag(args, ['--run']) || isWatchOff
  return isWatchOn || !(isOnce || isCi) ? 'Run `vitest run` so it runs once and exits.' : undefined
}

/** Global flags that take a value before the subcommand: `docker compose -f dev.yml up`, `kubectl -n web logs -f api`. */
const CONTAINER_VALUE_FLAGS = new Set([
  '-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel',
  '-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '-n', '--namespace', '--kubeconfig', '--cluster', '--user', '-s', '--server',
])

/** The first word of `args` that is not a flag or a flag's value, and the words after it. */
const subcommandOf = (args: readonly string[]): { verb: string; rest: string[] } => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (CONTAINER_VALUE_FLAGS.has(arg)) i += 1
    else if (!arg.startsWith('-')) return { verb: arg, rest: args.slice(i + 1) }
  }
  return { verb: '', rest: [] }
}

/** `kubectl get -w` or `-Aw`, but not `-owide` (the `w` there is the value of `-o`). */
const hasKubectlWatch = (args: readonly string[]): boolean =>
  hasFlag(args, ['--watch']) || args.some(arg => /^-[A-Za-z]+$/.test(arg) && (arg.slice(1).split(/[onlfLcs]/)[0] ?? '').includes('w'))

/** Following logs and watching resources: `docker logs -f`, `docker compose up`, `kubectl get -w`, `kubectl port-forward`. */
const containerVerdict = (program: string, args: readonly string[]): string | undefined => {
  const top = subcommandOf(args)
  if (program === 'kubectl') {
    const { verb, rest } = top
    if (verb === 'logs') return hasFlag(rest, FOLLOW) || hasShortFlag(rest, 'f') ? 'Use `kubectl logs --tail=100 <pod>` to read the end once, or run_in_background: true to follow it.' : undefined
    if (verb === 'port-forward') return BACKGROUND_ONLY
    return verb === 'get' && hasKubectlWatch(rest) ? 'Drop --watch to list once.' : undefined
  }
  const isCompose = program === 'docker-compose' || top.verb === 'compose'
  const { verb, rest } = top.verb === 'compose' || top.verb === 'container' ? subcommandOf(top.rest) : top
  if (verb === 'logs') return hasFlag(rest, FOLLOW) || hasShortFlag(rest, 'f') ? 'Use `--tail 100` to read the end once, or run_in_background: true to follow it.' : undefined
  if (verb === 'up' && isCompose) {
    const isDone = hasFlag(rest, ['--detach', '--wait', '--no-start', '--abort-on-container-exit', '--exit-code-from']) || hasShortFlag(rest, 'd')
    return isDone ? undefined : 'Add -d (`docker compose up -d`) so it starts in the background, then read the output with `docker compose logs --tail 100`.'
  }
  return undefined
}

const verdictFor = (invocation: Invocation, isCi: boolean): string | undefined => {
  const { program, args, env } = invocation
  const subcommand = args.find(arg => !arg.startsWith('-') && !arg.startsWith('+'))

  if (args.some(arg => PRINT_AND_EXIT.includes(arg))) return undefined
  if (args.includes('runserver') && (/^python[\d.]*$/.test(program) || program === 'manage.py' || program === 'django-admin')) return BACKGROUND_ONLY
  if (PACKAGE_MANAGERS.has(program)) {
    const verdict = packageVerdict(program, args)
    if (verdict !== undefined) return verdict
  }
  if (program === 'vitest') return vitestVerdict(args, subcommand, isCi || isSet(env.get('CI')) || isSet(env.get('GITHUB_ACTIONS')))
  if (program === 'vite') {
    if (subcommand === undefined || ['dev', 'serve', 'preview'].includes(subcommand)) return BACKGROUND_ONLY
    return subcommand === 'build' && hasFlag(args, ['--watch', '-w']) ? WITHOUT_WATCH : undefined
  }
  if (program === 'webpack' || program === 'webpack-cli') {
    const isServing = ['serve', 's', 'watch'].includes(subcommand ?? '')
    return isServing || hasFlag(args, ['--watch', '-w']) ? 'Run `webpack` without --watch for a one-off build.' : undefined
  }
  if (program === 'parcel') return subcommand === 'build' ? undefined : BACKGROUND_ONLY
  if (program === 'tail') return hasFlag(args, FOLLOW) || hasShortFlag(args, 'fF') ? 'Use `tail -n 100 <file>` to read the end once, or run_in_background: true to follow it.' : undefined
  if (program === 'journalctl') return hasFlag(args, ['--follow']) || hasShortFlag(args, 'f') ? 'Use `journalctl -n 100 --no-pager` to read the end once, or run_in_background: true to follow it.' : undefined
  if (program === 'ping') return args.some((arg, i) => /^-[cwW]\d*$/.test(arg) || arg === '--count' || arg === '--deadline' || (arg === '-n' && /^\d+$/.test(args[i + 1] ?? ''))) ? undefined : 'Add `-c 4` so ping stops, or run_in_background: true.'
  if (program === 'top') return hasShortFlag(args, 'nl') ? undefined : 'Use `top -b -n 1` (Linux) or `top -l 1` (macOS) for a single snapshot.'
  if (program === 'kubectl' || program === 'docker' || program === 'docker-compose') return containerVerdict(program, args)
  if (program === 'php') return hasFlag(args, ['-S']) || (args[0] === 'artisan' && args[1] === 'serve') ? BACKGROUND_ONLY : undefined
  if (/^python[\d.]*$/.test(program)) return args[0] === '-m' && PYTHON_SERVER_MODULES.has(args[1] ?? '') ? BACKGROUND_ONLY : undefined
  if (ALWAYS_RUNNING.has(program)) return BACKGROUND_ONLY
  if (SERVING_SUBCOMMANDS[program]?.includes(subcommand ?? '') === true) return BACKGROUND_ONLY

  const watcher = WATCH_FLAGS[program]
  return watcher !== undefined && hasWatchFlag(args, watcher.flags) ? (watcher.instead ?? WITHOUT_WATCH) : undefined
}

/**
 * The first command in `command` that would keep running in the foreground, with what to run instead.
 * Commands sent to the background with `&`, or bounded by `timeout`, stop on their own or never hold the turn,
 * and so does what they run inside (`timeout 60 bash -c "npm run dev"`). The shared shell reader opens
 * `bash -lc "…"`, `eval`, `$(…)` and heredocs fed to a shell; `watch <cmd>` repeats its command forever.
 */
export const findNeverEnding = (command: string, isCi: boolean): Verdict | undefined => {
  /** Whether the latest command at each depth holds the line: a script nested at depth d is run by the one at d - 1. */
  const holds: boolean[] = []
  for (const cmd of simpleCommands(command)) {
    const isBounded = cmd.wrappers.includes('timeout')
    // A substitution runs before its command, whatever wraps that command (its `&` is already in isBackground).
    const parentHolds = cmd.depth === 0 || cmd.via === '$()' || holds[cmd.depth - 1] === true
    const doesHold = parentHolds && !cmd.isBackground && !isBounded
    holds[cmd.depth] = doesHold
    if (!doesHold || cmd.argv.length === 0) continue
    const shown = cmd.argv.join(' ')
    if (cmd.wrappers.includes('watch')) return { command: `watch ${shown}`, instead: BACKGROUND_ONLY }
    const instead = verdictFor(invocationOf(cmd.argv, new Map(Object.entries(cmd.assignments))), isCi)
    if (instead !== undefined) return { command: shown, instead }
  }
  return undefined
}

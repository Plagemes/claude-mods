import { baseName, simpleCommands, type ShellCommand } from './shared/shell'

export type Hit = {
  /** The destructive command, as a short label (`prisma migrate reset`). */
  label: string
  /** Where the command runs, relative to the session's directory: the `cd` words before it. */
  directory: string
  /** `NAME=value` words in front of the command and earlier `export NAME=value` of the same line. */
  assignments: Readonly<Record<string, string>>
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
/** Words that run the next command: `npx prisma ...`, `bundle exec rails ...`. */
const RUNNERS: readonly (readonly string[])[] = [
  ['npx'], ['bunx'], ['pnpx'], ['npm', 'exec'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn', 'exec'], ['yarn', 'dlx'], ['bun', 'x'],
  ['bundle', 'exec'], ['spring'], ['poetry', 'run'], ['pipenv', 'run'], ['uv', 'run'],
]
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/**
 * Script names that seed, reset or drop a database: db:reset, seed:dev, reset-db, prisma:seed, migrate:fresh ...
 * A bare reset/drop/wipe/fresh only counts with a database-ish suffix, so reset-project or reset-cache pass.
 */
const DESTRUCTIVE_SCRIPT =
  /^(?:(?:db|database)[:_-](?:seed|reset|drop|wipe|fresh)|seed)(?:[:_-]\w+)?$|^(?:reset|drop|wipe|fresh)(?:[:_-](?:db|database|data|all|dev|local))?$|^prisma[:_-](?:seed|reset)$|^migrate[:_-](?:fresh|reset|refresh)$/
const RAILS_TASKS = new Set([
  'db:reset', 'db:drop', 'db:drop:all', 'db:seed', 'db:setup', 'db:migrate:reset', 'db:seed:replant', 'db:schema:load', 'db:structure:load', 'db:purge',
])
const ARTISAN_COMMANDS = new Set(['migrate:fresh', 'migrate:refresh', 'migrate:reset', 'db:seed', 'db:wipe'])
const DJANGO_COMMANDS = new Set(['flush', 'reset_db', 'loaddata'])
const SEQUELIZE_COMMANDS = new Set(['db:seed', 'db:seed:all', 'db:seed:undo', 'db:seed:undo:all', 'db:drop', 'db:migrate:undo:all'])
const PYTHON = /^(?:python|py)\d*(?:\.\d+)*(?:\.exe)?$/
const ENVIRONMENT_NAMES = /^(?:RAILS_ENV|RACK_ENV|NODE_ENV|APP_ENV|DJANGO_ENV|ENVIRONMENT)$/
const REMOTE_ENVIRONMENT = /^(?:prod|production|staging|stage)$/i

const runnerOf = (words: readonly string[]): readonly string[] | undefined =>
  RUNNERS.find(prefix => prefix.every((word, index) => words[index] === word))

/** Removes `npx`, `bundle exec` and the like (and their flags) from the front. */
function withoutRunners(words: readonly string[]): string[] {
  let rest = [...words]
  for (let runner = runnerOf(rest); runner !== undefined; runner = runnerOf(rest)) {
    rest = rest.slice(runner.length)
    while (rest[0]?.startsWith('-')) rest = rest.slice(1)
  }
  return rest
}

/** Package-manager options that take the next word as their value: `--filter api`, `--prefix api`. */
/** `exec` and `dlx` run a binary after the package manager's own options. */
const RUNNER_WORDS = new Set(['exec', 'dlx', 'x'])
const MANAGER_VALUE_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--cwd', '--workspace', '-w', '--dir'])

function withoutFlags(args: readonly string[]): string[] {
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (!arg.startsWith('-')) rest.push(arg)
    else if (MANAGER_VALUE_FLAGS.has(arg)) index += 1
  }
  return rest
}

function scriptName(manager: string, args: readonly string[]): string | undefined {
  const [first, second] = withoutFlags(args)
  if (manager === 'npm') return first === 'run' || first === 'run-script' ? second : undefined
  return first === 'run' ? second : first
}

/** What the command is, when it seeds, resets or drops a database; undefined otherwise. */
function destructiveLabel(all: readonly string[]): string | undefined {
  const [first = '', ...args] = withoutRunners(all)
  const tool = baseName(first)
  const [a, b] = args
  const has = (word: string) => args.includes(word)
  const labelled = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ')

  if (tool === 'prisma') {
    if (a === 'migrate' && b === 'reset') return 'prisma migrate reset'
    if (a === 'db' && b === 'push' && has('--force-reset')) return 'prisma db push --force-reset'
    if (a === 'db' && b === 'seed') return 'prisma db seed'
  }
  if (tool === 'rails' || tool === 'rake') {
    const task = args.find(word => RAILS_TASKS.has(word))
    if (task !== undefined) return labelled(tool, task)
  }
  if (tool === 'php' && baseName(a ?? '') === 'artisan' && ARTISAN_COMMANDS.has(b ?? '')) return `php artisan ${b}`
  if (PYTHON.test(tool) && baseName(a ?? '') === 'manage.py' && DJANGO_COMMANDS.has(b ?? '')) return `manage.py ${b}`
  if (tool === 'django-admin' && DJANGO_COMMANDS.has(a ?? '')) return `django-admin ${a}`
  if (tool === 'knex') {
    if (has('seed:run')) return 'knex seed:run'
    if (has('migrate:rollback') && has('--all')) return 'knex migrate:rollback --all'
  }
  if (tool === 'sequelize' || tool === 'sequelize-cli') {
    const command = args.find(word => SEQUELIZE_COMMANDS.has(word))
    if (command !== undefined) return `sequelize ${command}`
  }
  if (tool.startsWith('typeorm') && has('schema:drop')) return 'typeorm schema:drop'
  if (tool === 'mix') {
    if (a === 'ecto.reset' || a === 'ecto.drop') return `mix ${a}`
    if (a === 'run' && (b ?? '').endsWith('seeds.exs')) return 'mix run seeds.exs'
  }
  if ((tool === 'diesel' || tool === 'sqlx') && a === 'database' && (b === 'reset' || b === 'drop')) return `${tool} database ${b}`
  if (tool === 'dropdb') return 'dropdb'
  if (tool === 'mysqladmin' && has('drop')) return 'mysqladmin drop'
  if (PACKAGE_MANAGERS.has(tool)) {
    const script = scriptName(tool, args)
    if (script !== undefined && DESTRUCTIVE_SCRIPT.test(script)) return tool === 'npm' ? `npm run ${script}` : `${tool} ${script}`
    // `yarn prisma migrate reset`, `pnpm -F api exec knex seed:run`: the package manager runs a binary.
    const [head, ...tail] = withoutFlags(args)
    if (head !== undefined && RUNNER_WORDS.has(head)) return destructiveLabel(tail)
    if (tool !== 'npm' && head !== undefined) return destructiveLabel([head, ...tail])
  }
  return undefined
}

/** Joins and normalises a `cd` target onto a directory; an absolute or `~` target replaces it. */
export function moveTo(directory: string, target: string): string {
  if (target.startsWith('/') || target.startsWith('~')) return target
  const parts = directory === '' ? [] : directory.split('/')
  for (const part of target.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/** Where commands of one script run, and what it exported so far. */
type Scope = { directory: string; exported: Record<string, string> }

/**
 * Destructive database commands of the line, with the `cd` and `export` words that came before them. Reads text;
 * runs nothing. The shared shell reader opens `bash -c`, `eval`, `$(…)` and heredocs fed to a shell; a nested
 * script starts where its parent command runs, with the parent's `NAME=value` words (not for `$(…)`, whose
 * assignments do not reach the substitution), and its own `cd` and `export` stay inside it.
 */
export function findDestructive(line: string): Hit[] {
  const hits: Hit[] = []
  const scopes = new Map<number, Scope>()
  /** The latest command seen at each depth, and its scope: a script nested at depth d belongs to the one at d - 1. */
  const latest: { scope: Scope; command: ShellCommand }[] = []
  for (const command of simpleCommands(line)) {
    let scope = scopes.get(command.script)
    if (scope === undefined) {
      const parent = latest[command.depth - 1]
      const inherited = parent === undefined || command.via === '$()' ? {} : parent.command.assignments
      scope = { directory: parent?.scope.directory ?? '', exported: { ...parent?.scope.exported, ...inherited } }
      scopes.set(command.script, scope)
    }
    const { argv: words } = command
    if (words[0] === 'cd' && words[1] !== undefined) {
      scope.directory = moveTo(scope.directory, words[1])
    } else if (words[0] === 'export') {
      for (const word of words.slice(1)) {
        const assignment = ASSIGNMENT.exec(word)
        if (assignment !== null) scope.exported[assignment[1] as string] = assignment[2] as string
      }
    } else {
      const label = destructiveLabel(words)
      if (label !== undefined) hits.push({ label, directory: scope.directory, assignments: { ...scope.exported, ...command.assignments } })
    }
    latest[command.depth] = { scope, command }
  }
  return hits
}

/** `RAILS_ENV=production` and the like in the command's own assignments. */
export function remoteEnvironment(assignments: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(assignments)
    .filter(([name, value]) => ENVIRONMENT_NAMES.test(name) && REMOTE_ENVIRONMENT.test(value))
    .map(([name, value]) => `${name}=${value}`)[0]
}

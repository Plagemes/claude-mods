import { isCappable } from './select'
import { parseCommand } from './shell'
import type { Word } from './shell'

type Dialect = 'psql' | 'mysql' | 'sqlite'
/** An argument that holds SQL: the word and how many characters of its value come before the SQL (`--command=`). */
type Target = { word: Word; prefixLength: number }

const PROGRAMS = new Map<string, Dialect>([
  ['psql', 'psql'],
  ['mysql', 'mysql'],
  ['mariadb', 'mysql'],
  ['sqlite3', 'sqlite'],
])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'stdbuf', 'timeout', 'do', 'then', 'else', 'elif', '!', '{'])
const CONTAINER_RUNNERS = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'oc', 'docker-compose', 'compose'])
const WRAPPER_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SQLITE_OPTIONS_WITH_VALUE = new Set(['-cmd', '-init', '-separator', '-newline', '-nullvalue', '-vfs'])
const FLAGS = {
  psql: { short: 'c', long: '--command', cluster: /^-[AtqXxabeEHnsSz01]*c$/ },
  mysql: { short: 'e', long: '--execute', cluster: /^-[NBsrvEtHXqwGAfknoTUb]*e$/ },
} as const

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const valueAt = (words: readonly Word[], index: number): string => words[index]?.value ?? ''

/** The database client of a simple command and where it sits, looking past sudo, env, timeout and container runners. */
const findProgram = (words: readonly Word[]): { dialect: Dialect; index: number } | undefined => {
  let index = 0
  let isInContainer = false
  while (index < words.length) {
    const value = valueAt(words, index)
    const name = basename(value)
    if (ENV_ASSIGNMENT.test(value) || WRAPPERS.has(name)) {
      index += 1
      while (index < words.length && valueAt(words, index).startsWith('-')) index += WRAPPER_OPTIONS_WITH_VALUE.has(valueAt(words, index)) ? 2 : 1
      if (name === 'timeout') index += 1
      continue
    }
    if (CONTAINER_RUNNERS.has(name)) isInContainer = true
    const dialect = PROGRAMS.get(name)
    if (dialect !== undefined) return { dialect, index }
    if (!isInContainer) return undefined
    index += 1
  }
  return undefined
}

const sqliteTargets = (words: readonly Word[], from: number): Target[] => {
  const positionals: Word[] = []
  for (let index = from + 1; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) continue
    if (SQLITE_OPTIONS_WITH_VALUE.has(word.value)) index += 1
    else if (!word.value.startsWith('-')) positionals.push(word)
  }
  // The first positional is the database file; each later one is a statement or a dot-command.
  return positionals.slice(1).filter(word => !word.value.startsWith('.')).map(word => ({ word, prefixLength: 0 }))
}

/** Every argument of the client that holds SQL: -c/--command for psql, -e/--execute for mysql, positionals for sqlite3. */
const sqlTargets = (dialect: Dialect, words: readonly Word[], from: number): Target[] => {
  if (dialect === 'sqlite') return sqliteTargets(words, from)
  const flag = FLAGS[dialect]
  const targets: Target[] = []
  for (let index = from + 1; index < words.length; index += 1) {
    const value = valueAt(words, index)
    const next = words[index + 1]
    const word = words[index]
    if (word === undefined) continue
    if (value === flag.long || flag.cluster.test(value)) {
      if (next !== undefined) targets.push({ word: next, prefixLength: 0 })
      index += 1
    } else if (value.startsWith(`${flag.long}=`)) {
      targets.push({ word, prefixLength: flag.long.length + 1 })
    } else if (value.startsWith(`-${flag.short}`) && value.length > 2) {
      targets.push({ word, prefixLength: 2 })
    }
  }
  return targets
}

/**
 * Where " LIMIT n" goes: just inside the closing quote, before trailing spaces and semicolons. Undefined unless the
 * argument is quoted, free of expansions, a SELECT that wants a cap, and its end can be located with certainty.
 */
const insertionPoint = (command: string, { word, prefixLength }: Target): number | undefined => {
  const last = word.segments.at(-1)
  if (word.isUnsafe || last === undefined || last.quote === 'none') return undefined
  const sql = word.value.slice(prefixLength)
  if (!isCappable(sql)) return undefined

  const closing = last.end - 1
  let at = closing
  while (at > last.start + 1 && /[\s;]/.test(command[at - 1] ?? '')) at -= 1
  const trailing = sql.length - sql.replace(/[\s;]+$/, '').length
  return at > last.start + 1 && closing - at === trailing ? at : undefined
}

export type Capped = { command: string; count: number }

/** The command with " LIMIT <limit>" added to each unbounded SELECT passed to psql, mysql or sqlite3; undefined when nothing changes. */
export const capQueries = (command: string, limit: number): Capped | undefined => {
  const parsed = parseCommand(command)
  if (parsed === undefined || parsed.hasHeredoc) return undefined

  const points: number[] = []
  for (const words of parsed.commands) {
    const program = findProgram(words)
    if (program === undefined) continue
    for (const target of sqlTargets(program.dialect, words, program.index)) {
      const at = insertionPoint(command, target)
      if (at !== undefined && !points.includes(at)) points.push(at)
    }
  }
  if (points.length === 0) return undefined

  // From the end, so earlier positions stay valid.
  const capped = points.sort((a, b) => b - a).reduce((text, at) => `${text.slice(0, at)} LIMIT ${limit}${text.slice(at)}`, command)
  return { command: capped, count: points.length }
}

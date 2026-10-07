import { embeddedShellScripts, simpleCommands } from './shared/shell'

export type Risk = {
  /** Names the case, for mods-hub's risk.blocked: `volume-prune`, `compose-down-volumes`, ... */
  rule: string
  /** The command, as typed. */
  command: string
  /** What it deletes. */
  lost: string
  /** What to do instead. */
  instead: string
}

const ENGINES = new Set(['docker', 'podman'])
const COMPOSE_BINARIES = new Set(['docker-compose', 'podman-compose'])
/** How deep scripts handed to a shell further along (`docker exec db sh -c "…"`) are opened up. */
const MAX_NESTING = 3
/** Options of the engine and of `compose` (before the subcommand) that take the next word as their value. */
const GLOBAL_VALUE_FLAGS = new Set([
  '--context', '-c', '--host', '-H', '--config', '--log-level', '-l', '-f', '--file', '-p', '--project-name',
  '--profile', '--env-file', '--project-directory', '--ansi', '--parallel', '--progress',
])
const SUBCOMMAND_VALUE_FLAGS = new Set(['--filter', '--format', '-t', '--timeout', '--rmi'])
const MAX_COMMAND_LENGTH = 80

type Flag = { name: string; /** How many positional words came before it. */ at: number }
type Parsed = { positional: string[]; flags: Flag[] }

/** Positional words and flags of an engine command line; `-af` counts as `-a` and `-f`. */
function parseArguments(words: readonly string[], isComposeBinary: boolean): Parsed {
  const positional = isComposeBinary ? ['compose'] : []
  const flags: Flag[] = []
  let valueFor: string | undefined
  for (const word of words) {
    if (valueFor !== undefined) {
      valueFor = undefined
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      positional.push(word)
      continue
    }
    const at = positional.length
    if (word.startsWith('--')) {
      const [name = word] = word.split('=', 1)
      flags.push({ name, at })
      const isGlobalPhase = at === 0 || (at === 1 && positional[0] === 'compose')
      const takesValue = (isGlobalPhase ? GLOBAL_VALUE_FLAGS : SUBCOMMAND_VALUE_FLAGS).has(name)
      if (takesValue && !word.includes('=')) valueFor = name
      continue
    }
    for (const letter of word.slice(1)) flags.push({ name: `-${letter}`, at })
    const last = `-${word.slice(-1)}`
    const isGlobalPhase = at === 0 || (at === 1 && positional[0] === 'compose')
    if ((isGlobalPhase ? GLOBAL_VALUE_FLAGS : SUBCOMMAND_VALUE_FLAGS).has(last)) valueFor = last
  }
  return { positional, flags }
}

const hasFlag = (flags: readonly Flag[], from: number, names: readonly string[]): boolean =>
  flags.some(flag => flag.at >= from && names.includes(flag.name))

const SHARED_VOLUMES = 'every volume no container uses right now, which includes the data of a stopped database container'

function risksOf({ positional, flags }: Parsed, command: string): Risk[] {
  const [first, second] = positional
  const risks: Risk[] = []
  const add = (rule: string, lost: string, instead: string) => risks.push({ rule, command, lost, instead })

  if (first === 'system' && second === 'prune') {
    const hasVolumes = hasFlag(flags, 2, ['--volumes'])
    const hasAll = hasFlag(flags, 2, ['-a', '--all'])
    if (hasVolumes) {
      add(
        'system-prune-volumes',
        `${SHARED_VOLUMES}${hasAll ? ', plus every unused image' : ''}`,
        'docker system df to see what is there, then docker volume ls and remove the volumes you mean by name',
      )
    } else if (hasAll) {
      add('system-prune-all', 'every image no container uses, which then has to be pulled or built again', 'docker image prune (dangling images only) or docker builder prune')
    }
  }
  if (first === 'volume' && second === 'prune') {
    add('volume-prune', SHARED_VOLUMES, 'docker volume ls, then docker volume rm <name> for the ones you mean')
  }
  if (first === 'volume' && (second === 'rm' || second === 'remove')) {
    const names = positional.slice(2).filter(name => !name.includes('$'))
    const lost =
      names.length === 0
        ? 'the volumes the command names, and all the data in them'
        : `the volume${names.length === 1 ? '' : 's'} ${names.join(' ')} and all the data in ${names.length === 1 ? 'it' : 'them'}`
    add('volume-rm', lost, 'back it up first: docker run --rm -v <name>:/data -v "$PWD":/backup alpine tar czf /backup/<name>.tgz -C /data .')
  }
  if (first === 'compose' && (second === 'down' || second === 'rm') && hasFlag(flags, 2, ['-v', '--volumes'])) {
    add(
      'compose-down-volumes',
      'the volumes of this compose project (anonymous ones, and the named ones for down), which usually hold the local database',
      second === 'down' ? 'docker compose down (keeps the volumes) or docker compose stop' : 'docker compose rm without -v',
    )
  }
  const isContainerRm = first === 'rm' || (first === 'container' && (second === 'rm' || second === 'remove'))
  if (isContainerRm && hasFlag(flags, first === 'rm' ? 1 : 2, ['-v', '--volumes'])) {
    add('container-rm-volumes', 'the anonymous volumes of the container; database images keep their data in one', 'docker rm without -v')
  }
  return risks
}

/**
 * Commands of the line that can delete volumes (or all unused images); reads text, runs nothing. The shared shell
 * reader peels wrappers (`sudo -u root`, `xargs -r`, `timeout 60`, `env`) and opens `bash -c`, `eval`, `$(…)` and
 * heredocs fed to a shell; scripts handed to a shell further along (`docker exec db sh -c "…"`) are opened here.
 */
export function findRisks(line: string, depth = 0): Risk[] {
  return simpleCommands(line).flatMap(({ argv: words, name: binary }) => {
    const nested = depth < MAX_NESTING ? embeddedShellScripts(words).flatMap(script => findRisks(script, depth + 1)) : []
    if (nested.length > 0) return nested
    const isComposeBinary = COMPOSE_BINARIES.has(binary)
    if (!isComposeBinary && !ENGINES.has(binary)) return []
    const shown = words.join(' ')
    const command = shown.length > MAX_COMMAND_LENGTH ? `${shown.slice(0, MAX_COMMAND_LENGTH)}...` : shown
    return risksOf(parseArguments(words.slice(1), isComposeBinary), command)
  })
}

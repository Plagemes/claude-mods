import { baseName, simpleCommands } from './shared/shell'

const PIP_NAME = /^pip\d*(?:\.\d+)*(?:\.exe)?$/
const PYTHON_NAME = /^(?:python|py)\d*(?:\.\d+)*(?:\.exe)?$/
/** `.venv/bin/pip`, `venv/Scripts/python.exe`, `~/envs/api/bin/pip`: the folder before bin/ is an environment. */
const ENVIRONMENT_EXECUTABLE = /(?:^|[\\/])[^\\/]*(?:venv|env)[^\\/]*[\\/](?:bin|Scripts)[\\/][^\\/]+$/i
/** Assignments that put the command in an environment, or make pip refuse to leave one. */
const ISOLATING_ASSIGNMENT = /^(?:VIRTUAL_ENV=.+|PIP_REQUIRE_VIRTUALENV=(?:1|true|yes|on))$/i
const ACTIVATE_SCRIPT = /[\\/]?activate(?:\.\w+)?$/
const CONDA_LIKE = new Set(['conda', 'mamba', 'micromamba'])
/** Flags that mean nothing gets installed, or that it goes to a folder of its own. */
const HARMLESS_FLAGS = /^(?:--dry-run|--help|-h|--require-virtualenv|--target(?:=.*)?|-t)$/

/** A `pip install` found in a command line, and whether it reaches the system Python even inside a virtualenv. */
export type GlobalInstall = {
  command: string
  /** `sudo pip install` (sudo runs the system pip, not the virtualenv's) or `pip install --user` (it writes to ~/.local). */
  isSystemWide: boolean
}

/** What follows `pip` (or `python -m pip`), or undefined when the words are some other command. */
function pipArguments(words: readonly string[]): string[] | undefined {
  const [first = '', ...rest] = words
  const executable = baseName(first)
  if (PIP_NAME.test(executable)) return rest
  const module = rest.indexOf('-m')
  if (PYTHON_NAME.test(executable) && module >= 0 && PIP_NAME.test(rest[module + 1] ?? '')) return rest.slice(module + 2)
  return undefined
}

/** `source .venv/bin/activate`, `. venv/bin/activate`, `conda activate api`, `workon api`, or `export VIRTUAL_ENV=...`. */
function activatesEnvironment(words: readonly string[]): boolean {
  const [first = '', second = '', third] = words
  if (first === 'source' || first === '.') return ACTIVATE_SCRIPT.test(second)
  if (CONDA_LIKE.has(baseName(first))) return second === 'activate' && third !== undefined && third !== 'base'
  if (first === 'workon') return second !== ''
  return first === 'export' && words.some(word => ISOLATING_ASSIGNMENT.test(word))
}

/**
 * The first `pip install` of the command line that would reach the system Python,
 * as the words were typed, or undefined when there is none. Reads text; runs nothing.
 * The shared shell reader peels wrappers and `NAME=value` words, treats here-document bodies as text, and opens
 * `bash -c`, `eval`, `$(…)` and heredocs fed to a shell; a nested script starts activated when the command that
 * runs it was, and an activation inside it stays inside it.
 */
export function findGlobalInstall(command: string): GlobalInstall | undefined {
  const activated = new Map<number, boolean>()
  /** Whether the latest script seen at each depth is activated so far: a script at depth d belongs to the one at d - 1. */
  const latest: number[] = []
  for (const { argv: words, wrappers, assignments, depth, script } of simpleCommands(command)) {
    if (!activated.has(script)) activated.set(script, depth > 0 && activated.get(latest[depth - 1] ?? -1) === true)
    latest[depth] = script
    if (activatesEnvironment(words)) {
      activated.set(script, true)
      continue
    }
    const args = pipArguments(words)
    if (args === undefined || !args.includes('install') || args.some(arg => HARMLESS_FLAGS.test(arg))) continue
    const isSudo = wrappers.includes('sudo')
    const isNamedEnvironment = ENVIRONMENT_EXECUTABLE.test(words[0] ?? '')
    const isSystemWide = (isSudo && !isNamedEnvironment) || args.includes('--user')
    const isIsolated =
      activated.get(script) === true || Object.entries(assignments).some(([name, value]) => ISOLATING_ASSIGNMENT.test(`${name}=${value}`)) || isNamedEnvironment
    if (isSystemWide || !isIsolated) return { command: [...(isSudo ? ['sudo'] : []), ...words].join(' '), isSystemWide }
  }
  return undefined
}

import { baseName, parseShell } from './shell'

const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'command', 'exec', 'env'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
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

type Words = { assignments: string[]; words: string[]; isSudo: boolean }

/** Separates the leading `NAME=value` words and wrappers (`sudo`, `env`) from the command itself. */
function splitPrefix(all: readonly string[]): Words {
  const assignments: string[] = []
  let index = 0
  let isAfterWrapper = false
  let isSudo = false
  for (; index < all.length; index += 1) {
    const word = all[index] as string
    if (ASSIGNMENT.test(word)) assignments.push(word)
    else if (WRAPPERS.has(baseName(word))) {
      isAfterWrapper = true
      isSudo ||= baseName(word) === 'sudo'
    } else if (!(isAfterWrapper && word.startsWith('-'))) break
  }
  return { assignments, words: all.slice(index), isSudo }
}

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
function activatesEnvironment({ words }: Words): boolean {
  const [first = '', second = '', third] = words
  if (first === 'source' || first === '.') return ACTIVATE_SCRIPT.test(second)
  if (CONDA_LIKE.has(baseName(first))) return second === 'activate' && third !== undefined && third !== 'base'
  if (first === 'workon') return second !== ''
  return first === 'export' && words.some(word => ISOLATING_ASSIGNMENT.test(word))
}

/**
 * The first `pip install` of the command line that would reach the system Python,
 * as the words were typed, or undefined when there is none. Reads text; runs nothing.
 */
export function findGlobalInstall(command: string): GlobalInstall | undefined {
  let isActivated = false
  for (const segment of parseShell(command)) {
    const prefix = splitPrefix(segment.words)
    if (activatesEnvironment(prefix)) {
      isActivated = true
      continue
    }
    const args = pipArguments(prefix.words)
    if (args === undefined || !args.includes('install') || args.some(arg => HARMLESS_FLAGS.test(arg))) continue
    const isNamedEnvironment = ENVIRONMENT_EXECUTABLE.test(prefix.words[0] ?? '')
    const isSystemWide = (prefix.isSudo && !isNamedEnvironment) || args.includes('--user')
    const isIsolated =
      isActivated || prefix.assignments.some(assignment => ISOLATING_ASSIGNMENT.test(assignment)) || isNamedEnvironment
    if (isSystemWide || !isIsolated) return { command: [...(prefix.isSudo ? ['sudo'] : []), ...prefix.words].join(' '), isSystemWide }
  }
  return undefined
}

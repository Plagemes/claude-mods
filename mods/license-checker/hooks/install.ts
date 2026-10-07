import { simpleCommands } from './shared/shell'
import type { ShellCommand } from './shared/shell'

export type Ecosystem = 'npm' | 'pypi'

/** One package an install command adds to the project. */
export type InstallRequest = { ecosystem: Ecosystem; name: string; version?: string; isDev: boolean }

/** A cheap test before parsing: does the command mention an installer at all? */
const INSTALLER_HINT = /\b(?:npm|pnpm|yarn|bun|pip3?|python3?|uv|poetry)\b/

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

/** The packages one simple command installs; the shared shell reader has peeled wrappers and assignments and opened `bash -c "…"`, `eval` and the like. */
const installsOf = ({ name, argv }: ShellCommand): InstallRequest[] => {
  const [, sub = '', third = '', ...rest] = argv
  const afterSub = argv.slice(2)

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

/** Every registry package `command` installs into a project (not globally), each once. */
export const installsIn = (command: string): InstallRequest[] => {
  if (!INSTALLER_HINT.test(command)) return []
  const seen = new Set<string>()
  return simpleCommands(command).flatMap(installsOf)
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

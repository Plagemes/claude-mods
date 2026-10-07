import type { ProcessRunResult } from 'claude-code'

import type { StoreInstall } from '../types'

export const CLAUDE = 'claude'
const CLAUDE_BINARY = /(^|[\\/])claude(\.exe)?$/i
const CLAUDE_FILE = /^claude(\.exe)?$/i

/** What one `claude plugin ... --json` run said. */
export type CliOutcome = {
  isOk: boolean
  message: string
  failureCode?: string
  updateOutcome?: string
  oldVersion?: string
  newVersion?: string
}

/**
 * The `claude` executable to run: the one this session runs as when the
 * engine says so (CLAUDE_CODE_EXECPATH names a claude binary), else `claude`
 * from PATH. A path naming another program (node, under an npm install) is
 * not used, since `<node> plugin ...` would not be the CLI.
 */
export const claudeBinary = (execPath: string | undefined): string =>
  execPath !== undefined && CLAUDE_BINARY.test(execPath.trim()) ? execPath.trim() : CLAUDE

export const isClaudeFile = (name: string): boolean => CLAUDE_FILE.test(name)

/**
 * Where the desktop app keeps the Claude Code it runs, as
 * `<root>/<version>/[<build>/]claude(.exe)`: under %APPDATA% on Windows, under
 * Application Support on macOS. The desktop app does not put `claude` on PATH
 * and does not hand CLAUDE_CODE_EXECPATH to plugins, so this is how the store
 * finds the CLI there.
 */
export function desktopRoots(appData: string | undefined, home: string | undefined): string[] {
  return [
    appData === undefined || appData === '' ? undefined : `${appData}\\Claude\\claude-code`,
    home === undefined || home === '' ? undefined : `${home}/Library/Application Support/Claude/claude-code`,
  ].filter((root): root is string => root !== undefined)
}

/** Joins path parts with the separator `root` uses. */
export const joinPath = (root: string, ...parts: string[]): string =>
  [root, ...parts].join(root.includes('\\') ? '\\' : '/')

/** Version folders to try: the engine's own first, then the rest newest first. */
export function versionOrder(names: readonly string[], engine: string, compare: (a: string, b: string) => number): string[] {
  const rest = names.filter(name => name !== engine).sort((a, b) => compare(b, a))
  return names.includes(engine) ? [engine, ...rest] : rest
}

export const pluginId = (name: string, marketplace: string): string => `${name}@${marketplace}`

/** The argument vectors of every CLI call the store makes; never a shell. */
export const argv = {
  list: (bin: string): string[] => [bin, 'plugin', 'list', '--json'],
  marketplaces: (bin: string): string[] => [bin, 'plugin', 'marketplace', 'list', '--json'],
  addMarketplace: (bin: string, repository: string): string[] =>
    [bin, 'plugin', 'marketplace', 'add', repository, '--json'],
  refreshMarketplace: (bin: string, marketplace: string): string[] =>
    [bin, 'plugin', 'marketplace', 'update', marketplace, '--json'],
  install: (bin: string, name: string, marketplace: string): string[] =>
    [bin, 'plugin', 'install', pluginId(name, marketplace), '--scope', 'user', '--json'],
  update: (bin: string, name: string, marketplace: string, scope: string): string[] =>
    [bin, 'plugin', 'update', pluginId(name, marketplace), '--scope', scope, '--json'],
  uninstall: (bin: string, name: string, marketplace: string, scope: string): string[] =>
    [bin, 'plugin', 'uninstall', pluginId(name, marketplace), '--scope', scope, '--json'],
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const lastLine = (text: string): string =>
  text.trim().split('\n').map(line => line.replace(/^[×✖✗]\s*/, '').trim()).filter(line => line !== '').pop() ?? ''

/** Reads a `--json` run: its last JSON line when it printed one, else its exit code and stderr. */
export function parseOutcome(result: ProcessRunResult): CliOutcome {
  const lines = result.stdout.trim().split('\n').reverse()
  for (const line of lines) {
    let record: Record<string, unknown> | undefined
    try {
      record = asRecord(JSON.parse(line))
    } catch {
      continue
    }
    if (record === undefined || typeof record.outcome !== 'string') {
      continue
    }
    const outcome: CliOutcome = {
      isOk: record.outcome === 'ok' && result.exitCode === 0,
      message: asText(record.message) ?? lastLine(result.stderr),
    }
    const failureCode = asText(record.failureCode)
    const updateOutcome = asText(record.updateOutcome)
    const oldVersion = asText(record.oldVersion)
    const newVersion = asText(record.newVersion)

    return {
      ...outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(updateOutcome === undefined ? {} : { updateOutcome }),
      ...(oldVersion === undefined ? {} : { oldVersion }),
      ...(newVersion === undefined ? {} : { newVersion }),
    }
  }

  return {
    isOk: result.exitCode === 0,
    message: lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.exitCode}`,
  }
}

/** The mods of `marketplace` that `claude plugin list --json` reports, by name. */
export function parseInstalled(stdout: string, marketplace: string): Record<string, StoreInstall> {
  const list: unknown = JSON.parse(stdout)
  if (!Array.isArray(list)) {
    throw new Error('claude plugin list printed no list')
  }
  const mods: Record<string, StoreInstall> = {}
  for (const entry of list) {
    const record = asRecord(entry)
    const id = asText(record?.id) ?? ''
    const at = id.lastIndexOf('@')
    const name = id.slice(0, at)
    if (record === undefined || at <= 0 || id.slice(at + 1) !== marketplace || mods[name] !== undefined) {
      continue
    }
    mods[name] = {
      version: asText(record.version) ?? '',
      scope: asText(record.scope) ?? 'user',
      isEnabled: record.enabled !== false,
    }
  }

  return mods
}

/** The names of the marketplaces `claude plugin marketplace list --json` reports. */
export function parseMarketplaceNames(stdout: string): string[] {
  const list: unknown = JSON.parse(stdout)
  return Array.isArray(list)
    ? list.map(entry => asText(asRecord(entry)?.name)).filter((name): name is string => name !== undefined)
    : []
}

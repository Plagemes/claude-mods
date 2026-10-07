import { baseName, type ShellCommand } from './shell'

export type GitAdd = {
  /** `-A`, `--all`, `.` or `*`: stage everything. */
  isBroad: boolean
  /** Pathspecs named one by one. */
  paths: string[]
  /** `.` restricts the add to the working directory's subtree. */
  isCurrentDirectoryOnly: boolean
}

export type StatusEntry = { status: string; path: string }

export type Junk = { reason: string; ignoreLine: string }

const SKIPPED_FLAGS = new Set(['-f', '--force', '-n', '--dry-run', '-p', '--patch', '-i', '--interactive', '-e', '--edit', '-u', '--update'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/

// Junk that is junk wherever it is named.
const STRONG: ReadonlyArray<readonly [RegExp, Junk]> = [
  [/(?:^|\/)node_modules(?:\/|$)/, { reason: 'node_modules', ignoreLine: 'node_modules/' }],
  [/(?:^|\/)\.DS_Store$/, { reason: 'macOS metadata', ignoreLine: '.DS_Store' }],
  [/(?:^|\/)(?:Thumbs\.db|desktop\.ini)$/i, { reason: 'Windows metadata', ignoreLine: 'Thumbs.db' }],
  [/\.log$/, { reason: 'log files', ignoreLine: '*.log' }],
]
// Build output: only suspicious when someone said "add everything", since some repos track a build/ folder.
const WEAK: ReadonlyArray<readonly [RegExp, Junk]> = [
  [/(?:^|\/)dist(?:\/|$)/, { reason: 'build output', ignoreLine: 'dist/' }],
  [/(?:^|\/)build(?:\/|$)/, { reason: 'build output', ignoreLine: 'build/' }],
  [/(?:^|\/)\.(?:next|nuxt|cache|pytest_cache)(?:\/|$)/, { reason: 'framework cache', ignoreLine: '.next/' }],
  [/(?:^|\/)(?:__pycache__|\.venv|venv|coverage)(?:\/|$)/, { reason: 'generated folder', ignoreLine: '__pycache__/' }],
  [/\.pyc$/, { reason: 'Python bytecode', ignoreLine: '*.pyc' }],
]

/** The `git add` of a command, or undefined when this is not one that needs a look. */
export function parseGitAdd(commands: readonly ShellCommand[]): GitAdd | undefined {
  for (const { words } of commands) {
    const gitIndex = words.findIndex(word => baseName(word) === 'git')
    if (gitIndex === -1) continue
    let i = gitIndex + 1
    while (i < words.length && (words[i] as string).startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(words[i] as string) ? 2 : 1
    if (words[i] !== 'add') continue

    const args = words.slice(i + 1)
    const flags = args.filter(arg => arg.startsWith('-') && arg !== '--')
    if (flags.some(flag => SKIPPED_FLAGS.has(flag))) return undefined
    const isBroadFlag = flags.some(flag => flag === '--all' || (!flag.startsWith('--') && flag.includes('A')))
    const paths = args.filter(arg => !arg.startsWith('-') || arg === '-')
    const everything = paths.filter(path => ['.', './', '*', ':/', ':/*'].includes(path))
    return {
      isBroad: isBroadFlag || everything.length > 0,
      paths: paths.filter(path => !everything.includes(path)),
      isCurrentDirectoryOnly: !isBroadFlag && everything.every(path => path === '.' || path === './'),
    }
  }
  return undefined
}

/** `git status --porcelain=v1 -z` into entries; the cut-off last entry of a truncated output is dropped. */
export function parseStatus(stdout: string, isTruncated: boolean): StatusEntry[] {
  const fields = stdout.split('\0')
  if (isTruncated) fields.pop()
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    entries.push({ status, path: field.slice(3) })
    if (/[RC]/.test(status)) i += 1
  }
  return entries
}

export function junkFor(path: string, includeWeak: boolean): Junk | undefined {
  if (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(path) && !ENV_TEMPLATE.test(path)) return { reason: 'environment file', ignoreLine: '.env' }
  const rules = includeWeak ? [...STRONG, ...WEAK] : STRONG
  return rules.find(([pattern]) => pattern.test(path))?.[1]
}

/** `*` and `?` globs, matched against a path and each of its parent folders. */
export function matchesGlob(path: string, glob: string): boolean {
  const source = glob
    .replace(/\/$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const pattern = new RegExp(`(?:^|/)${source}$`)
  const parts = path.replace(/\/$/, '').split('/')
  return parts.some((_, index) => pattern.test(parts.slice(0, index + 1).join('/')))
}

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

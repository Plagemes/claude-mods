import type { EngineInterface, Register } from 'claude-code'

type Settings = { directories: readonly RegExp[]; allowUncommitted: boolean }

const DEFAULT_DIRECTORIES = 'migrations,db/migrate,prisma/migrations,alembic/versions,supabase/migrations'
const GIT_TIMEOUT_MS = 5000
const ADVICE = 'Editing it would rewrite history that may already be applied. Leave it as it is and create a new migration with the change instead.'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// "db/migrate" matches /repo/db/migrate/001.rb and /repo/api/db/migrate/001.rb, but not /repo/mydb/migrate/001.rb.
const directoryPatterns = (list: unknown): RegExp[] =>
  (typeof list === 'string' && list.trim() !== '' ? list : DEFAULT_DIRECTORIES)
    .split(',')
    .map(directory => directory.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
    .filter(directory => directory !== '')
    .map(directory => new RegExp(`(?:^|/)${escapeRegExp(directory)}/`))

const isMigrationPath = (path: string, directories: readonly RegExp[]): boolean => {
  const normalized = path.replace(/\\/g, '/')
  return directories.some(pattern => pattern.test(normalized))
}

const shortName = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    const root = (await $.session.root()).replace(/[\\/]+$/, '')
    return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path
  } catch {
    return path
  }
}

const isTracked = async ($: EngineInterface, path: string): Promise<boolean> => {
  try {
    const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
    const { exitCode } = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', path], { cwd: folder, timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0
  } catch {
    return false
  }
}

// Why the file may not be changed, or undefined when it may (a migration that does not exist yet is always fine).
const protectionReason = async ($: EngineInterface, path: string, settings: Settings): Promise<string | undefined> => {
  if (!(await $.fs.exists(path))) return undefined
  const stat = await $.fs.stat(path, { resolve: true })
  const realPath = stat.realPath ?? path
  // A symbolic link into a migration directory is a migration too.
  if (!isMigrationPath(path, settings.directories) && !isMigrationPath(realPath, settings.directories)) return undefined

  const name = await shortName($, path)
  if (await isTracked($, realPath)) return `${name} is an existing migration (tracked in git). ${ADVICE}`
  const startedAt = (await $.session.usage()).startedAt
  if (!settings.allowUncommitted && stat.mtimeMs < startedAt) {
    return `${name} is an existing migration (it was there before this session started). ${ADVICE}`
  }
  return undefined
}

export const register: Register = (on, options) => {
  const settings: Settings = { directories: directoryPatterns(options.directories), allowUncommitted: options.allowUncommitted === true }

  // MultiEdit is not in every build's tool table, so the tools are matched by name.
  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write)$/ }, async ($, e, next) => {
    if (!('file_path' in e) || typeof e.file_path !== 'string') return next(e)
    const reason = await protectionReason($, e.file_path, settings)
    return reason === undefined ? next(e) : { deny: `migration-guard: ${reason}` }
  }).catch(($, e, next) => {
    // The check failed: refuse only what is spelled like a migration, and let every other file through.
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (next.called || !isMigrationPath(path, settings.directories)) return next(e)
    return { deny: `migration-guard: could not verify ${path}, so it was left untouched to be safe. ${ADVICE}` }
  })
}

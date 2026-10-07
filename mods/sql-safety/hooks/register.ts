import type { EngineInterface, Register } from 'claude-code'

import { ADVICE, findSql, introduced, isScanned } from './sql'
import type { Finding } from './sql'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const SKIPPED_PATH = /(^|[\\/])(node_modules|vendor|dist|build|\.git)[\\/]|\.min\./
const MAX_LISTED = 4
const MAX_SHOWN = 90
const DEFAULT_MIGRATIONS = 'migrations,migrate,db/migrate,prisma/migrations,alembic/versions,supabase/migrations'

type Input = Readonly<Record<string, unknown>>
type Settings = { isBlocking: boolean; migrations: readonly RegExp[] }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "db/migrate" matches /repo/db/migrate/001.rb and /repo/api/db/migrate/001.rb, but not /repo/mydb/migrate/001.rb. */
function migrationPatterns(list: unknown): RegExp[] {
  return (typeof list === 'string' && list.trim() !== '' ? list : DEFAULT_MIGRATIONS)
    .split(',')
    .map(directory => directory.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/'))
    .filter(directory => directory !== '')
    .map(directory => new RegExp(`(?:^|/)${escapeRegExp(directory)}/`))
}

const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  return name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : ''
}

/** The file as it will be once the tool has run, or undefined when the input is not a file change. */
function resultingText(before: string, input: Input): string | undefined {
  if (typeof input.content === 'string') return input.content
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  let text = before
  for (const edit of edits) {
    const { old_string, new_string, replace_all } = edit as Record<string, unknown>
    if (typeof old_string !== 'string' || typeof new_string !== 'string' || old_string === '') continue
    text = replace_all === true ? text.replaceAll(old_string, () => new_string) : text.replace(old_string, () => new_string)
  }
  return text
}

const shortLine = (statement: string): string => (statement.length > MAX_SHOWN ? `${statement.slice(0, MAX_SHOWN)}...` : statement)

function describe(findings: readonly Finding[]): string {
  const lines = findings.slice(0, MAX_LISTED).map(({ rule, line, statement }) => `  line ${line}: ${ADVICE[rule]}: ${shortLine(statement)}`)
  const more = findings.length > MAX_LISTED ? [`  (+${findings.length - MAX_LISTED} more)`] : []
  return [...lines, ...more].join('\n')
}

/** What this change adds: dangerous SQL in the file's text after the change that was not in it before. */
async function addedRisks($: EngineInterface, path: string, input: Input, settings: Settings): Promise<Finding[]> {
  const extension = extensionOf(path)
  if (!isScanned(extension) || SKIPPED_PATH.test(path)) return []
  const before = await $.fs.read(path).catch(() => '')
  const after = resultingText(before, input)
  if (after === undefined) return []
  const isMigration = settings.migrations.some(pattern => pattern.test(path.replace(/\\/g, '/')))
  return introduced(findSql(before, extension), findSql(after, extension)).filter(finding => !(isMigration && finding.rule === 'drop'))
}

export const register: Register = (on, options) => {
  const settings: Settings = { isBlocking: options.mode === 'block', migrations: migrationPatterns(options.migrationDirs) }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Input = e
    const path = input.file_path
    if (typeof path !== 'string' || input._host !== undefined) return next(e)

    const risks = await addedRisks($, path, input, settings)
    if (risks.length === 0) return next(e)

    if (settings.isBlocking) {
      return {
        deny:
          `sql-safety: blocked, this change adds SQL that can destroy data to ${path}.\n${describe(risks)}\n` +
          `Add a WHERE clause, or run destructive statements from a migration or the database console instead.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    $.ui.toast(`${risks.length} risky SQL statement${risks.length === 1 ? '' : 's'} added to ${path.split(/[\\/]/).at(-1)}`)
    const note =
      `sql-safety: this edit added SQL that can destroy data to ${path}.\n${describe(risks)}\n` +
      `Check that each is intended: add a WHERE clause, or move DROP and TRUNCATE to a migration.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}

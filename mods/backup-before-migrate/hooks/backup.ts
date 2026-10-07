import { conninfo, mysqlConnection, passwordEnv } from './db'
import type { DbTarget, ServerTarget } from './db'

/** One backup as `.claude/db-backups/index.json` keeps it, newest last. */
export type Entry = {
  file: string
  createdAt: number
  kind: DbTarget['kind']
  label: string
  bytes: number
  migration: string
  command: string
  restore: string
}

/** How to dump a database: the client's argv and environment, the file it writes, how to undo with it. */
export type DumpPlan = { argv: string[]; env: Record<string, string>; file: string; restore: string }

type Migration = { label: string; pattern: RegExp }

// `[^|;&]*` keeps a subcommand inside the same simple command as its tool; `(?![:\w])` stops at `migrate:status`.
const MIGRATIONS: readonly Migration[] = [
  { label: 'prisma migrate', pattern: /\bprisma\s+(?:migrate\s+(?:dev|deploy|reset)|db\s+push)\b(?![^|;&]*--create-only)/ },
  { label: 'rails db:migrate', pattern: /\b(?:rails|rake)\s+db:(?:migrate(?::(?:redo|up|down|reset))?|rollback|schema:load|reset|setup)(?![:\w])/ },
  { label: 'alembic upgrade', pattern: /\balembic\b[^|;&]*\s(?:upgrade|downgrade)\b(?![^|;&]*\s--sql\b)/ },
  { label: 'django migrate', pattern: /\b(?:manage\.py|django-admin)\s+migrate\b(?![^|;&]*\s--(?:plan|check)\b)/ },
  { label: 'knex migrate', pattern: /\bknex\b[^|;&]*\smigrate:(?:latest|up|down|rollback)(?![:\w])/ },
  { label: 'artisan migrate', pattern: /\bartisan\s+migrate(?::(?:fresh|refresh|reset|rollback))?(?![:\w])(?![^|;&]*\s--pretend\b)/ },
  { label: 'goose', pattern: /\bgoose\b[^|;&]*\s(?:up|up-by-one|up-to|down|down-to|redo|reset)(?![-\w])/ },
  { label: 'flyway migrate', pattern: /\bflyway\b[^|;&]*\s(?:migrate|clean|undo|repair)\b/ },
  { label: 'sequelize db:migrate', pattern: /\bsequelize(?:-cli)?\s+db:migrate(?::undo(?::all)?)?(?![:\w])/ },
  { label: 'typeorm migration:run', pattern: /\btypeorm(?:-ts-node-\w+)?\b[^|;&]*\smigration:(?:run|revert)\b/ },
  { label: 'drizzle-kit', pattern: /\bdrizzle-kit\s+(?:migrate|push)\b/ },
  { label: 'diesel migration', pattern: /\bdiesel\s+migration\s+(?:run|redo|revert)\b/ },
  { label: 'sqlx migrate', pattern: /\bsqlx\s+migrate\s+(?:run|revert)\b/ },
  { label: 'dbmate', pattern: /\bdbmate\b[^|;&]*\s(?:up|migrate|rollback|down)\b/ },
]

/** The explicit opt-out the person (or Claude, with their consent) writes in front of a migration. */
export const SKIP_MARK = /(?:^|[\s;&|])SKIP_DB_BACKUP=(?:1|true|yes)\b/

/**
 * The text a command matcher reads: quoted text blanked, so `git commit -m "fly deploy"` runs
 * nothing, except where a shell runs the quoted text (`bash -c "…"`, `sh -lc '…'`, `eval`, `ssh host "…"`).
 */
const matchText = (command: string): string =>
  /(?:^|\s)(?:-c|eval|ssh)\s|\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c[a-zA-Z]*\s/.test(command) ? command.replace(/["']/g, ' ') : command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, quoted => `"${' '.repeat(quoted.length - 2)}"`)

export const migrationKind = (command: string, extra: RegExp | undefined): string | undefined => {
  const code = matchText(command)
  return MIGRATIONS.find(migration => migration.pattern.test(code))?.label ?? (extra?.test(command) === true ? 'custom migration' : undefined)
}

/** A user pattern, or undefined when it is empty or does not compile. */
export const compileExtra = (source: unknown): RegExp | undefined => {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

/** The `DATABASE_URL=…` a command sets for itself (`DATABASE_URL=postgres://… npx prisma migrate dev`), unquoted. */
export const inlineDatabaseUrl = (command: string): string | undefined => {
  const match = /(?:^|[\s;&|(])(?:export\s+)?DATABASE_URL=("[^"]*"|'[^']*'|[^\s;&|]+)/.exec(command)
  return match?.[1]?.replace(/^(["'])([\s\S]*)\1$/, '$2')
}

/** The folder a leading `cd <dir> &&` moves the migration into, if any. */
export const leadingDirectory = (command: string): string | undefined => {
  const match = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/.exec(command)
  return match?.[1]?.replace(/^["']|["']$/g, '')
}

/** `2026-10-07T15-04-05`: sortable, and safe in a file name everywhere. */
export const stampOf = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'db'

/** A postgres URL without the password, for a restore command a person runs. */
const postgresUrl = (target: ServerTarget): string => {
  const user = target.user === null ? '' : `${encodeURIComponent(target.user)}@`
  const host = target.socket === null ? target.host : ''
  const port = target.port === null || target.socket !== null ? '' : `:${target.port}`
  const socket = target.socket === null ? '' : `?host=${encodeURIComponent(target.socket)}`
  return `postgresql://${user}${host}${port}/${encodeURIComponent(target.database)}${socket}`
}

/**
 * How to back up `target` into `dir`: pg_dump (plain SQL that drops and
 * recreates what it holds, gzipped when `compress`), mysqldump, or SQLite's
 * online `.backup`. Undefined when the path cannot be passed safely.
 */
export const dumpPlan = (target: DbTarget, dir: string, stamp: string, compress: boolean): DumpPlan | undefined => {
  if (target.kind === 'sqlite') {
    const base = target.path.split(/[\\/]/).pop() ?? 'db'
    const file = `${dir}/${stamp}-${safeName(base.replace(/\.[^.]+$/, ''))}.sqlite`
    if (file.includes("'") || target.path.includes("'")) return undefined
    return {
      argv: ['sqlite3', target.path, `.backup '${file}'`],
      env: {},
      file,
      restore: `sqlite3 ${shellQuote(target.path)} ${shellQuote(`.restore '${file}'`)}`,
    }
  }
  if (target.kind === 'postgres') {
    const file = `${dir}/${stamp}-${safeName(target.database)}.sql${compress ? '.gz' : ''}`
    const psql = `psql -X -v ON_ERROR_STOP=1 ${shellQuote(postgresUrl(target))}`
    return {
      argv: [
        'pg_dump', '--no-owner', '--no-privileges', '--clean', '--if-exists', '--format=plain',
        ...(compress ? ['--compress=6'] : []), `--file=${file}`, `--dbname=${conninfo(target)}`,
      ],
      env: passwordEnv(target),
      file,
      restore: compress ? `gunzip -c ${shellQuote(file)} | ${psql}` : `${psql} -f ${shellQuote(file)}`,
    }
  }
  const file = `${dir}/${stamp}-${safeName(target.database)}.sql`
  const connection = mysqlConnection(target).filter(option => option !== '--no-defaults')
  return {
    argv: [
      'mysqldump', ...mysqlConnection(target), '--single-transaction', '--routines', '--triggers', '--add-drop-table',
      `--result-file=${file}`, target.database,
    ],
    env: passwordEnv(target),
    file,
    restore: `mysql ${connection.map(shellQuote).join(' ')} -p ${shellQuote(target.database)} < ${shellQuote(file)}`,
  }
}

/** Entries of the index file; anything unreadable is no entry. */
export const parseIndex = (text: string | undefined): Entry[] => {
  if (text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    const list = typeof parsed === 'object' && parsed !== null && 'backups' in parsed ? parsed.backups : []
    return Array.isArray(list)
      ? list.filter(
          (entry): entry is Entry =>
            typeof entry === 'object' && entry !== null && typeof entry.file === 'string' && typeof entry.restore === 'string' && typeof entry.createdAt === 'number',
        )
      : []
  } catch {
    return []
  }
}

/** The entries to keep and the ones past `keep` (oldest first) whose files go. */
export const rotate = (entries: readonly Entry[], keep: number): { kept: Entry[]; dropped: Entry[] } => {
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt)
  const cut = Math.max(0, sorted.length - keep)
  return { kept: sorted.slice(cut), dropped: sorted.slice(0, cut) }
}

export const sizeText = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const whenText = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** What restoring overwrites, said before the person runs it. */
export const RESTORE_NOTE: Record<DbTarget['kind'], string> = {
  postgres: 'It drops and recreates every object in the dump, so rows written since are lost; tables created after the backup stay. psql asks for the password.',
  mysql: 'It drops and recreates every table in the dump, so rows written since are lost; tables created after the backup stay. mysql asks for the password.',
  sqlite: 'It overwrites the whole database file with the backup. Stop the app first.',
}

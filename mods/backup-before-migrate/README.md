# backup-before-migrate
> Dumps your local database before every migration so a bad one is one command away from undo.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
When Claude runs a migration (`prisma migrate dev|deploy|reset`, `prisma db push`, `rails db:migrate`,
`alembic upgrade`, `manage.py migrate`, `knex migrate:latest`, `artisan migrate`, `goose up`, `flyway migrate`,
`sequelize db:migrate`, `typeorm migration:run`, `drizzle-kit migrate|push`, `diesel`, `sqlx`, `dbmate`), it first
dumps your **local** database into `.claude/db-backups/` with `pg_dump`, `mysqldump` or SQLite's `.backup`, then
lets the migration run. Claude is told where the backup is, and `/db-restore` prints the exact command to undo.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install backup-before-migrate@claude-mods
```

## Usage
- Before each migration a toast says `💾 Backed up postgres · app @ localhost:5432 (1.2 MB) before prisma migrate`.
- `/db-backups` lists the backups, newest first, with database, size and the command they preceded.
- `/db-restore [n]` prints the command that restores backup `n` (1, the newest, by default), for example
  `gunzip -c .claude/db-backups/2026-10-07T15-04-05-app.sql.gz | psql -X -v ON_ERROR_STOP=1 postgresql://dev@localhost:5432/app`.
  It never runs it for you.
- If the dump fails (database down, wrong password), the migration is blocked with the reason. To migrate anyway,
  prefix the command with `SKIP_DB_BACKUP=1`. When `pg_dump`/`mysqldump`/`sqlite3` is not installed, or the database
  is not local, the migration runs without a backup and a toast says why.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `keep` | number | `10` | Backups kept in `.claude/db-backups`; older ones are deleted. |
| `compress` | boolean | `true` | Gzip PostgreSQL dumps (`.sql.gz`). MySQL dumps are plain `.sql`, SQLite backups a `.sqlite` copy. |
| `requireBackup` | boolean | `false` | Block every migration that could not be backed up; `SKIP_DB_BACKUP=1` is then ignored. |
| `extraPattern` | string | *(empty)* | Regex for more migration commands, e.g. `make migrate\|./bin/migrate`. |

## How it works
- A `tool.call` guard on `Bash` spots migrations (quoted text such as a commit message is ignored), finds the
  database from `DATABASE_URL` (set in the command itself, the environment, `.env.local`, `.env.development(.local)`, `.env`, `prisma/.env`, or the
  folder of a leading `cd dir &&`) or a framework SQLite file, and dumps it before calling the migration. If the
  backup step itself crashes, the migration is denied.
- Local only, fail closed: only `localhost`, `127.0.0.1`, `::1`, Unix sockets and SQLite files are ever dumped,
  and a `PGHOSTADDR`/`PGSERVICE`/remote `PGHOST` in the environment counts as remote. Passwords go through
  `PGPASSWORD`/`MYSQL_PWD`, never the command line.
- Dumps are `pg_dump --clean --if-exists --no-owner` (a restore drops and recreates what it holds; tables created
  later stay), `mysqldump --single-transaction --routines --triggers`, and `sqlite3 .backup`. The folder gets a
  `.gitignore` so dumps are never committed. Limits: a database named only in framework config (Django
  `settings.py`, Rails `database.yml`) without `DATABASE_URL` is not found, except for the default SQLite files.
- A `DATABASE_URL` the command sets for itself is read with the shell lexer every Claude Mod shares (`shared/shell.ts`), so `env DATABASE_URL=… prisma migrate` counts too.
- With [mods-hub](../mods-hub) installed, each backup is published as `x.backup-before-migrate.saved` (file, database, size, migration) for every session, and the toasts become hub notices: a backup at `info`, a migration that runs without one at `warning`, so it reaches your channels while you are away. Without the hub nothing changes.

# schema-pane
> A pane of your local database's tables and columns, ready to hand to Claude as context.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
`/schema` reads the tables, columns, types, primary and foreign keys and indexes of your **local** development
database (PostgreSQL, MySQL/MariaDB or SQLite) and shows them in a pane you can filter and expand. One button puts
a compact version of the schema in your prompt; a toggle keeps it in Claude's context so it writes queries, models
and migrations with the real table and column names.

## Install
```
/plugin install schema-pane --marketplace plagemes/claude-mods
```

## Usage
- `/schema` opens the pane; `/schema user` opens it filtered to tables whose name contains `user`.
- Press a table (`▸ users  3 cols · 1 idx`) to expand it: each column with its type, `PK`, `not null`, `unique`,
  `→ orgs.id` for foreign keys and its default, then the table's indexes.
- **Send to Claude** (`s`) inserts the shown tables into your prompt as compact text, for example
  `users(id uuid PK default gen_random_uuid(), email varchar(255) NOT NULL, org_id integer → orgs.id)`.
- **Inject in context** (`i`) adds the shown tables to Claude's system prompt for the rest of the session, capped
  at the configured budget. **Refresh** (`r`) rereads; the pane also refreshes itself after a migration command.

The connection comes from `DATABASE_URL` in the environment, then `.env.local`, `.env.development(.local)`, `.env`
or `prisma/.env`. With none set it looks for `prisma/dev.db`, `db/development.sqlite3`, `db.sqlite3` and Laravel's
`database/database.sqlite`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxContextChars` | number | `6000` | Most characters of schema injected into Claude's context while *Inject in context* is on. |

## How it works
- Local only, fail closed: the URL must name `localhost`, `127.0.0.1`, `::1`, a Unix socket or a SQLite file;
  any other host, a multi-host URL, a `service=`/`hostaddr=` redirect or a `PGHOSTADDR`/`PGSERVICE`/remote
  `PGHOST` in the environment is refused before any client runs.
- It runs the database's own CLI (`psql`, `mysql`, `sqlite3`) without a shell, in a read-only session
  (`default_transaction_read_only`, `SET SESSION TRANSACTION READ ONLY`, `sqlite3 -readonly`), with the password
  passed through `PGPASSWORD`/`MYSQL_PWD` rather than the command line, and queries `information_schema`
  (PostgreSQL, MySQL) or `sqlite_master` with `pragma_*` (SQLite).
- Injection is a `session` section added at `prompt.compose`. Limits: only base tables are listed (no views,
  functions or triggers), MySQL shows the URL's database only, and the client must be installed on your machine.

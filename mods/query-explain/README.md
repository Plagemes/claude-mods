# query-explain
> /explain-query runs EXPLAIN on your local database and explains the plan in plain words.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
`/explain-query <sql>` runs `EXPLAIN` for the query on your **local** PostgreSQL, MySQL/MariaDB or SQLite
database, flags what stands out (full scans of big tables, sorts spilling to disk, filters throwing rows away,
stale estimates) and asks Claude to explain the plan: what the database does, where the time goes, and the exact
`CREATE INDEX` or rewrite that would help. It reads the existing indexes and table sizes first, so it never
suggests an index you already have.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install query-explain@claude-mods
```

## Usage
```
/explain-query select u.email from users u where u.role = 'admin' order by u.created_at desc
```
With no argument it explains the query you selected in the transcript. The **Query plan** pane shows:
- the mode and database (`EXPLAIN · postgres · app @ localhost:5432`) and the query;
- **At a glance**: `⚠ Sequential scan on users (~5,000 rows in the table)`;
- the raw **Plan** and, a few seconds later, the **Explanation** (In short / Bottlenecks / Suggestions);
- **Ask Claude to optimise** (`a`) puts a ready prompt with the query and plan in your prompt box;
  **Copy plan** (`c`), **Re-run** (`r`).

Claude also gets the plan as a note after the command, so you can just ask "how do I fix that?".

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `analyze` | boolean | `false` | Use `EXPLAIN ANALYZE` (PostgreSQL, MySQL 8.0.18+) for queries that only read: the query really runs, in a read-only session capped at 60 s, and the plan shows measured times. |
| `model` | string | `sonnet` | Model that writes the explanation: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |

## How it works
- The connection comes from `DATABASE_URL` (environment, then `.env.local`, `.env.development(.local)`, `.env`,
  `prisma/.env`) or a framework SQLite file. Local only, fail closed: any host other than `localhost`,
  `127.0.0.1`, `::1`, a Unix socket or a SQLite file is refused before a client runs, as is a
  `PGHOSTADDR`/`PGSERVICE`/remote `PGHOST` in the environment.
- It runs `psql`, `mysql` or `sqlite3` without a shell, in a read-only session (`default_transaction_read_only`,
  `SET SESSION TRANSACTION READ ONLY`, `sqlite3 -readonly`), password via `PGPASSWORD`/`MYSQL_PWD`. Exactly one
  statement is accepted: any `;` inside the query is refused, and so are backslashes for MySQL, whose client
  treats them as commands. Older MySQL and MariaDB fall back to `EXPLAIN FORMAT=JSON`.
- The explanation is one `$.model.complete` call; plain `EXPLAIN` never runs your query. SQLite has no
  `ANALYZE` mode here, and the client must be installed on your machine.

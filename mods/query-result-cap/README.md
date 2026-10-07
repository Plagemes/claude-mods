# query-result-cap
> Adds a LIMIT to ad-hoc SELECTs Claude runs in psql, mysql or sqlite so results don't flood the context.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
When Claude runs `psql -c "SELECT * FROM users"`, `mysql -e "..."` or `sqlite3 app.db "..."` and the SELECT has no row limit, query-result-cap appends ` LIMIT 50` before the command runs, so a 2-million-row table cannot flood the context window. Claude is told what was changed and how to get more rows if it really needs them. Anything it is not sure about is left exactly as it was.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install query-result-cap@claude-mods
```

## Usage
Nothing to run. Claude writes `psql -d app -c "SELECT id, email FROM users WHERE active;"`, the shell receives `... WHERE active LIMIT 50;` and Claude reads a note: `query-result-cap: the SELECT in this command had no row limit, so " LIMIT 50" was added (the command shown is the one that ran). ...`.

Left alone: queries that already have `LIMIT`, `TOP`, `OFFSET` or `FETCH FIRST`; aggregate-only queries (`SELECT count(*) FROM t`) and queries with no `FROM` (`SELECT now()`); anything that is not a plain SELECT (INSERT, UPDATE, `EXPLAIN`, `\d`, `SELECT ... INTO`, `FOR UPDATE`, a `WITH` that modifies data); several statements in one string; SQL fed through a pipe, heredoc or `-f`; SQL built with `$(...)`, backticks or an unquoted word; a query ended by a client command (`\G`, `\gx`); and results that go to a file or another command (`> users.csv`, `| wc -l`, `psql -o`, `mysql --tee`, sqlite `.output`), since a cap there would silently change the answer. Put `/* nocap */` in a query to exempt it.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | number | `50` | The LIMIT appended to a SELECT that has none. |

## How it works
- Hooks `tool.call` for `Bash`. The command line is split into words that remember their quotes, the client (`psql -c/--command`, `mysql -e/--execute`, `sqlite3 <db> "<sql>"`, also behind `sudo`, `env VAR=x`, `docker exec` and shell chains) is located, and the SQL is checked with the string literals and comments masked out. The LIMIT goes just inside the closing quote, before a trailing `;`, and the rewritten command goes down with `next({ ...e, command })`.
- It never blocks: if anything is unclear (odd quoting, a dialect difference such as `#` comments or `\'` escapes) the command is passed on untouched.
- Limits: `LIMIT n` is valid in PostgreSQL, MySQL/MariaDB and SQLite; SQL Server's `TOP` and Oracle's `FETCH` are never added. A client run from a script file or through a pipe is not seen.

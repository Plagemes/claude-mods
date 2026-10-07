# sql-safety
> Flags UPDATE and DELETE without WHERE in .sql files and in queries inside your code.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
Whenever Claude edits or writes a file, sql-safety looks at the SQL the change adds: whole statements in `.sql` files, and string or template literals that hold SQL in JavaScript, TypeScript, Python, Ruby, PHP, Go, Java, Kotlin, C#, Rust and Elixir code. It flags `UPDATE ... SET` and `DELETE FROM` without `WHERE`, `DROP TABLE/DATABASE/SCHEMA` and `TRUNCATE`. In `warn` mode Claude is told; in `block` mode the edit is refused.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install sql-safety@claude-mods
```

## Usage
In `warn` mode you see a toast such as `1 risky SQL statement added to users.ts`, and Claude gets a note with the line and statement:

```
sql-safety: this edit added SQL that can destroy data to /repo/src/users.ts.
  line 12: UPDATE without WHERE changes every row: UPDATE users SET active = false
Check that each is intended: add a WHERE clause, or move DROP and TRUNCATE to a migration.
```

In `block` mode the edit never happens and Claude gets the same list as a refusal. Statements that are only part of a longer dynamic query (`"... " + where`, `${where}`), prose such as `"Delete from cache failed"`, and comments are not flagged. Statements the file already had are not flagged again.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `warn` or `block` | `warn` | `warn` lets the edit through and tells Claude; `block` refuses it. |
| `migrationDirs` | string | `migrations,migrate,db/migrate,prisma/migrations,alembic/versions,supabase/migrations` | Comma-separated folders where `DROP` is expected and not flagged. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`: it reads the file, applies the change in memory, and compares the risky statements before and after, so a change that removes a `WHERE` from an existing query is caught and untouched old statements are not.
- Statements are found by pattern: `.sql` text is split on `;` with comments blanked; in code, string, template and heredoc literals (joined across `+` and adjacent strings) are searched for statements that start with `UPDATE`, `DELETE`, `DROP` or `TRUNCATE`.
- Limits: it is not a SQL parser. A `WHERE` built at run time cannot be seen (such queries are skipped), ORMs and query builders (`User.update_all`, `knex('t').del()`) are not looked at, and edits on a remote machine are not scanned. It fails open: if the scan throws, the edit goes through.

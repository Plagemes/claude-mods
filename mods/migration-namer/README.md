# migration-namer
> Gives new migrations consistent, descriptive, timestamped names.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
When Claude writes a new file into a migrations folder with a name like `migration.sql`, `new.py` or `update.rb` (or any name with no timestamp or sequence number in front), migration-namer refuses the write and hands back a better name. The name copies the convention the folder already uses (`20240101120000_x.rb`, `0003_x.py`, `V4__x.sql`, Laravel's `2024_01_01_120000_x.php`, Prisma's folder-per-migration) and, when it can read the SQL or ORM code Claude is about to write, it already describes the change (`add_status_to_orders`).

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install migration-namer@claude-mods
```

## Usage
Nothing to run for the guard. A refused write looks like this to Claude:

`migration-namer: "migration.sql" is too generic and has no timestamp or number in front. Migrations in db/migrate follow YYYYMMDDHHMMSS_snake_case, like 20240215093000_add_email_to_users.rb. Write it as /repo/db/migrate/20261007123045_create_orders_table.sql instead.`

You can also ask for a name yourself:

```
/migration-name add status to orders
20261007123045_add_status_to_orders.sql
Convention: YYYYMMDDHHMMSS_snake_case (from db/migrate)
```

A trailing extension picks the file type (`/migration-name add status to orders .py`).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directories` | string | `migrations,db/migrate,db/migration,prisma/migrations,alembic/versions,supabase/migrations` | Comma-separated migration folders, matched anywhere in a path (`db/migrate` also matches `api/db/migrate`). |
| `defaultStyle` | string | `timestamp` | `timestamp` or `sequence`: numbering used when the folder has no migration yet to copy. |

## How it works
- Hooks `tool.call` for `Write` only, and only for a file that does not exist yet in a migrations folder; editing or rewriting an existing migration is left to guards like `migration-guard`. The folder's other entries are read with `$.fs.list` to detect the convention (timestamp, Laravel, epoch, date, sequence, Flyway; the most used style wins) and the timestamp comes from `$.clock`, in UTC.
- The suggested description comes from the content (`CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, Rails `add_column`, Alembic `op.create_table`, Django `CreateModel`, Knex `createTable` and a few more); when nothing is recognisable the name contains a `<what_it_changes>` blank for Claude to fill.
- Registers `/migration-name`, which looks for the first configured folder in the project root. It never blocks on failure: if the check itself breaks the write goes through. Limits: Alembic's hash prefixes are accepted but cannot be generated, so a new Alembic file is suggested a timestamp; shell commands that create files (`touch`, ORMs' generators) are not seen.

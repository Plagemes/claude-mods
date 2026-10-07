# migration-guard
> Prevents editing database migrations that already exist; write a new one instead.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Migrations are history: once one has been applied anywhere, changing it makes databases drift apart. migration-guard refuses Claude's Edit, MultiEdit and Write calls on an existing migration file and tells it to add a new migration instead. Creating new migration files is always allowed, and so is editing a migration that Claude itself created earlier in the same session, until it is committed.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install migration-guard@claude-mods
```

## Usage
Nothing to run. When Claude tries to change `db/migrate/20240101_add_users.rb` the call is denied with: `migration-guard: db/migrate/20240101_add_users.rb is an existing migration (tracked in git). Editing it would rewrite history that may already be applied. Leave it as it is and create a new migration with the change instead.` Claude reads that and writes a new migration.

Guarded directories by default: `migrations/`, `db/migrate/`, `prisma/migrations/`, `alembic/versions/`, `supabase/migrations/`, matched anywhere in the path (so `apps/api/db/migrate/` counts).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directories` | string | `migrations,db/migrate,prisma/migrations,alembic/versions,supabase/migrations` | Comma-separated directory names or paths that hold migrations (add `db/migration` for Flyway, for example). |
| `allowUncommitted` | boolean | `false` | Also allow editing migrations that existed before the session but are not tracked in git yet (a draft you just generated). Tracked ones stay protected. |

## How it works
- Hooks `tool.call` for Edit, MultiEdit and Write. A file is protected when it exists, sits in a migration directory (the real path of a symbolic link counts too) and either `git ls-files --error-unmatch` finds it tracked, or its modification time is older than the session's start.
- It is a guard with a `.catch`: if the check itself fails, a path spelled like a migration is refused and every other file goes through.
- Limits: it only sees Claude's file tools, not shell commands such as `sed -i` or a migration tool rewriting files. In a resumed session "session start" is the original launch, and a file copied in with an old modification time counts as pre-existing.

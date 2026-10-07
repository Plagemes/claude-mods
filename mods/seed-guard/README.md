# seed-guard
> Blocks database seed, reset and drop commands unless DATABASE_URL points at your own machine.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
Before Claude runs a Bash command, seed-guard checks whether it seeds, resets or drops a database: `prisma migrate reset`, `prisma db push --force-reset`, `rails db:reset/db:drop/db:seed`, `php artisan migrate:fresh/db:seed`, Django `flush`, `knex seed:run`, `sequelize db:seed`, `dropdb`, and package scripts such as `npm run seed`, `npm run reset` or `npm run db:reset` (not unrelated ones like `reset-cache`). It then finds out which database the command would hit and refuses it unless that database is on your own machine.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install seed-guard@claude-mods
```

## Usage
Nothing to run. A refused command comes back to Claude as:

```
seed-guard: "prisma migrate reset" would run against DATABASE_URL host "db.abcdefgh.supabase.co" (from /repo/.env).
Seeding, resetting and dropping is only allowed on your own machine (localhost, 127.0.0.1, ::1, a sqlite file,
or a host in allowHosts). Point DATABASE_URL at a local database for this command, or ask the user to run it themselves.
```

The target is read, in this order, from `DATABASE_URL=...` in the command (or an earlier `export`), the session's environment, then the `.env`, `.env.local`, `.env.development` and `prisma/.env` files of the folder the command runs in (a `cd dir &&` before it is followed) and of the project root. `DIRECT_URL` is checked too. `RAILS_ENV=production` and similar in the command are refused outright.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowHosts` | string | `db,postgres,postgresql,mysql,mariadb,mongo,mongodb,redis,database` | Comma-separated database hosts that count as your own machine, on top of `localhost`, `127.x.x.x`, `::1`, sockets, sqlite files and `host.docker.internal`. These are the docker-compose service names; `*` wildcards work. |
| `denyUnknown` | boolean | `false` | Also refuse when no `DATABASE_URL` can be found at all. Off by default: the tool then uses its own config (`database.yml`, `settings.py`), which usually means a local database. |

## How it works
- A `tool.call` guard on `Bash` reads the command line with the shared claude-mods shell reader (quotes respected, `sudo`/`env`/`time` and `npx`/`bundle exec`/`pnpm exec` wrappers skipped, `bash -c "…"`, `eval`, `$(…)` and heredocs fed to a shell read too, a nested script starting where its parent runs), matches it against the destructive commands above, and resolves the database URL with `$.env` and `$.fs.read`. It never runs anything.
- It fails closed: if the check itself throws, a command that mentions seed, reset, drop, fresh, flush or wipe is refused; other commands are not affected.
- With [mods-hub](../mods-hub) installed, every deny is also published as `risk.blocked` (rule `remote-environment`, `remote-database` or `unknown-database`, severity, the command with credentials masked). Without the hub nothing changes.
- Limits: commands run inside `docker compose exec` or over `ssh` use that machine's own environment and are not checked; a URL that is built at run time (`${HOST}`) cannot be resolved (see `denyUnknown`); a database named only in `database.yml` or `settings.py` is not read.

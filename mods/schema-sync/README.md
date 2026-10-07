# schema-sync
> After Prisma or Drizzle schema edits, regenerates the client and warns when a migration is missing.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
When Claude edits a Prisma schema (`*.prisma`) or a file your `drizzle.config` names as schema, schema-sync waits for the edits to settle. For Prisma, it runs `prisma generate` so the types match the new schema. It also compares the schema with the last migration it saw. If a model or table changed and no new migration was created, a band above the prompt says so and offers to have Claude create one.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install schema-sync@claude-mods
```

## Usage
- Status line:
  - `⧗ prisma generate…`, then `✓ prisma client regenerated` (for a few seconds)
  - `⚠ Prisma schema changed without a migration` (or `Drizzle`)
  - `✗ prisma generate failed`
- Band when a migration is missing:
  ```
  ⚠ Prisma schema changed without a migration  Order (changed), Invoice (new)
  [ Ask Claude to create one ]  [ Dismiss ]
  ```
  **Ask Claude to create one** (`m`) asks Claude to run `npx prisma migrate dev --name …`, or `npx drizzle-kit generate` for Drizzle. Claude then reviews the SQL for dropped columns, required columns without defaults and renames that came out as drop plus add.
- When `prisma generate` fails, a toast shows the schema error (`error: Type "Strng" is neither a built-in type… --> prisma/schema.prisma:9`). The band adds **Ask Claude to fix** (`f`).
- The warning clears when a new migration appears (Claude ran `prisma migrate dev` or `drizzle-kit generate`). It also clears after `prisma db push` / `drizzle-kit push`, which bring the database in step without one.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `generate` | boolean | `true` | Run `prisma generate` after each Prisma schema edit. |
| `debounceSeconds` | number | `2` | How long schema edits must settle before generating and checking. |

## How it works
- Before a schema file's first edit in the session, a `tool.call` hook records its text and the migrations present (`prisma/migrations`, or the Drizzle config's `out` folder). After edits settle, the current schema is compared with that record:
  - comments and spacing are ignored
  - changes are named per Prisma `model` / `enum` / `view`, or per Drizzle `export const x = pgTable(…)`
- `prisma generate` runs from `node_modules/.bin/prisma` (else `npx --no-install prisma`) with a 2-minute timeout.
- Drizzle's schema comes from `drizzle.config.{ts,js,mjs,cjs,json}`: `schema` as a file, a folder, a glob or a list, and `out`.
- Limits:
  - The migration check is offline by design: it needs no database or shadow database. It assumes the schema matched its migrations when the session first saw it. Drift that already existed before the session isn't detected (`prisma migrate status` finds that).
  - Projects with no migrations folder (`db push` workflows) only get the client regenerated.
- With [mods-hub](../mods-hub) installed: the greeting says it publishes `build.result` (`tool: prisma`, one per `prisma generate` it runs, with outcome, duration and command), and a failed generate goes through `notify` at `warning` level instead of the 8-second toast. Without the hub the toast is unchanged.

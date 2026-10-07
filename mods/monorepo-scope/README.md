# monorepo-scope
> Detects which monorepo package you're in and scopes test, lint and build commands to it.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
In a monorepo, Claude often runs `pnpm test` at the root and waits for every package's tests. monorepo-scope tracks which package Claude is working in (the package of the files it last edited). It rewrites root-level test, lint and build runs to that package only, and tells Claude what it changed and how to run everything when that's what you want.

| Runner | Root command | Becomes |
| --- | --- | --- |
| pnpm | `pnpm test` / `pnpm run lint` | `pnpm --filter @app/web test` |
| npm | `npm test` / `npm run build` | `npm test -w @app/web` |
| yarn | `yarn test` | `yarn workspace @app/web test` |
| bun | `bun run test` | `bun run --filter @app/web test` |
| Turborepo | `turbo run test` (also via npx / pnpm) | `turbo run test --filter=@app/web` |
| Nx | `nx test`, `nx run-many -t test,lint` | `nx test web`, `nx run-many -t test,lint -p web` |

## Install
```
/plugin install monorepo-scope --marketplace plagemes/claude-mods
```

## Usage
- Status line: `📦 @app/web`, or `📦 @app/ui (pinned)` when you pinned a package.
- `/scope-pkg` shows the current package and lists the workspace's packages.
- `/scope-pkg <name>` pins a package. You can name it by full name (`@app/ui`), short name (`ui`) or folder (`packages/ui`).
- `/scope-pkg auto` goes back to following the edits. `/scope-pkg off` stops scoping for the session.
- Commands that already pick packages are left alone: `-r`, `--filter`, `-w`, `--workspaces`, `-p`, `--all`. So are commands run from inside a package folder, compound commands (`&&`, `|`) and scripts the package doesn't have.
- After a rewrite, Claude reads: ``monorepo-scope: ran `pnpm --filter @app/web test` instead of `pnpm test` … For every package run `pnpm -r test` …``

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `autoScope` | boolean | `true` | Rewrite root-level commands. When off, the command runs as written and Claude gets a hint with the scoped command. |
| `scripts` | string | `test,lint,build,typecheck,check` | The scripts and tasks to scope. |

## How it works
- The workspace is the nearest folder up from the session with one of:
  - `pnpm-workspace.yaml`
  - a `workspaces` field in package.json
  - `lerna.json`
  - `nx.json` / `turbo.json`, which use `apps/*`, `libs/*` and `packages/*`
- Package globs (`*`, `**`) are expanded with `$.fs.list`. Names, scripts and Nx targets come from each package's `package.json` and `project.json`. The package manager comes from `packageManager` or the lockfile.
- A `tool.call` hook on Edit / Write follows the package of each edited file. Editing a manifest rescans the workspace.
- A `tool.call` hook on Bash rewrites the command with `next({ ...e, command })` when the shell is at the workspace root. It adds a note to the result.
- Limits:
  - Scripts called through other names (`pnpm t`, custom aliases) aren't recognised.
  - Only commands Claude runs through Bash are scoped.

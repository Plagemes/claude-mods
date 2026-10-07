# quick-commands
> Short aliases like /t, /l and /b that run your test, lint and build commands.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Four short commands that send Claude straight to work with your project's own tooling: `/t` runs the tests, `/l` the linter, `/b` the build and `/tc` the type checker, and Claude fixes whatever fails. The command to run is detected from the project (or set once in the mod's settings), so the same muscle memory works in every repo.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install quick-commands@claude-mods
```

## Usage
- `/t`, `/l`, `/b`, `/tc` each submit a prompt such as ``Run the test suite with `pnpm run test` and fix any failures.``
- Add words to narrow it: `/t src/auth` appends `Limit it to: src/auth.`
- When nothing can be detected, the command tells you which setting to fill in and sends nothing.

Detection order: `package.json` scripts (`test`, `lint`, `build`, and `typecheck`/`type-check`/`check-types`/`tsc`/`types`; the runner follows the lockfile: pnpm, yarn, bun, else npm; a bare `tsconfig.json` gives `tsc --noEmit`), then Makefile targets, then `Cargo.toml`, then Python (`pytest`, `ruff check .`, `mypy .`/`pyright`, `python -m build`, from `pyproject.toml`), then `go.mod`. npm's placeholder "no test specified" script is ignored.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `testCommand` | empty | Command for `/t`; empty means detect. |
| `lintCommand` | empty | Command for `/l`; empty means detect. |
| `buildCommand` | empty | Command for `/b`; empty means detect. |
| `typecheckCommand` | empty | Command for `/tc`; empty means detect. |

## How it works
- Registers the four commands at `session.start`; each `command.run` hook finds the command (settings first, then detection with `$.fs.read` / `$.fs.exists` in the session's working directory) and queues a prompt with `$.prompt.submit`, worded as your own message.
- The prompt is submitted from a short timer after the command ends, so it starts a turn of its own once the session is idle.
- Detection looks at the working directory only; in a monorepo, start Claude in the package you want, or set the commands in the settings.
- With [mods-hub](../mods-hub) installed, it watches for the Bash call that runs the command it asked for and publishes the result: `lint.result` (errors and warnings read from eslint, biome, ruff, clippy, go vet... output), `build.result`, `typecheck.result`, and `test.result` for a test command the hub's own sensor does not recognize (a custom `testCommand`; the usual runners are reported by the hub itself, with the detector every mod shares, `shared/test-runners.ts`). autopilot, lessons-learned and session-journal react to them. Without the hub nothing changes.

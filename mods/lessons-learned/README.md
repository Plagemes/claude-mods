# lessons-learned
> When Claude fixes a mistake, offers to save the lesson to CLAUDE.md.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
It notices fix cycles: a test, build, lint or type-check command fails, Claude edits files, and the same check then passes. When that turn ends, a small model writes the reusable lesson in one line ("Initialize the price cache before rendering a cart in tests; `renderCart` reads it synchronously.") and a band above the prompt offers to save it to `CLAUDE.md` under `## Lessons learned`, so future sessions avoid the same mistake.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install lessons-learned@claude-mods
```

## Usage
After a turn that fixed a failing check:

```
💡 Lesson learned from fixing npm test
Initialize the price cache before rendering a cart in tests; renderCart reads it synchronously.
[ Save to CLAUDE.md ]  [ Dismiss ]
```

- **Save to CLAUDE.md** (`s`) appends `- <lesson>` at the end of the `## Lessons learned` section (created at the end of the file when missing, the file created when absent) and toasts `📘 lessons-learned: saved to CLAUDE.md`.
- **Dismiss** (`x`) drops it. Up to three lessons queue up (`· 1 of 2`).
- Nothing appears for flaky reruns (no edits between fail and pass), commands that are not checks, or fixes the model judges one-off typos.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | Model alias or id that writes the lesson. |
| `file` | string | `CLAUDE.md` | Instructions file the lesson is saved to, relative to the project root. |

## How it works
- Wraps `tool.call`: a Bash call matching a known check (`npm/pnpm/yarn/bun test|build|lint|typecheck`, jest, vitest, pytest, tsc, eslint, ruff, mypy, `cargo test|build|check|clippy`, `go test|build|vet`, `make/gradle/mvn/dotnet ... test|build`, ...) that errors is remembered with its output's tail; Edit/Write/MultiEdit/NotebookEdit calls are attached to it; a later pass of the same check (`npm run test -- x` and `npm test` count as one) completes the cycle.
- On `turn.complete` (main loop, answered), one `$.model.complete` call (low effort, 20 s timeout) gets the failing command, error tail, edited files and Claude's answer, and may answer `NONE`. The lesson waits in `$.state`, drawn by an `AbovePrompt` hook on terminal and desktop.
- Saving reads and rewrites the file through `$.fs`; a lesson already present is not added twice. Detection relies on the Bash tool reporting a non-zero exit as an error.

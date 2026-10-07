# typecheck-gate
> Type-checks the project at the end of every editing turn so errors never slip by.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
When a turn of Claude's edited TypeScript or Python files, typecheck-gate runs your type checker as soon as the turn ends. If it finds errors, it reacts in one of two ways:
- **notify** (default): you get a toast and a status line, and Claude gets the first 20 errors with your next prompt.
- **autofix**: it starts a follow-up turn asking Claude to fix them. After a set number of rounds in a row it hands over to you.

| Language | Checker | Runs when |
| --- | --- | --- |
| TypeScript | `tsc --noEmit -p tsconfig.json` (`node_modules/.bin` first) | the edited file has a `tsconfig.json` above it; the whole project is checked |
| Python | pyright `--outputjson` | `pyrightconfig.json` or `[tool.pyright]` |
| Python | mypy | `mypy.ini`, `[tool.mypy]` or `[mypy]` in setup.cfg; only the edited files are checked |

## Install
```
/plugin install typecheck-gate --marketplace plagemes/claude-mods
```

## Usage
- Status line: `⧗ typecheck: running tsc…`, then `✓ types: clean (tsc)` or `✗ types: 4 type errors (tsc)`.
- Toast: `typecheck-gate: 4 type errors (tsc)`. In autofix mode it reads `… asking Claude to fix them (round 1 of 3)`.
- `/typecheck` checks every TS and Python file edited this session right away, or the working directory's `tsconfig.json` project if none were edited. It prints the errors in the transcript, where Claude reads them too.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `notify` \| `autofix` | `notify` | Hand Claude the errors with your next prompt, or start a fix turn right away. |
| `maxAutofixRounds` | number | `3` | Autofix turns in a row before it stops. The count resets when you type a prompt or the types come out clean. |
| `timeoutSeconds` | number | `180` | How long one checker run may take. |

## How it works
- Hooks `tool.call` to remember the TS and Python files that successful Edit, Write and MultiEdit calls touched.
- Hooks `turn.complete` on the main loop. It skips subagent, interrupted and failed turns. The check runs in the background after the turn has ended, so the session never waits on it.
- Errors reach Claude in one of two ways:
  - notify mode adds them as hidden context to your next prompt (`prompt.submit`).
  - autofix mode sends them with `$.prompt.submit`.
- Limits:
  - Python files are checked only when the project configures pyright or mypy.
  - Edits made through Bash don't trigger a check.
  - If a check is still running when the next turn ends, those edits are checked after the following turn.

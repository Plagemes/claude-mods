# compact-coach
> Suggests /compact at natural breakpoints, before the context gets tight.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Compacting in the middle of a task throws away detail you still need; compacting right after a task ends is cheap and clean. This mod watches for that moment: the context is more than 60% full, nothing is left on the todo list, and the turn ended on a commit (or push, or `gh pr create`) or on a passing test run. Then it shows one toast. It never nags: at most one suggestion per 10 turns.

## Install
```
/plugin install compact-coach --marketplace plagemes/claude-mods
```

## Usage
You will see a toast like `compact-coach: good moment to /compact (context 72%, after a commit)`. Run `/compact` if you agree; the mod never compacts for you.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `minPercent` | `60` | Only suggest when the context window is at least this full. |
| `cooldownTurns` | `10` | Turns that must pass before the next suggestion. |

## How it works
- Hooks `tool.call` (main conversation only) to remember what the last substantive tool call of the turn was: a successful `git commit` / `git push` / `gh pr create`, a successful test command (npm/pnpm/yarn/bun test, pytest, jest, vitest, go test, cargo test, mvn/gradle test, dotnet test, make test), or something else. Todo and task bookkeeping calls do not count as "something else".
- Tracks open work from `TodoWrite` lists and `TaskCreate`/`TaskUpdate`; on `turn.complete` it reads the context fill with `$.session.usage()`.
- Test detection goes by the command line and a non-error result, so a custom test script with an unusual name is not recognised. Interrupted turns never trigger a suggestion.

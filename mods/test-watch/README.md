# test-watch
> Runs the tests related to what changed and shows pass/fail in the status line.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
Whenever Claude edits files, test-watch waits until the edits settle (3 s), finds the tests that belong to those files and runs only them with your project's runner. The verdict lands in the status line. The full output of the last run is one command away in a pane.

| Language | Runner | Related tests |
| --- | --- | --- |
| JS / TS | vitest, else jest (from package.json or a config file) | `name.test.ts` / `name.spec.ts` beside it, in `__tests__/`, or mirrored under `test/`, `tests/` |
| Python | pytest (`.venv/bin` first) | `test_name.py` / `name_test.py` beside it, in `tests/`, or mirrored |
| Go | `go test -v ./pkg` | the file's package, when it has `_test.go` files |
| Rust | `cargo test` | the crate, or `--test name` for `tests/name.rs` |

An edited test file runs itself.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install test-watch@claude-mods
```

## Usage
- Status line: `⧗ tests: running app.test.ts…`, then `✓ 12 passed` or `✗ 2 failed · 10 passed`. When no tests match the edited file, it shows `○ tests: none related to orphan.ts`.
- `/tests-last` opens a pane with:
  - the verdict, the runner and how long it took
  - the files that ran
  - the runner's whole output, colors stripped
  - **Run again** (hotkey `r`) and **Close** buttons
- With [mods-hub](../mods-hub) installed, `/tests-last` opens the **Tests** tab of the shared Claude Mods panel instead (same view, without Close).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `debounceSeconds` | number | `3` | How long edits must settle before the related tests run. |
| `timeoutSeconds` | number | `300` | How long one test run may take before it is stopped. |

## How it works
- Hooks `tool.call` for Edit, Write and MultiEdit. Each edited path is queued and a `$.clock.after` debounce timer is restarted, so a burst of edits causes one run.
- When the timer fires, it lists the candidate test folders and runs each runner once per project with `$.process.run`, with `CI=1` and colors off. It reads the pass and fail counts from the runner's summary line with the detector every Claude Mod shares (`shared/test-runners.ts`). The last run is kept in `$.state` for the pane.
- With mods-hub installed: every run is published as `test.result` (runner, outcome, counts, duration, command) for the mods that react to tests (celebrate, error-buzz, smart-router, mod-advisor...), and what ran is shared as the fact `test-watch.plan`; the pane becomes the panel's **Tests** tab. Without the hub nothing changes.
- Limits:
  - It only reports. It doesn't tell Claude about failures.
  - Edits that arrive during a run trigger another run once that one finishes.
  - Bash edits aren't watched.
  - Rust runs the whole crate's tests unless the file is an integration test.

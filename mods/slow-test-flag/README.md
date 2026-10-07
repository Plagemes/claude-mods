# slow-test-flag
> Points out your slowest tests after each test run.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
When a test command finishes in Bash, slow-test-flag reads the timings the runner printed and shows the five slowest tests in a toast, with the slowest one kept in the status line. It understands Jest (`--verbose`), Mocha, Vitest, pytest (`--durations`), `go test`, `cargo test --report-time` and `cargo nextest`. If a runner printed no per-test times, it tells you the flag that adds them, once per runner.

## Install
```
/plugin install slow-test-flag --marketplace plagemes/claude-mods
```

## Usage
Run tests as usual (or let Claude do it). After a run you see something like:

```
slowest tests in that run:
 1.   1.52 s  tests/test_api.py::test_login
 2.   300 ms  tests/test_db.py::test_connect [setup]
```

`/slow-tests` lists the last run's ten slowest again, with the command and how long ago it ran. When a runner gave no timings you get a hint such as `run pytest with --durations=10 to see the slowest tests`; Vitest's default reporter and `go test` without `-v` only report files and packages, so those are listed instead of single tests.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `top` | number | `5` | How many of the slowest tests the toast lists. |
| `thresholdMs` | number | `100` | Tests faster than this are never called slow. |
| `status` | boolean | `true` | Keep the slowest test of the last run in the status line. |

## How it works
- Hooks `tool.call` on `Bash`. For commands that look like a test run (`jest`, `vitest`, `pytest`, `go test`, `cargo test`, `npm test`, ...) it parses the output after the command finished, passing or failing, and never changes the result. Background runs are skipped, since their output is not available when they start.
- The last run is kept in the mod's store, so `/slow-tests` still works in the next session.
- Limits: it can only report times the runner printed, and it ranks tests, or files and packages when no test times exist. Jest prints per-test times only with `--verbose` (or for a single file), and `cargo test` only on nightly with `-Z unstable-options --report-time`.

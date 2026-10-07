# regression-guard
> Remembers which tests passed at the start of the session and warns if any of them now fail.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
Every time a test command runs through Bash (`npm test`, `npx vitest run`, `pytest`, `go test ./...`, `cargo test`, …), regression-guard reads the per-test results from the output. The first result it sees for each test is that test's baseline. When a test that passed at its first run fails later in the session, it is a regression. You see it above the prompt and in the status line, and Claude reads a note about it in the test command's result. When the test passes again, the warning goes away.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install regression-guard@claude-mods
```

## Usage
- **Band above the prompt** when something regressed:
  `⚠ Regressions: 2 · passed earlier this session, failing now`, then one `✗ <test>` row per test.
  - **Ask Claude to fix regressions** (hotkey `f`) sends a prompt listing the tests and the command to re-run. It asks Claude to fix the code, not the tests.
  - **Dismiss** (hotkey `x`) hides the band until the set of regressions changes.
- **Status line:** `⚠ 2 regressions` while any are open.
- **Toasts:** one when a run breaks tests that passed, and `✓ Every regression passes again` when the last one is fixed.
- **`/baseline`** shows:
  - how many tests the baseline holds
  - every open regression, with when it started failing and which command showed it
  - the last test run
- **`/baseline reset`** forgets everything. The next test run becomes the new baseline.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `tellClaude` | boolean | `true` | Add a note to the test command's result when tests that passed earlier now fail. |
| `maxListed` | number | `5` | How many regressed tests the band lists before `+N more`. |

## How it works
- Hooks `tool.call` for Bash. When the command looks like a test run, it parses the output once the run finishes:
  - Jest and Vitest, default and verbose
  - Mocha and node:test, spec and TAP
  - PHPUnit testdox
  - pytest: `-v`, quiet progress and `FAILED` summary lines
  - `go test` and `cargo test`

  The baseline, the regressions and the last run live in `$.state` for this session. Runs that finish together are folded in one after the other.
- Runners that list only failures (Jest without `--verbose`, Vitest's default reporter, `go test` without `-v`) put whole files or packages in the baseline. If a test fails later in a file that passed in full, that counts as a regression. The exception is a test file Claude edited this session (tracked through `Edit` and `Write`): its unknown failing tests may be new tests written first, so they become baseline failures.
- Limits:
  - The baseline lasts for the session and is not kept after you exit.
  - Background Bash runs and tests run outside Claude Code aren't seen.
  - Output the Bash tool cut in the middle loses the tests in the cut.
  - A test renamed between runs counts as a new test.

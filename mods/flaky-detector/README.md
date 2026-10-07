# flaky-detector
> Detects tests that pass and fail at random and keeps a list of the suspects.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
Every test run through Claude's shell is read for per-test results (jest, vitest, pytest, go test, cargo test, rspec). When a test fails and later passes, or passes and later fails, on exactly the same code, it is marked flaky and kept in a per-project list with its flip count. When a known flaky test fails again, Claude is told so it re-runs before chasing a bug that is not there.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install flaky-detector@claude-mods
```

## Usage
- Nothing to do: run tests as usual (`npm test`, `npx vitest run`, `pytest`, `go test ./...`, `cargo test`, `bundle exec rspec`…). A toast says when a test turns out flaky.
- `/flaky` opens the list: each suspect with its flips and its last outcomes (`✗✓✓✗`), plus **Copy**, **Stabilise** (asks Claude to find the cause and make it deterministic) and **Forget**; below, tests failing now that have not flipped yet.

```
⚠ Flaky tests · shop                                  2 suspects · 1 watched
src/cart.test.ts > checkout > charges card            Copy  Stabilise  Forget
3 flips · ✗✓✗✓✓ · vitest · last flip 2 h ago
Failed, not flaky (yet)
✗ tests/test_tax.py::test_rounding          ✗ · 5 min ago               Forget
```

## Configuration
No configuration needed.

## How it works
- A `tool.call` hook on Bash parses test output with pure parsers: per-test `✓`/`×` lines and `FAIL file > test` (vitest), `●` failures and the `--verbose` tree (jest), `FAILED path::test` and `-v` lines (pytest), `--- FAIL:` tied to their package (go), `test x ... FAILED` (cargo), `rspec ./file:line # name` (rspec). A whole file or package reported passing counts as a pass for its tracked tests, as does the same command finishing with the test not among the failures.
- "No code change" is checked by content, not by time: after each run the whole worktree is hashed as a git tree, in an index file of the mod's own under `.git/`, so edits by you, Claude or any tool count. Outside git it falls back to counting Claude's own edits.
- History (tests that have failed, and the last few runs) lives in the mod's store per project. Limits: files a test run itself writes, if git does not ignore them, count as changes; truncated outputs are read as far as they go; rspec passes are only known from a run of the same command.
- With **mods-hub** installed each newly flaky test is published as `x.flaky-detector.suspect` (id, runner, scope, flips, command) and announced as a hub notification at level `warning` (your phone channels too while you are away, held while Silent) instead of a toast; when test-watch's **Tests** tab of the Claude Mods panel is showing, the suspects are drawn as a section beneath it. Per-test names come from the output, which the hub's `test.result` (counts only) cannot replace, so the parsers stay; `shared/test-runners` also decides what counts as a test command, beside this mod's own detector. Without the hub nothing changes.

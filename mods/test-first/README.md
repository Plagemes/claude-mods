# test-first
> A TDD mode: no production code changes until a test has been written or changed.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
`/tdd on` holds Claude to red → green → refactor. Until a test file has been edited in the current turn, every Edit or Write to a production source file is refused, and the refusal tells Claude what to do instead. A band above the prompt shows where the cycle stands, guessed from the test commands Claude runs: a failing run means red, a passing run means green, and code edited while green means refactor.

## Install
```
/plugin install test-first --marketplace plagemes/claude-mods
```

## Usage
- `/tdd on` turns the mode on and briefs Claude on the rules. `/tdd off` turns it off, and `/tdd` alone says where it stands.
- Band: `TDD ● red → ○ green → ○ refactor · code locked · write a failing test first [TDD off]`.
- When a refusal fires, Claude reads: `test-first: TDD mode is on, so src/app.ts stays locked until a test is written this turn. Write or update a test that fails for this change first…`
- Production code is open when:
  - a test file was edited this turn (`*.test.ts`, `*.spec.js`, `test_*.py`, `*_test.go`, `*_spec.rb`, `FooTest.java`, anything under `tests/`, `__tests__/` or `spec/`)
  - or the last test run failed, so Claude may write the code that makes it pass.
- Docs, config and data files (`.md`, `.json`, `.yaml`…) are never locked.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call`:
  - It refuses Edit, Write and MultiEdit on locked source files.
  - It records successful test-file edits.
  - It reads the outcome of Bash test commands (npm/pnpm/yarn test, vitest, jest, pytest, go test, cargo test, rspec, …) from the exit status, and from "N failed" output when a pipe hides the exit status.
- Hooks `turn.start` to lock code again at each new turn. State lives in `$.state` and the band is drawn with `ui.render` on `AbovePrompt`.
- Limits:
  - The phase is a guess from commands Claude runs, not from tests you run in your own terminal.
  - Refactoring under green tests still needs a test touched first in that turn, or `/tdd off`.
  - The mode lasts for the session only.
  - The guard fails open: if it errors, the edit goes through.

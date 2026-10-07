# lint-on-save
> Runs the linter on each edited file and hands the errors straight back to Claude.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
After every successful Edit or Write, lint-on-save runs your project's linter on that file. Any errors it finds are attached to the edit's result, so Claude sees them before its next step, with no need to run the linter itself. The status line keeps a running count of problems across the files edited in the session.

| Language | Linter | Runs when |
| --- | --- | --- |
| JS / TS | eslint (JSON output) | an eslint config, or `eslint` in package.json |
| Python | ruff check | always, if installed |
| Go | golangci-lint | a `.golangci.*` config |
| Rust | cargo clippy | a `Cargo.toml` (clippy warnings count as problems) |
| Shell | shellcheck | always, if installed |

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install lint-on-save@claude-mods
```

## Usage
Nothing to run. You'll see:
- Status line: `⚠ lint: 4 problems in 2 files`, or `✓ lint: clean` once they're fixed.
- A note to Claude after the edit, up to 30 lines, sorted by line:
  ```
  lint-on-save: eslint reports 2 errors in src/app.ts. Fix them before moving on:
    1:1  error  'y' is not defined.  [no-undef]
    3:7  error  'x' is assigned a value but never used.  [no-unused-vars]
  ```
- A one-time toast when a linter isn't installed. If the linter itself crashes (a broken config, say), the problem shows in the status line only and Claude isn't told.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `includeWarnings` | boolean | `false` | Also report warnings (eslint severity 1, shellcheck notes). |
| `disabled` | string | `""` | Comma-separated linters never to run. |
| `timeoutSeconds` | number | `60` | How long one linter run may take. |

## How it works
- Hooks `tool.call` for Edit, Write and MultiEdit. Once the edit succeeds, it looks for linter config from the file up to the repository root. It runs the linter through `$.process.run`, preferring `node_modules/.bin` or `.venv/bin` over PATH.
- It reads machine output (eslint and ruff JSON, `file:line:col` lines from the others) and keeps only the problems in the edited file.
- Limits:
  - golangci-lint lints the file's package, and clippy checks the whole crate, which is slower on the first run.
  - The edit's result reaches Claude only once the lint finishes.
  - Edits made through Bash aren't linted.
- With [mods-hub](../mods-hub) installed, each lint is published as `lint.result` (linter, errors, warnings, the file) for autopilot and the other mods that follow code health, and "linter is not installed" becomes a `warning` notice. Without the hub nothing changes.

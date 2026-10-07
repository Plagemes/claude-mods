# auto-format
> Formats every file Claude edits with the right formatter for its language.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
After each successful Edit or Write, auto-format finds the formatter your project already uses for that file and runs it on that one file. When the formatter changes the file, Claude is told right away, so it reads the file again before editing it further instead of failing on stale text. Your own install comes first (`node_modules/.bin`, `.venv/bin`, `vendor/bin`), then whatever is on your PATH.

| Language | Formatter | Runs when |
| --- | --- | --- |
| JS / TS / JSON / CSS / GraphQL | biome | `biome.json(c)` or `@biomejs/biome` in package.json, unless biome.json turns its formatter off |
| JS / TS / CSS / SCSS / JSON / Markdown / YAML / HTML / Vue / Svelte | prettier | a prettier config, or `prettier` in package.json |
| Python | ruff format, else black | `ruff.toml` / `[tool.ruff]`, or black named in pyproject.toml |
| Go | gofmt | always |
| Rust | rustfmt (edition read from Cargo.toml) | always |
| Shell | shfmt | always, if installed |
| C / C++ / Obj-C / Proto | clang-format | a `.clang-format` file |
| PHP | php-cs-fixer | a `.php-cs-fixer(.dist).php` file |

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install auto-format@claude-mods
```

## Usage
Nothing to run. You'll see:
- Status line: `✎ auto-format: 3 files formatted · last app.ts (prettier)`.
- A note to Claude after the edit when the file was reformatted, or when the formatter refused it (usually a syntax error). The note includes the formatter's first error line.
- A one-time toast when the formatter for a file isn't installed. auto-format doesn't try that formatter again for the rest of the session.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `disabled` | string | `""` | Comma-separated formatters never to run, e.g. `black, shfmt`. |
| `timeoutSeconds` | number | `20` | How long one formatter run may take before it is stopped. |

## How it works
- Hooks `tool.call` for Edit, Write and MultiEdit. It waits for the edit to succeed, then looks up from the file to the repository root for config files. It runs the formatter through `$.process.run` with a timeout.
- It compares the file before and after the run. Only a real change adds a note to the tool result.
- Limits:
  - Edits made through Bash (`sed`, scripts) aren't formatted.
  - Files under `node_modules` and `.git` are skipped.
  - The edit's result reaches Claude only after the formatter finishes. Formatting a single file usually takes well under a second.

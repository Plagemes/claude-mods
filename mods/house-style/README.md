# house-style
> Injects your team's style guide (STYLE.md) into the system prompt automatically.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Finds your project's style guide and adds it to Claude's system prompt as a **Project house style** section, so every edit, test and commit message follows your conventions without you pasting them into each prompt. It looks for `STYLE.md`, `.claude/style.md`, `docs/STYLE.md`, and finally the style sections of `CONTRIBUTING.md` (headings such as "Code style", "Conventions", "Formatting").

## Install
```
/plugin install house-style --marketplace plagemes/claude-mods
```

## Usage
Nothing to do: once a guide exists in the project root, it is injected.
- `/style` shows which file is injected, its size in characters and estimated tokens, and a preview of the text.
- Edit the guide at any time: the change is picked up at the start of the next turn.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `files` | string | `""` | Comma-separated paths, relative to the project root, tried before the defaults (e.g. `docs/style-guide.md, STYLE.md`). A `CONTRIBUTING.md` contributes only its style sections. |
| `maxChars` | number | `8000` | The most of the guide that goes into the system prompt (minimum 500). A longer guide is cut at a line break with a note telling Claude to read the file for the rest. |

## How it works
- `prompt.compose` appends one `session`-scoped section (`house-style:style`) after the engine's own, so the shared prompt cache is untouched and the text stays byte-identical between requests.
- The guide is cached by modification time and size: `session.start` and each `turn.start` only stat the candidate files, and a file is re-read only when it changed.
- Skipped under `--bare`. Only the first guide found is used; files over 4 MiB cannot be read and are ignored.

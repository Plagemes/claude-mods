# file-size-watch
> Warns when an edited file grows past a size that hurts readability.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
After Claude edits or writes a file, file-size-watch checks whether the edit made it *longer* and whether it now has more lines than your limit (500 by default). If so, Claude is told to consider splitting the file into smaller modules before adding more, and you get a toast the first time each file crosses the line.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install file-size-watch@claude-mods
```

## Usage
Nothing to run. When a growing edit leaves a file over the limit you see `big.ts is 520 lines. Consider splitting it.` once per file per session, and Claude gets a note on every further edit that makes that file longer. Edits that shrink a file, or leave it the same size, stay silent. JSON, lockfiles, Markdown, CSV, SVG, logs, minified and generated files are skipped.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxLines` | number | `500` | Warn when an edit makes a file longer than this many lines. |

## How it works
- Hooks `tool.call` for `Edit` and `Write`. An `Edit` says by itself whether it adds lines, so the file is read with `$.fs.read` only after a growing edit; a `Write` is compared with the file it replaces.
- The note reaches Claude as tool-result `context`; the toast is raised once per file for the session.
- Limits: it counts lines, not complexity, and only sees files on the machine Claude runs on (edits on an attached remote machine are skipped).
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: file-size-watch`, the file, and how many findings) after each edit with findings and sends its note through `notify` (level info) instead of a toast. Without the hub nothing changes; the mod stands alone.

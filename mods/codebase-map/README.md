# codebase-map
> /map builds a compact map of your repository and gives it to Claude.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
`/map` lists your files with `git ls-files` (or walks the folder when git is not available), then writes a compact map to `.claude/codebase-map.md`: a tree with per-directory file counts, a language summary, and the key files (entry points, configs, docs, CI) called out. From then on the map is added to Claude's system prompt, so it knows where things live without exploring first. The map is kept under a size cap: it drops detail, then depth, before it ever cuts lines.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install codebase-map@claude-mods
```

## Usage
- `/map` — build (or rebuild) the map, save it and open the **Codebase map** pane.
- `/map show` — open the pane with the saved map without rebuilding.
- The pane shows the map with **Refresh** (`r`), **Copy** (`c`) and **Close**.
- Commit `.claude/codebase-map.md` if you want teammates (and their Claude) to share it.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `autoInject` | boolean | `true` | Add the saved map to Claude's system prompt on every request. When off, `/map` hands the map to Claude once, for the current conversation. |
| `depth` | number | `3` | Directory levels shown in the tree (1–6). |
| `maxChars` | number | `6000` | Size cap for the map (1000–40000 characters). |

## How it works
- `command.run` (`/map`) runs `git ls-files --cached --others --exclude-standard`, falling back to a capped `$.fs.list` walk that skips `node_modules`, build output and caches; the result is written with `$.fs`.
- `prompt.compose` appends a `codebase-map:map` section (session scope) once a map exists for the project; `session.start` loads the saved file.
- The map is a snapshot: it does not update itself as files change, so run `/map` again after big moves. Very large repos are summarised (30 dirs per level, 12 files per dir) to stay within the cap.
- With [mods-hub](../mods-hub) installed the mod says hello and shares the fact `codebase-map.summary` on the hub's blackboard whenever a map is built or a saved one is loaded at session start: `{ files, dirs, source, generatedAt, file, isTruncated }`, so other mods (project-brain, context-optimizer) know there is a map and how big it is without reading the file. The map file, the pane and the prompt section are unchanged. Without the hub nothing changes.

# recall
> Gives Claude a recall tool to search your saved notes, decisions and journal.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Registers a `search` tool (listed to Claude as `mcp__recall__search`) that searches what your project already knows: `CLAUDE.md`, the session journal in `.claude/journal/`, decision records in `docs/decisions/` and `docs/adr/`, handoff notes in `.claude/handoff/`, and memories you save with `/remember`. Files are split under their headings and ranked with BM25, so Claude gets the few passages that matter, each with its file and line, instead of reading everything.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install recall@claude-mods
```

## Usage
- Just ask: "what did we decide about the database?" — Claude calls the recall tool on its own when earlier decisions or conventions matter.
- `/remember <text>` — save a memory for this project; `/remember -g <text>` shares it with every project.
- `/recall [words]` — open the **Recall** pane: a search field, ranked results, and your latest memories with **Forget** buttons.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | number | `5` | Passages a search returns when Claude does not ask for a number (1–20). |
| `paths` | string | `""` | Extra files or folders to search, comma-separated (e.g. `notes, docs/rfcs`). |

## How it works
- `session.start` registers the tool with `$.tool.register` and the two commands; `tool.call` serves searches by reading the notes through `$.fs` at call time, so new notes are found at once.
- `tool.check` lets this read-only tool run without a permission prompt, unless one of your permission rules or an organization ceiling says otherwise.
- Memories live in the mod's own `$.store` (up to 500); other mods' stores cannot be read. Searches cover Markdown and text files only, at most 400 files of up to 512 KB each.

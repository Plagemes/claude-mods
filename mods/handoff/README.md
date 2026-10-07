# handoff
> /handoff writes a handoff note so a teammate can pick up exactly where you left off.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
`/handoff` asks a fork of the current conversation to write a factual handoff note with six sections, **Goal**, **Status**, **What changed** (file by file), **Next steps**, **Gotchas** and **How to verify**, grounded in live git facts (branch, uncommitted files, diff stat, recent commits). The note is saved as `.claude/handoff/YYYY-MM-DD-HHMM.md`, copied to your clipboard and shown in a pane, ready to paste into a PR, a ticket or a chat.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install handoff@claude-mods
```

## Usage
- `/handoff` — write, save and copy the note.
- `/handoff the migration is half done` — add what the note should stress.
- The **Handoff** pane shows where it was saved, the note itself, **Copy** (`c`) and **Close**; it warns if the model left a section out.
- A teammate on the same machine can also resume the session itself with the `claude --resume <id>` line at the end.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | string | `.claude/handoff` | Folder for the notes, relative to the project root. |
| `copy` | boolean | `true` | Put each new note on the clipboard. |

## How it works
- `command.run` (`/handoff`) reads git through `$.process.run`, calls `$.model.fork` so the note sees the whole conversation without adding to it, writes the file with `$.fs` (a second note in the same minute gets `-2`) and copies it with `$.ui.copy`.
- The pane draws from `$.state`. Nothing runs in the background.
- The note is only as good as the conversation: work done outside this session shows up only through the git facts. Timestamps use the session's clock.
- With [mods-hub](../mods-hub) installed the mod says hello and gives the model that writes the note the decisions recorded in the last day (the hub's `decision.recorded`: this session's, and those other sessions on the same project published for everyone, read from the hub's `sessions.json`), so the Gotchas and Goal sections can name them with their reasons. `session.ended` is not read: a session removes its own heartbeat when it ends, so only live sessions are visible. Without the hub the request is built from the conversation and git alone.

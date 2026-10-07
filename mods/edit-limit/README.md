# edit-limit
> Asks for confirmation when a single turn tries to modify more than N files.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Counts the different files Claude modifies with `Edit`, `Write` and `NotebookEdit` during one turn. When the next file would go past the limit (15 by default), that call is refused and Claude is told to summarise its plan and ask you before going on. It is a seatbelt for runaway refactors: you decide whether a 40-file change is what you wanted.

## Install
```
/plugin install edit-limit --marketplace plagemes/claude-mods
```

## Usage
When the limit is hit you get a toast and Claude sees:

```
edit-limit: this turn has already modified 15 files and the limit is 15, so Edit was not run.
Do not modify more files yet. Summarise your plan (which files, and why) and ask the user whether
to continue. They can approve by writing EDITS-OK in their next message or by raising the limit
with /edit-limit <n>.
```

Ways to let it continue:
- Put `EDITS-OK` in your next prompt: the limit is lifted for that turn.
- `/edit-limit 40` raises the limit for the rest of the session. `/edit-limit reset` goes back to the setting, and `/edit-limit` alone shows `This turn: 7 of 15 files modified.`

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | number | `15` | How many different files one turn may modify. |
| `allowWord` | string | `EDITS-OK` | When your latest prompt contains this word the limit is lifted for that turn. Empty = only `/edit-limit` can lift it. |

## How it works
- A `tool.call` hook on `Edit`, `MultiEdit`, `Write` and `NotebookEdit` keeps a set of the files touched this turn (subagents included); a `turn.start` hook empties it. Editing a file that is already in the set is free, and a call that fails or is refused by another plugin does not count.
- Only a person's prompt (typed, remote or SDK) can carry the approval word; the `/edit-limit` override lives in `$.state`, so it survives a mod reload but not the session.
- Limits: it counts files the edit tools touch, not files changed by shell commands (`sed -i`, `git checkout`); the count is per turn, so a new prompt starts from zero again.

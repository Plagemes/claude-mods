# standup
> /standup summarises what you did yesterday, from git history, ready to paste.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
`/standup` collects your commits (by your `git config user.email`, across all branches) since the start of your last workday, your branch and work in progress, and any session-journal notes in `.claude/journal/`. A fast model turns that into **Yesterday / Today / Blockers** bullets grouped by theme, shown in a pane with a Copy button. On a Monday it looks back to Friday. If the model is unavailable you still get a standup listed straight from git.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install standup@claude-mods
```

## Usage
- `/standup` — since yesterday's midnight (Friday's on a Monday).
- `/standup 3` — the last 3 days (1–30).
- The **Standup** pane shows the text exactly as it will paste, with **Copy** (`c`), **Regenerate** (`r`) and **Close**:

```
Yesterday:
- Added pagination to the orders API
- Fixed cart total rounding

Today:
- Finish the orders page

Blockers:
- None
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | Model that writes the standup (alias or full id). |
| `style` | `plain` \| `markdown` \| `slack` | `plain` | Paste format: `Heading:` lines, `**bold**` headings, or Slack's `*bold*` and `•` bullets. |
| `allBranches` | boolean | `true` | Count commits on every branch, not just the checked-out one. |

## How it works
- `command.run` (`/standup`) runs `git log --since="N days ago midnight" --author=<you>`, `git status` and reads journal files through `$.fs`, then calls `$.model.complete` (no conversation history is sent, only that activity).
- The pane draws from `$.state`; Copy uses `$.ui.copy` on the surface you pressed it on.
- It sees only what git and the journal know: meetings, reviews and work never committed are yours to add after pasting.
- With [mods-hub](../mods-hub) installed the mod says hello and reads the hub's `sessions.json` (one heartbeat per live session, with its latest `scope: 'global'` `git.commit` events): commits that other sessions on this project made on branches `git log` does not reach (a worktree, a fix branch) are added to the list, newest first and without duplicates, and the model is told how many other sessions are working on the project and what they have used (`Other Claude sessions on this project right now: 1 (27 turns, $3.20 so far)`). `session.ended` is not read: a session removes its own heartbeat when it ends, so only live sessions are visible. Without the hub the standup is built from git and the journal alone.

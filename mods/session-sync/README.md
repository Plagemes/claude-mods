# session-sync
> Coordinates sessions working on the same repo: file leases against conflicts, overlap warnings and hand-offs.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
When two or more Claude sessions work in the same repository (same origin remote, or the same folder), session-sync keeps them from clobbering each other. Before Claude edits a file, its session takes a **lease** on it; if another live session holds that file, the edit is refused with who holds it, what they are doing and since when, and Claude tells you your options: wait, ask the other session, or let it override with your `SYNC-OK`. It also warns (toast plus a note for Claude) when another session changes files in the same folder, or works on the same branch while both have uncommitted changes, and `/handoff-to` passes your work to another session with its context.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install session-sync@claude-mods
```
Install it in every session (user scope does that for all of them).

## Usage
- A refused edit reads, for Claude: `src/api/user.ts is being edited by another Claude session on this repo, shop#b2c3 (branch main), working on "Add the login form": it took the file at 14:02 …` followed by the three options. Reply **`SYNC-OK`** in your next message to let Claude take the file over in that turn; the other session is told.
- **`/sync`** lists this session (branch, uncommitted changes, your leases) and the other sessions on the repo: branch, same checkout or not, what they work on, files changed lately, their leases, and any same-branch warning. **`/sync ask <session> <message>`** sends a question that runs there as a prompt when that session is idle. **`/sync release`** gives up your leases.
- **`/handoff-to <session> [message]`** sends the other session a note it receives as a prompt when idle: your message, your branch and task, the files you changed lately, the leases you released, and, when your sessions overlap heavily (3+ folders or 2+ same files), the advice to run the overlapping part in a subagent with `isolation: "worktree"` or in a separate git worktree.
- Sessions are named by label (`shop#b2c3`), the start of their id, or their branch. The status line reads `⇆ 1 other session on this repo · /sync` (with `· ⚠ same branch` when it applies).
- With mission-control installed, a **Same repo** section appears under its cards (in its pane and in its mods-hub tab).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `leaseMinutes` | number | `10` | How long a file stays reserved after the holding session's last activity. |
| `leases` | boolean | `true` | Refuse edits to files another live session holds. |
| `warnings` | boolean | `true` | Folder-overlap and same-branch warnings. |
| `statusLine` | boolean | `true` | Show how many other sessions work on this repo. |

## How it works
- The repository is identified by its normalized origin remote (or its root without one); its files live in `~/.claude/claude-mods/sync/<name>-<hash>/`: `sessions/<id>.json` (each session's own file: branch, dirty or not, task, files changed lately; written every 10 s), `leases/<id>.json` (each session's own leases, written by that session alone, so no session can drop another's; after taking a file a session reads the others back and yields if one took it at the same moment) and `inbox/<id>/<sender id>.jsonl` (hand-offs, questions, "your lease was taken over"; one file per sender, so two sessions writing at once lose nothing).
- **Leases:** a `tool.call` hook on Edit / Write / NotebookEdit resolves the path (links included), takes or renews the lease and refuses with `{ deny }` when another live session holds it. Leases are renewed while the session is active (any tool call or turn), expire `leaseMinutes` after its last activity, bind nothing once the holder's file is 30 s stale, and are released at session end (and on `/clear`). Leases are per file path, so sessions in separate worktrees never block each other.
- **Override:** `SYNC-OK` counts only in a prompt you typed (composer, phone bridge, SDK), and only for the turn it starts or lands in; any other turn resets it. Hand-offs and questions run as your words but never carry an override, and they are sent only from commands you type.
- **With mods-hub:** warnings and override notices go through `notify` (held while Silent), conflicts are published as `x.session-sync.conflict` and hand-offs as `x.session-sync.handoff`, and the section joins the Mission Control tab. **Without it:** plain toasts; everything else is the same.
- **Limits:** only edits through Claude's edit tools are leased; a file changed by a shell command (`sed -i`, `mv`) or by you in an editor is not. A session must have session-sync installed to hold leases and to be warned. Git state is refreshed every 30 s.

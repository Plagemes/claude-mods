# main-branch-warn
> Warns you the moment Claude starts editing files directly on main or master.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Editing straight on `main` is easy to miss and annoying to untangle. On every `Edit`, `Write` or `NotebookEdit`
main-branch-warn asks git which branch the file's repository is on. If it is `main`, `master` or `trunk`, you get
a toast the first time and a `⚠ editing on main` line under the prompt. In
`block` mode the edit is refused instead and Claude is told to create a branch first.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install main-branch-warn@claude-mods
```

## Usage
- Warn mode (default): the edit goes ahead; you see the toast once and the status line while you are on a main branch. Switch branches and the line goes away at Claude's next edit.
- Block mode: Claude gets `main-branch-warn: not editing directly on "main". Create a branch first (git switch -c <type>/<name>, or /git-branch <task> with branch-namer), then retry.` and the edit does not happen.
- Files outside any repository (for example `~/.claude/settings.json`) and a detached HEAD never trigger it.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `branches` | string | `main,master,trunk` | Comma-separated branch names that count as "main". |
| `block` | boolean | `false` | Refuse the edit on those branches instead of only warning. |

## How it works
- One `tool.call` hook on the edit tools runs `git symbolic-ref --short -q HEAD` (3 s timeout) in the nearest existing folder of the file, so it judges the repository the file belongs to, not just the session's working directory.
- The status line is re-evaluated on each edit, the toast is shown once per session; in block mode a failing check denies the edit, in warn mode it is skipped.
- With [mods-hub](../mods-hub) installed, the one-time warning goes through the hub's notifications (`warning`, so it reaches your phone channel while you are away) instead of a toast, and in block mode every refused edit is also published as `risk.blocked` (rule `edit-on-main`, severity `low`, the path). Without the hub nothing changes.
- Limits: it only looks when Claude edits through those tools, not at edits made by `Bash` (`sed -i`, `tee`) or at what you do in another terminal.

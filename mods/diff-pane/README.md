# diff-pane
> A live pane listing changed files with +/- line counts, updated after every edit.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
`/changes` opens a **Changes** pane listing every file that differs from `HEAD` (staged or not) plus new untracked files: a status letter, the path, `+adds −dels` and a proportional `+++--` bar, with totals underneath. While the pane is open it rescans shortly after each `Edit`, `Write` or Bash call, so you watch the change set grow as Claude works. **Diff** opens a file's diff, syntax-coloured, right in the pane.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install diff-pane@claude-mods
```

## Usage
- `/changes` opens the pane (Claude Code's built-in `/diff` owns that name, so this mod uses `/changes`). With [mods-hub](../mods-hub) installed it opens the **Changes** tab of the shared Claude Mods panel instead (see How it works).
- Each row: `M` modified, `A` added, `D` deleted, `T` type change, `?` untracked; then **Copy** (puts the path on your clipboard) and **Diff** / **Hide**.
- **Refresh** rescans by hand, for changes made outside the session.

```
my-app  vs HEAD · updates after each edit  Refresh
M  src/auth.ts            +3 −1  +++-          Copy  Diff
D  src/old.ts            +0 −12  ------------  Copy  Diff
?  notes/todo.md          +3 −0  +++           Copy  Diff
3 files changed +6 −13
```

## Configuration
No configuration needed.

## How it works
- `command.run` opens the pane; a `tool.call` hook on editing tools schedules one rescan 400 ms after the last edit, and only while the pane is open (`$.ui.panes()`), so it costs nothing when closed.
- A rescan runs `git diff HEAD --numstat -z`, `--name-status -z` and `git ls-files --others --exclude-standard -z`; the first 40 untracked text files up to 256 KB are line-counted with `$.fs.read`. The result lives in session state, which redraws the pane.
- Limits: renames show as a delete plus an add, the first 100 untracked files are listed, and a diff longer than 60,000 characters is cut at a hunk boundary. Files changed by other programs appear on the next edit or **Refresh**.
- With [mods-hub](../mods-hub) installed the same view is the **Changes** tab of the shared Claude Mods panel (tab order 250; `registerTab`, drawn by hooking the hub's `claude-mods` pane when that tab is shown, beneath the hub's tab strip), `/changes` opens that tab, and the list is scanned at session start so the tab is never empty. Edits rescan while the panel shows this tab (as they do while the own pane is open). The mod reads `git.commit` from the bus: a commit made by another mod (commit-composer runs git itself) rescans at the end of the turn. [files-touched](../files-touched) draws its section of files read/edited in the same tab; whichever of the two is installed first owns the tab, and either one alone is enough. Without the hub the own pane and `/changes` are exactly as above. `turn.finished` is not read: the engine's `turn.complete` already marks the end of the turn.

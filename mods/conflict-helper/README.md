# conflict-helper
> Detects merge-conflict markers and walks you through resolving each one.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
After a `git merge`, `rebase`, `pull`, `cherry-pick`, `revert` or `stash pop` stops on conflicts, the mod says so in a toast and the status line. `/conflicts` lists each unmerged file with its number of conflict blocks, and resolves them file by file: hand the blocks to Claude with both sides spelled out, or take ours or theirs in one press. While conflicts exist the model is reminded never to write conflict markers, and any `Edit` or `Write` that would put `<<<<<<<` / `>>>>>>>` lines into a file is refused.

## Install
```
/plugin install conflict-helper --marketplace plagemes/claude-mods
```

## Usage
- Status line while conflicts exist: `conflicts: 3 files · /conflicts`.
- `/conflicts` opens the **Conflicts** pane: the operation under way (merge, rebase, cherry-pick, revert), which side is "ours" and "theirs" for it, and per file:
  - **Ask Claude** submits a prompt with every block of the file, both sides quoted with their branch labels, and precise rules: keep both intents, remove every marker, `git add` the file, do not commit.
  - **Ours** / **Theirs** runs `git checkout --ours|--theirs -- <file>` and stages it with `git add`.
- **Ask Claude to resolve all** (`a`), **Rescan** (`r`) and **Close** (`q`) sit under the list. When the last file is resolved the pane says so and a toast confirms.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `guard` | boolean | `true` | Refuse `Edit` / `Write` calls that would put conflict marker lines into a file. Turn off for repositories that keep marker lines in fixtures. |

## How it works
- A `tool.call` hook on Bash rescans after git commands that can create or clear conflicts (`git diff --name-only --diff-filter=U`, then each file is read and its blocks parsed, diff3 style included); edits to conflicted files rescan too. The operation is read from `MERGE_HEAD`, `rebase-merge` and friends.
- `prompt.compose` adds a short session section listing the conflicted files, only while there are any. The guard compares marker lines in the new text with those it replaces, so an `Edit` that removes markers block by block is allowed; a lone `=======` (a Markdown or RST underline) is never flagged.
- Limits: conflicts made outside the session appear on the next git command or **Rescan**; for delete/modify conflicts one side may not exist, in which case git's error is shown.

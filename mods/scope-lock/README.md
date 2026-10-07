# scope-lock
> /scope locks Claude to the files you name; edits outside the scope are blocked.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
`/scope src/auth/** tests/auth/` limits where Claude may write for the rest of the session. Every `Edit`, `Write` and `NotebookEdit`, and every Bash command that writes files (redirections, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git rm`/`checkout --`/`reset --hard`, …), is checked against the globs before it runs; anything outside is refused with the scope in the message, so Claude stays on task or asks you to widen it. Claude is also told the scope in its system prompt, and the status line shows `🔒 scope: src/auth/** +1`. Reading stays unrestricted.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install scope-lock@claude-mods
```

## Usage
- `/scope <glob…>` — set the scope (space- or comma-separated). `**` any depth, `*` and `?` within a name, `[ab]`, `{ts,tsx}`; a plain folder (`src/auth` or `src/auth/`) means everything under it; globs are relative to the project root unless they start with `/`.
- `/scope add <glob…>` / `/scope remove <glob…>` — widen or narrow it.
- `/scope` or `/scope show` — what is allowed now. `/scope off` — unlock.
- A refused write reads: `🔒 scope-lock: blocked Write on "src/payments/stripe.ts": it is outside the scope (src/auth/**, tests/auth/**). Keep to those files, or ask the user to widen the scope with /scope add <glob>.`
- Only you can change the scope: a `/scope` run by a plugin (or anything that is not the person) is refused.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowTemp` | boolean | `true` | Let writes to `/tmp` (and macOS temp folders) through, for logs and scratch files. |
| `blockUncheckable` | boolean | `true` | Block Bash writes whose target uses `$VARIABLES`, command substitution or a `cd` that cannot be followed. |

## How it works
- `command.run` keeps the globs in `$.state` (this session only) and sets `$.ui.status`; `prompt.compose` adds a `scope-lock:scope` section while a scope is set.
- A `tool.call` guard (with a `.catch` that refuses) resolves each target lexically against the project root, following `cd` earlier on the same command line; a glob in a shell target is checked by the folder it expands in. Subagents are held to the same scope.
- Bash commands are read with the shared claude-mods shell reader (`shared/shell`): wrappers (`sudo`, `env`, `timeout`, `xargs`) are peeled, and the scripts of `bash -c`, `su -c`, `eval`, `$(…)` and heredocs or here-strings fed to a shell are read with their own `cd`s.
- With [mods-hub](../mods-hub) installed, the scope is shared on the hub's blackboard as `scope-lock.scope` (an empty list when off), and every deny is also published as `risk.blocked` (rule `outside-scope` or `unverifiable-write`, severity `medium`, the path and command with secrets masked). Without the hub nothing changes.
- Limits: shell parsing is best effort. Writes hidden in interpreters (`python -c`, `node -e`), scripts, package managers or build tools are not seen, and paths are compared as written (symlinks are not resolved; pair it with path-jail for that).

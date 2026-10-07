# path-jail
> Allows writes only inside the project root, resolving symlinks and .. tricks.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Every `Edit`, `Write`, `MultiEdit` and `NotebookEdit` call, and every Bash command that writes a file, is checked against where the path really lands: symbolic links are followed and `..` is folded by the file system, so `out/hosts` where `out -> /etc` is caught. Writes are allowed only under the project root, `/tmp`, folders you list, and folders added with `/add-dir` or `permissions.additionalDirectories`. Anything else is refused before it runs, with the resolved path in the message.

## Install
```
/plugin install path-jail --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. A blocked write shows as the tool's error, which the model also reads:

```
path-jail: blocked rm on "../other-app": it resolves to /home/me/other-app, outside the allowed folders (/home/me/app, /tmp). Ask the user before writing elsewhere.
```

`/jail` lists the folders writes are allowed in for this session.

Bash coverage: redirections (`>`, `>>`, `&>`, `>|`), `tee`, `mv` (source and destination), `cp`, `ln`, `install`, `rsync`, `rm`, `rmdir`, `touch`, `mkdir`, `truncate`, `dd of=`, `sed -i` / `perl -i`, `chmod` / `chown`, `find -delete`, commands inside `sh -c "..."` (also `bash -lc`), `$(...)` and backticks, and commands behind `sudo -u x`, `timeout 5` or `nice -n 5`. `cd` earlier on the same line is followed; quotes, heredoc bodies and `2>&1` are read correctly.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedRoots` | string | `/tmp` | Comma-separated extra folders writes are allowed in (`~` expands to your home). |
| `blockUncheckable` | boolean | `true` | Deny Bash writes whose target uses `$VARIABLES` (other than `$HOME`, `$PWD`, `$TMPDIR`), command substitution, or a `cd` the jail cannot follow. |

## How it works
- A `tool.call` guard (with a `.catch` that denies) resolves every target with `$.fs.stat(path, { resolve: true })`; a file that does not exist yet is placed under the real path of its deepest existing folder. Roots are resolved the same way, so only real paths are compared.
- Claude Code's own plan files (`~/.claude/plans`, or under `CLAUDE_CONFIG_DIR`) and auto-memory folders (`~/.claude/projects/*/memory`, or your `autoMemoryDirectory`) stay writable, so plan mode and memory keep working.
- `classic.DirectoryAdded` records folders added with `/add-dir`; settings are re-read on every check, so a worktree move or new root takes effect at once.
- Limits: shell parsing is best effort. Writes hidden inside interpreters (`python -c`, `node -e`), `xargs`, `eval` or scripts are not seen, globs are checked by the folder they expand in, and relative Bash paths assume the session's working directory unless a `cd` precedes them on the same line.

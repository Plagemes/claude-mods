# rm-rf-guard
> Blocks catastrophic shell commands like rm -rf /, mkfs, dd to disks and chmod -R 777.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Reads every `Bash` command Claude is about to run (quotes, `sudo`/`xargs`/`timeout` wrappers, pipes, `&&`
and heredocs understood) and refuses the ones that cannot be undone: recursive `rm` of `/`, `~`, `$HOME`, `*`, `..`
or a system directory, `mkfs`, `dd of=/dev/sdX`, redirects onto a disk device, `chmod -R 777`,
recursive `chown`/`chmod` on `/`, `find / -delete`, fork bombs, and `git reset --hard` / `git clean -fd`.
Everyday cleanups (`rm -rf node_modules`, `rm -rf /tmp/x`, `git clean -n`) pass untouched.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install rm-rf-guard@claude-mods
```

## Usage
Nothing to run. A blocked command returns its reason and a safer alternative:

```
rm-rf-guard: blocked, recursive rm of "~" would wipe a home, system or whole working directory.
Instead: delete the specific paths (rm -rf ./build) or move them to a trash folder.
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowGitReset` | boolean | `false` | Let Claude run `git reset --hard` and `git clean -fd`/`-fdx`. Everything else stays blocked. |

## How it works
- One `tool.call` guard on `Bash`; the shared claude-mods shell reader (`shared/shell`, the same one every guard uses) splits the line into commands, so `echo "rm -rf /"`, `grep "rm -rf" docs/` and a `cat <<EOF` note are not mistaken for the real thing.
- It fails closed: if the check itself throws, the command is denied.
- Command strings handed to another shell (`bash -c "…"`, `sudo sh -lc '…'`, `su -c '…'`, `eval "…"`, `$(…)`, a heredoc fed to `bash`) are checked too.
- With [mods-hub](../mods-hub) installed, every deny is also published as `risk.blocked` (rule, reason, severity `high`, the command with secrets masked and cut to 200 characters), so guardian, audit-trail and permission-log see it. It consumes nothing; without the hub it behaves exactly the same.
- Limits: it reads the text of the command. A script that does the deleting (`./cleanup.sh`), text piped into a shell (`echo … | sh`), `$VAR` that expands to `/`, or an alias is not seen.

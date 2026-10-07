# rm-rf-guard
> Blocks catastrophic shell commands like rm -rf /, mkfs, dd to disks and chmod -R 777.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Reads every `Bash` command Claude is about to run (whitespace normalised, quotes and `sudo`/pipes/`&&`
understood) and refuses the ones that cannot be undone: recursive `rm` of `/`, `~`, `$HOME`, `*`, `..`
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
- One `tool.call` guard on `Bash`; a small shell lexer splits the line into commands, so `echo "rm -rf /"` and `grep "rm -rf" docs/` are not mistaken for the real thing.
- It fails closed: if the check itself throws, the command is denied.
- Command strings handed to another shell (`bash -c "…"`, `sudo sh -lc '…'`, `eval "…"`) are checked too.
- Limits: it reads the text of the command. A script that does the deleting (`./cleanup.sh`), text piped into a shell (`echo … | sh`), `$VAR` that expands to `/`, or an alias is not seen.

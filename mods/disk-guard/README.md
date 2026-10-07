# disk-guard
> Warns when the disk is nearly full before builds, installs and docker pulls.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
Before a Bash command that writes a lot (a dependency install, a build, `docker build`/`pull`, `cargo build`, `git clone`, `apt`/`brew install`), disk-guard checks the free space under the working directory with `df -Pk .`. If less than 2 GB is free, or the disk is more than 95% used, you get a toast and Claude gets a note with where to look for the space. If a command fails with "No space left on device", Claude gets a note even when the command was not one of the heavy ones.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install disk-guard@claude-mods
```

## Usage
Nothing to run. A warning looks like this:

```
disk nearly full: only 1.4 GB free of 100.0 GB on /home (99% used)
try: du -sh node_modules ~/.cache | sort -h, docker system df
```

Claude is told the same, plus two suggestions it can act on: the `du` command above for the big folders, and `docker system df` for Docker's share (`docker system prune` only with your OK). The mod never deletes anything itself, and never blocks the command.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `minFreeGb` | number | `2` | Warn when less than this many gigabytes are free. |
| `maxUsedPercent` | number | `95` | Warn when the disk is fuller than this, however much is free (so a 2 TB disk at 96% also warns). 100 turns this check off. |

## How it works
- Hooks `tool.call` on `Bash`. For a heavy command it runs `df -Pk .` (5 s timeout) in the session's directory and reads the last line; the result is cached for 60 seconds per directory, and the toast shows at most once per fresh reading while the note goes with every heavy command.
- After the command it looks for `No space left on device`, `ENOSPC` or `Disk quota exceeded` in a failed result and, if found, reads `df` again and adds a note.
- Limits: it measures the disk of the working directory, not of wherever a command writes (`docker` stores images elsewhere, `/tmp` may be another disk). Heavy commands are recognised by pattern, so a script that installs things behind another name is not. Without a `df` binary (a plain Windows shell) it stays silent.

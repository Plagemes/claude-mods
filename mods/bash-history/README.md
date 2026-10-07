# bash-history
> /bash-history lists recent shell commands Claude ran, with exit status and duration.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Keeps a running record of every Bash command Claude runs in the session: the command, whether it succeeded, failed or was refused, and how long the call took. `/bash-history` prints the last 30 as a compact table, newest at the bottom, so you can see at a glance what Claude has actually executed.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install bash-history@claude-mods
```

## Usage
```
/bash-history        the last 30 commands
/bash-history 100    the last 100 (up to 200 are kept)
```
Output looks like:
```
Last 3 of 3 shell commands (newest last)

14:02:11  ok       400ms  git status
14:02:15  FAILED   12.5s  npm test
14:03:00  denied     5ms  rm -rf /
```
Multi-line commands are flattened to one line and long ones are cut.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `Bash`, times the call with `$.clock` and keeps the last 200 entries in `$.state`, so the history survives a plugin reload but not a new session.
- `ok` is a command whose tool call succeeded, `FAILED` one that reported an error (a non-zero exit), `denied` one a guard refused.
- Registers `/bash-history` at session start.
- Limits: the duration is the length of the tool call, so a background command (`run_in_background`) shows only the time to launch it.

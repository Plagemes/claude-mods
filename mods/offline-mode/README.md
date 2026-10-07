# offline-mode
> /offline blocks every network call — fetches, curl, installs, git push — until you turn it back on.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
`/offline on` switches the session to offline mode: Claude can no longer use WebFetch or WebSearch, and Bash commands that need the network are refused before they run: `curl` and `wget`, package installs (`npm install`, `pnpm add`, `pip install`, `cargo install`, `brew install`, ...), `git push`, `pull`, `fetch` and `clone`, `ssh` and `scp`, `docker pull`, cloud CLIs and so on. A status line `✈ offline` stays on until `/offline off`. Handy on a plane, on a metered connection, or when you want to be sure nothing leaves the machine.

## Install
```
/plugin install offline-mode --marketplace plagemes/claude-mods
```

## Usage
```
/offline on        block the network
/offline off       back online
/offline toggle    flip it
/offline           show where things stand
```
Claude is told when you switch it, and every blocked call is answered with `offline-mode: offline mode is on, so git push is blocked. Work without network access, using what is already on disk. Ask the user to run /offline off if the network is needed.` plus a toast, so it stops trying. Only you can change the mode: the command is refused when it does not come from you.

Not blocked: `curl`/`wget`/httpie calls whose every target is this machine (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`), installs run with `--offline`, `--no-index` or `--local`, `git clone` of a local path, and everything that merely mentions a network command (`echo`, `grep`, `command -v curl`, `curl --version`).

## Configuration
No configuration needed.

## How it works
- The on/off flag lives in `$.state`; `/offline` also sets and clears the status line. Hooks `tool.call` for `WebFetch`, `WebSearch` and `Bash`. The shell command is split into words (quotes, `&&`, `|`, `;`), looked through `sudo`, `env VAR=x`, `time`, `timeout` and `xargs`, and read inside `bash -c "..."`, `eval`, `$(...)` and backticks.
- It is a guard with a `.catch`: if it cannot read its state it refuses the call rather than let the network through.
- Limits: it judges commands by their words, so a script, a Makefile, `npm run`, `npx`, an IDE task or a program that makes its own requests can still reach the network, and `curl "$URL"` (a target that cannot be read) is treated as external. It stops Claude's tools, not your machine.

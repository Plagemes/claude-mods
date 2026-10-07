# cheatsheet
> /cheat shows a quick reference for git, docker, regex, tmux and more, offline.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
Ten embedded cheat sheets (git, docker, regex, tmux, vim, bash, sql, curl, kubectl, npm), each 40 to 70 lines of commands with a few words on what they do, grouped by section. `/cheat <topic>` prints a whole sheet, extra words filter it down to the lines you want, and words that are not a topic search every sheet at once. Everything is built in: no network, no model call.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install cheatsheet@claude-mods
```

## Usage
```
/cheat                    list the topics
/cheat git                the whole git sheet
/cheat git stash          only the lines about stash
/cheat docker compose     the Compose section of the docker sheet
/cheat k8s rollout undo   aliases work: k8s, kube, postgres, shell, regexp, nvim ...
/cheat prune              search every sheet: docker system prune, git fetch --prune, npm prune
```
A word has to appear in the line itself, or in the title of its section, so `/cheat tmux pane` shows the whole Panes section. A search over all sheets is capped at 50 lines and says how many it left out.

## Configuration
No configuration needed.

## How it works
- Registers `/cheat` at session start and answers it from `command.run`. Each sheet is a Markdown string in its own module (`## Section` headings, command lines as 4-space-indented code), so a sheet is easy to read, fix or extend.
- A pure module parses the Markdown, filters by words (all must match, case-insensitive) and renders the answer; both it and the sheets are covered by the mod's tests, including a format check on every line.
- Limits: the sheets are deliberately short (the 80% you use daily, not the manual); they describe common GNU/Linux and recent tool versions, and say so where a command differs (`sed -i` on macOS, `curl --json` needs 7.82+, `FULL OUTER JOIN` in MySQL).

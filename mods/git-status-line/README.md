# git-status-line
> Shows the current branch, ahead/behind and dirty file count in the status line.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Keeps one line under the prompt that always tells you where the repository stands, so you can see what Claude
just did to it without asking: the branch, how far it is ahead of and behind its upstream, and how many files are
modified, staged or untracked. Outside a git repository it shows nothing.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install git-status-line@claude-mods
```

## Usage
The status line reads like this:

```
⎇ feat/login ↑2 ↓0 ●3     branch, 2 ahead, 0 behind, 3 dirty files
⎇ main ↑0 ↓1 ✓            clean, one commit behind
⎇ (a1b2c3d) ●1           detached HEAD
⎇ scratch ✓               no upstream: no arrows
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `debounceMs` | number | `600` | After a tool call, wait this long for more activity before running `git status` once. |
| `showUntracked` | boolean | `true` | Count untracked files in the dirty number. Turn off where `git status` is slow. |

## How it works
- `session.start` and every `Bash`, `Edit`, `Write` or `NotebookEdit` call schedule a refresh with `$.clock.after`; a newer call replaces the pending one, so a burst of tool calls costs a single `git --no-optional-locks status --porcelain=v2 --branch` (5 s timeout, no index lock taken).
- The line is only rewritten when its text changes. A failed or non-git `status` clears it.
- Limits: it refreshes after Claude's tool calls, not when you change the repository from another terminal; the next tool call picks it up.

# pair-mode
> Claude proposes, you type: edits become diffs you apply yourself, for deliberate practice.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
`/pair on` turns Claude into a pairing partner who never touches the keyboard: its file edits are refused, and it presents every change as a unified diff for you to type in yourself. When you have applied a change, `/pair check` sends exactly what you typed to Claude for review, so you learn the codebase by changing it with your own hands.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install pair-mode@claude-mods
```

## Usage
- `/pair on` · `/pair off` · `/pair` toggles.
- `/pair check` diffs your working tree against the moment pair mode started (or your last check) and asks Claude to review it: bugs, typos, missed cases, and how it compares with what it proposed.
- While on, a band sits above the prompt:

```
⌨ Pair mode: you drive · Claude proposes diffs, you type them   c: Check my changes   o: Off
```

- When Claude tries to edit, it is told to answer with a ```` ```diff ```` block instead (`--- a/path`, `+++ b/path`, `@@` hunks) that you apply yourself.

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `startOn` | `false` | Start every session in pair mode. |
| `guardShell` | `true` | Also block shell commands that write files while pair mode is on. |

## How it works
- `tool.call` refuses `Edit`, `Write` and `NotebookEdit` (and, with `guardShell`, Bash commands that look like they write files: `sed -i`, `>` redirections, `tee`, `rm`/`mv`/`cp`, `git apply`, formatters with `--write`/`--fix`, inline scripts calling `writeFileSync`/`open(..., 'w')`), with a message telling Claude to show a diff; read-only commands and tests still run. `prompt.compose` adds a short section explaining pair mode while it is on.
- Checks snapshot the whole worktree (untracked files included, ignored ones not) as a git tree built in the mod's own index file under `.git/`, so your staging area is never touched; the diff between two snapshots goes to Claude as a note only it reads, and your prompt stays one line.
- Limits: the shell guard is a best-effort pattern match, not a sandbox; `/pair check` needs a git repository; diffs over 40,000 characters are cut at a file boundary.
- With [mods-hub](../mods-hub) installed it only says hello (it publishes and consumes nothing). Shell commands are read with the shared shell reader (`shared/shell.ts`), which opens `bash -c`, `eval` and `$(...)` and peels wrappers such as `sudo`, `env` and `timeout`; it blocks everything the previous reader did and also commands inside `if`/`for` bodies and `env`/`su -c` launches. A quoted redirection target is now named in the refusal (`a redirection to out.txt`).

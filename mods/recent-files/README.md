# recent-files
> /recent lists the files read and edited in this session, newest first.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Keeps a running list of every file Claude has read, edited or written in the session (including files touched by subagents), and shows it with `/recent`. Handy when you come back to a long session and want to know where Claude has been, or which files to review before committing.

## Install
```
/plugin install recent-files --marketplace plagemes/claude-mods
```

## Usage
`/recent` prints the list, newest first, with `R` (read) and `E` (edited or written) markers and paths relative to the project root:

```
Recent files, newest first (R = read, E = edited or written), 3 of 3:
   E  src/new.ts
  RE  src/auth.ts
  R   README.md
```
`/recent 10` shows only the newest ten. `/clear` empties the list.

## Configuration
No configuration needed.

## How it works
- A `tool.call` hook notes the file path of `Read`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit` calls once they succeed; a failed or refused call is not recorded.
- The list is de-duplicated (a file moves to the top when touched again) and capped at 50 files; it lives in `$.state`, so a hot reload of the mod keeps it.
- Only the file tools are tracked: files changed by a Bash command (`sed -i`, a formatter, `git checkout`) do not appear.

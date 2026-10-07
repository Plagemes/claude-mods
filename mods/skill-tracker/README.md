# skill-tracker
> Tracks which languages and tools you've worked with each week.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
Every time Claude successfully edits or writes a file, skill-tracker counts the file's language (from its extension or name: TypeScript, Python, Go, Dockerfile, ...). Every successful shell command counts the tools it ran (git, docker, kubectl, npm, cargo, ...). The counts are kept per ISO week, so you can see what you actually worked with this week and over the last two months.

## Install
```
/plugin install skill-tracker --marketplace plagemes/claude-mods
```

## Usage
```
/my-skills
```
(Claude Code already has a built-in `/skills`, so this one is `/my-skills`.) It prints this week with text bars, the last 8 weeks added together, and a line per week:

```
This week (2026-W41)

Languages (edits)
  TypeScript  ████████████████████  34
  Python      ████████              14

Tools (commands)
  git  ████████████████████  22
  npm  █████████             10

Last 8 weeks (2026-W34 to 2026-W41)
...
By week
  2026-W40  20 edits · 9 commands · TypeScript / npm, git
  2026-W41  48 edits · 32 commands · TypeScript, Python / git, npm
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `topCount` | number | `6` | How many languages and how many tools are listed. |

## How it works
- A `tool.call` hook on `Edit`, `MultiEdit`, `Write`, `NotebookEdit` and `Bash` counts what succeeded (a failed or refused call counts nothing; subagents' calls count too). Languages come from a built-in extension table; tools are the first word of each simple command (after `sudo`, `VAR=x` and the like) when it is on a list of about 80 well-known commands, so `ls` and `grep` are not counted.
- Counts are collected in memory and written to `$.store` at the end of each turn and when the session ends, one entry per ISO week (Monday first); the newest 60 weeks are kept. If the store cannot be written the counts wait for the next flush.
- Limits: it counts calls, not lines or time; files Claude did not touch (edits you made yourself) and tools run with `!` shell mode are not seen; weeks follow your local calendar.

# idle-nudge
> Reminds you about uncommitted changes after a stretch of inactivity.

**Category:** Productivity · **Version:** 1.0.0

## What it does
If you step away from a session with work uncommitted, a toast reminds you when you are back in view: `idle-nudge: you have 3 uncommitted files (idle 24 min)`. It only speaks when the working tree has changes, only once per idle stretch, and never while Claude is still working on a turn.

## Install
```
/plugin install idle-nudge --marketplace plagemes/claude-mods
```

## Usage
Nothing to do. The clock restarts whenever you send a prompt or a turn starts or finishes. After 20 minutes without any of those, the next check that finds uncommitted files raises the toast (it stays up for 30 seconds); after that it is silent until you send another prompt.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `idleMinutes` | `20` | Minutes of inactivity before the reminder. |

## How it works
- A timer started at `session.start` ticks every 60 seconds; `prompt.submit`, `turn.start` and `turn.complete` hooks record activity.
- When the idle time is up it runs `git status --porcelain` (5 second timeout) and counts the lines; untracked files count. Outside a git repository, or if git fails, it stays silent.
- Timers do not survive a hot reload of the mod; they start again with the next session.

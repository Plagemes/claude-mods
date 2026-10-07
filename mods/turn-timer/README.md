# turn-timer
> Times every turn and tells you when one runs long.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Measures how long each turn takes, from your prompt to Claude's final answer, and keeps a running average for the session. A turn that runs past a threshold (two minutes by default) raises a toast, so you can look away while Claude works and still find out when it was a long one.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install turn-timer@claude-mods
```

## Usage
- Status line after every turn: `last 34s · avg 21s` (durations over a minute read `2m 05s`, over an hour `1h 02m`).
- Toast when a turn exceeds the threshold: `That turn took 2m 05s`.
- Interrupted turns and subagent turns are not counted. `/clear` resets the average.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `thresholdSeconds` | `120` | Toast when a turn takes longer than this many seconds. `0` turns the toast off. |

## How it works
- Hooks `turn.complete` and reads its `durationMs`, the engine's own wall-clock length of the turn, so no start time has to be tracked and a prompt queued behind a running turn is not over-counted.
- Totals live in `$.state` (a hot reload keeps them) and are shown with `$.ui.status`.
- The toast fires when the turn ends, not while it is still running.

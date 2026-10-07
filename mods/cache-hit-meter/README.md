# cache-hit-meter
> Shows what share of input tokens came from the prompt cache.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
After every turn it works out which share of the input tokens was served from the prompt cache (`cache read / (uncached + cache read + cache written)`) and keeps a running figure for the whole session. A healthy session sits well above 80%; a low figure means you are paying full price for context the model has already seen.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install cache-hit-meter@claude-mods
```

## Usage
- The status line shows `cache 87%` after the first turn, then `cache 79% · last 91%` (session share, then the last turn).
- If the session share is under 30% once 5 turns have passed, one toast says so. It does not repeat.
- `/clear` resets the counters.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `warnBelow` | `30` | Toast when the session cache share is under this percentage. |
| `afterTurns` | `5` | Turns the session needs before the toast can fire. |

## How it works
- Hooks `turn.complete` and reads the turn's `usage` (the four token counts of every request of the turn, summed).
- Totals live in `$.state`, so a hot reload of the mod keeps them; the status line is `$.ui.status`.
- Only the main conversation counts: subagent turns run on their own context and are ignored. A turn the API reported no usage for (an interrupt) is skipped.

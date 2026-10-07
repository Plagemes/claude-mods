# session-stats
> /session-stats shows a dashboard of turns, tools, tokens, cost, duration and files.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
session-stats tallies the session as it goes: prompts and turns, every tool call by type, the tokens of every model request (subagents included), the cost, the wall-clock time and the files Claude changed. The dashboard pane shows it all as tiles, with a bar chart of the five tools Claude reaches for most.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install session-stats@claude-mods
```

## Usage
`/session-stats` opens the dashboard. Current Claude Code ships `/stats` as an alias of its built-in `/usage` and won't let a plugin take that name. session-stats claims `/stats` only where it's free, so `/session-stats` always works.

```
╭ Turns ─────────────╮ ╭ Tool calls ────────╮ ╭ Tokens ────────────────╮
│ 12                 │ │ 148                │ │ 2.4M                   │
│ 15 prompts         │ │ 3 failed           │ │ in 45k · out 120k      │
╰────────────────────╯ ╰────────────────────╯ │ cache 2.1M read · 90k… │
╭ Cost ──────────────╮ ╭ Wall time ─────────╮ ╭ Files edited ──────────╮
│ $4.12              │ │ 1h 12m             │ │ 9                      │
│ as /usage counts it│ │ 18m 40s in turns   │ │ last app.ts            │
╰────────────────────╯ ╰────────────────────╯ ╰────────────────────────╯
Top tools
Bash             ██████████████████████████ 64
Read             ███████████████ 37
Edit             ██████████ 25
```

The dashboard refreshes after every turn. **Refresh** (hotkey `r`) updates the cost and the clock in between.

## Configuration
No configuration needed.

## How it works
- Hooks `prompt.submit` (prompts), `tool.call` (calls by tool, failures, files changed by Edit, Write, MultiEdit and NotebookEdit) and `turn.complete` (main-loop turns and their duration, plus every loop's token usage). Everything is summed in `$.state`.
- Cost and session start come from `$.session.usage()`, the same figures `/usage` shows. Cost reads `—` where the host keeps no cost ledger.
- Limits:
  - A `/clear` starts the tallies over.
  - Calls a permission denial stopped aren't counted.
  - The figures cover this session only.
- With [mods-hub](../mods-hub) installed the same dashboard is the **Stats** tab of the shared Claude Mods panel (tab order 290; `registerTab`, drawn by hooking the hub's `claude-mods` pane while that tab is shown) and `/session-stats` opens it. It also reads the hub's bus a moment after each turn (`recent` since the last look) and adds: a **Tests** tile from `test.result` (runs, the last one in words, how many did not pass), the average tool calls per turn from `turn.finished`, and from `cost.update` the last turn's cost and, where the engine keeps no cost ledger (the tile reads `—` without the hub), the session cost as the hub prices it (`~` when the model was a guess). The mod publishes nothing and does not vendor a price table of its own: the hub's `cost.update` already carries the priced figure. Without the hub the tiles are exactly as above.

# tool-timeline
> A timeline pane of every tool call with duration, status and input summary.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
tool-timeline records every tool call of the session: when it started, how long it took, how it ended and what it was about. Subagents' calls are included. `/timeline` opens a pane that lists the calls with duration bars and follows the newest one, so you can see what's slow, what failed and what Claude is doing right now.

## Install
```
/plugin install tool-timeline --marketplace plagemes/claude-mods
```

## Usage
`/timeline` opens the pane:

```
12 calls  1 failed  1 running  48s in tools          [ Errors only ] [ Latest ] [ Clear ]

+00:00 ✓ Read             ▍              20ms src/app.ts
+00:02 ✗ Bash             ████████▋      1.5s npm test
+00:05 ⊘ Write            ▏              12ms src/b.ts
+00:09 ◌ Bash                               … npm run build
```

Each row shows:
- the start time since the session began
- the status: ✓ ok, ✗ error, ⊘ denied, ◌ running
- the tool, with MCP tools shown as `server:tool`
- a log-scaled duration bar, so short reads and long builds both show
- the duration and the call's subject (command, path, pattern, URL, query…); subagent calls are marked `↳`

Buttons:
- **Errors only** (hotkey `e`) hides the calls that went through.
- **Latest** (`l`) jumps back to the newest call after you scroll up.
- **Clear** (`c`) empties the list.

Narrow panes drop the time column and shorten the bars.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` around every call, timing it with `$.clock.now()`. It keeps the newest 300 calls in `$.state`, so the pane redraws as calls start and finish.
- Opening the pane scrolls it to the end with `$.ui.scroll`. The engine then keeps the newest row in view until you scroll yourself.
- A `/clear` empties the timeline. Limit: the list lasts for the session only and isn't saved.

# activity-heatmap
> A heat map of when you use Claude Code, by hour and weekday.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Counts every prompt you send, across all your sessions and projects, into a weekday × hour grid. `/heatmap` draws that grid as a 7×24 heat map with per-day totals, a legend and your busiest slot, day and hour, so you can see when you actually do your Claude Code work.

## Install
```
/plugin install activity-heatmap --marketplace plagemes/claude-mods
```

## Usage
- `/heatmap` opens the **Activity** pane:
  ```
      0     3     6     9     12    15    18    21
  Mon ··················▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒··········  80
  Tue ··················▒▒▒▒▓▓▓▓████▓▓▓▓▒▒▒▒··········  90
     less · ░ ▒ ▓ █ more · peak 15 in one hour
  Busiest slot  Fri 13:00 (15)
  ```
  On the terminal the grid is one colored `Raster`; on the desktop app and other surfaces it is a colored text grid. Each level has its own glyph as well as its own color, so it reads in monochrome too.
- `/heatmap reset` asks for confirmation, then erases the history.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `weekStart` | `monday` \| `sunday` | `monday` | The weekday shown on the first row. |

## How it works
- A `prompt.submit` hook counts each prompt that enters the session from you (typed, from a remote client or the desktop app); prompts sent by plugins, background-task notifications and other agents are not counted. Slash commands are not prompts and are not counted.
- Counts live in the mod's `$.store` (a small JSON file in your Claude Code config directory), so they add up across sessions; nothing leaves your machine.
- Hours and weekdays use the local time of the machine running Claude Code.

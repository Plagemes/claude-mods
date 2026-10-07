# daily-spend
> Tracks spend per day and week across sessions with a /spend report.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Prices every turn from the token usage the engine reports and adds it to a running total per day and per project, kept across sessions. `/spend` opens a pane with today, this week (from Monday) and the last 14 days, a bar chart of those 14 days and the projects that cost the most. An optional daily limit raises a toast the first time a day goes past it.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install daily-spend@claude-mods
```

## Usage
- `/spend` prints `Today $3.50 · this week $7.50` and opens the **Spend** pane:
  - Today / This week / 14 days, with the average per day.
  - Last 14 days: a colour bar chart on the terminal (today in orange, days over the limit in red), one bar row per day on the desktop app, plus the peak day.
  - Top projects: the five project roots that spent most in those 14 days.
- **Refresh** (`r`) re-reads the totals, picking up what other sessions spent; **Close** closes the pane.
- With a daily limit set: `Today's spend $21.30 passed your $20.00 daily limit.` (once a day, across sessions).
- With [mods-hub](../mods-hub) installed, `/spend` opens the **Cost** tab of the shared Claude Mods panel instead of its own pane (same view, without Close).

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `dailyLimit` | `0` | Dollars per day (all sessions) after which a toast warns you. `0` turns it off. |

## How it works
- `turn.complete` prices the turn (main loop and subagents) and adds it to `$.store` under the local date and `$.session.root()`; days older than 120 are dropped at session start.
- The pane is a `ui.render` hook on `Pane`, drawn from a snapshot in `$.state`: a `Raster` chart on the terminal, text bars on other surfaces.
- With mods-hub installed: the view becomes the panel's **Cost** tab (`registerTab`, drawn by hooking the hub's `claude-mods` pane when that tab is shown); passing the daily limit is published as `budget.threshold` (scope `day`, to every session) and sent as a warning through the hub's notifications, which reach your phone channel while you are away; today's total is shared as the fact `daily-spend.today`. Without the hub, it keeps its own pane and toast.
- Prices come from the table every Claude Mod shares (`shared/prices.ts`). Figures are API list-price estimates (cache writes at the 5-minute rate; unknown models priced as Opus 5.5), not a bill: Bedrock, Vertex and Pro/Max plans are billed differently. Two sessions finishing a turn at the very same moment can overwrite each other's update of that day.

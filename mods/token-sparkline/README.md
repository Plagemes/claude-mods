# token-sparkline
> A sparkline of tokens per turn right above the prompt.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
After every turn, the tokens it used are added to a one-line chart in the band just above the prompt, together with the last, average and largest turn. It covers the last 40 turns of the session, so a turn that suddenly reads a whole directory or balloons the context stands out at a glance.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install token-sparkline@claude-mods
```

## Usage
The band appears after the first turn:
```
tokens/turn ▂▃▂▅▃▂█▃▄ last 31.2k · avg 22.4k · max 88.0k  Hide
```
- On the terminal the line is a colored `Raster` (the newest turn in amber); on the desktop app it is drawn with `▁▂▃▄▅▆▇█` characters.
- **Hide** removes the band and remembers that across sessions. `/sparkline` toggles it back; `/sparkline show`, `/sparkline hide` and `/sparkline reset` (clears the line) do what they say.
- The band steps aside while a survey uses it.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `metric` | `total` \| `input` \| `output` | `total` | What a point counts. `input` is every token the turn's requests read, cached ones included; `output` is what the model wrote; `total` is both. |

## How it works
- A `turn.complete` hook reads the turn's `usage` (summed over its API requests) and keeps the last 40 values in session state; subagents' turns and turns with no usage (an interrupt, an API error) are skipped.
- A `ui.render` hook on `AbovePrompt` draws the line sized to the band's width and hands the rest of the band to whatever else draws there.
- Limits: the line starts empty in each new session; prompt-cache reads make `total` and `input` much larger than what is billed at full price.
- With [mods-hub](../mods-hub) installed the band also shows what the last turn cost, read from the hub's `cost.update` (the shared price table, `~` when the model was priced as a guess): `… max 88.0k · $0.42`. The figure is read while drawing, so the band redraws when the hub prices the next turn. Without the hub the band shows tokens only.

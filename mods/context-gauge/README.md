# context-gauge
> A slim band above the prompt showing how full the context window is.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Draws a one-line band above the prompt with a 20-cell bar, the percentage of the context window in use and the token count (`context ████████░░░░░░░░░░░░ 40% 80k/200k`). The bar is green, turns yellow from 60% and red above 75%, where it also suggests `/compact`. A Hide button removes the band.

## Install
```
/plugin install context-gauge --marketplace plagemes/claude-mods
```

## Usage
- The band appears above the prompt after the first model response of the session.
- Press **Hide** (or run `/context-gauge`) to hide it; run `/context-gauge` again to bring it back.
- After `/compact` or `/clear` the band disappears until the next response gives a fresh reading.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `warnAt` | `60` | Percentage at which the bar turns yellow. |
| `alertAt` | `75` | Percentage above which the bar turns red and `/compact` is suggested. |

## How it works
- Hooks `session.measure`, which the engine raises after every turn with the live context fill, so the figure is the one the status line shows rather than a sum of per-turn usage.
- Draws through a `ui.render` hook on the `AbovePrompt` band; the state lives in `$.state`, so a hot reload keeps it.
- The band stays out of the way while a survey holds the band, and draws nothing until the engine has reported a fill.

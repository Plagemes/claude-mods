# token-budget
> Set a token or dollar budget per session; get warned at 80% and stopped at 100%.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Adds up what every turn of the session costs, from the real token usage the engine reports, and prices it per model at Anthropic's API list prices. At 80% of the budget a toast and a band above the prompt show what is left; at 100% new prompts are paused until you raise the budget or send one anyway with `!override`. Works out of the box with a $10 budget per session.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install token-budget@claude-mods
```

## Usage
- `/budget` shows the spend so far, e.g. `42% used · $4.21 of $10.00 · 610k tokens · 12 turns`.
- `/budget set 5` (or `$5`) sets a dollar budget for this session; `/budget set 2M tokens` (or `500k`) sets a token budget. Both can be active; the first one reached counts.
- `/budget off` drops the limits for the rest of the session; `/budget reset` zeroes the counter.
- Band at 80%: `▲ budget 84% ████████████░░░░ $1.60 left of $10.00` with **Raise 50%** and **Hide** buttons (ctrl+x tab focuses the band, then `r` / `h`).
- At 100% a prompt is refused with `token-budget: the session budget is spent ...`. Start it with `!override` to send it anyway (the prefix is removed before Claude sees it). Slash commands keep working.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `budgetUsd` | `10` | Estimated dollars per session before prompts pause. `0` turns the dollar limit off. |
| `budgetTokens` | `0` | Input, output and cache-write tokens per session before prompts pause. `0` turns it off. |
| `warnAt` | `80` | Share of the budget (%) that triggers the toast and the band. |

## How it works
- `turn.complete` adds each turn's usage (main loop and subagents) to a counter in `$.state`; `prompt.submit` drops new prompts once a limit is reached; a `ui.render` hook on `AbovePrompt` draws the band.
- Prices are API list rates per model family (cache writes at the 5-minute rate); on Bedrock, Vertex or a Pro/Max plan the figure is an API-equivalent estimate, not your bill. Unknown model ids are priced as Opus 5.5.
- The budget is checked when a prompt is sent, so the turn that crosses it runs to its end. Cache reads count toward dollars but not toward the token limit. The counter lives for the session and is not carried into a resumed one.

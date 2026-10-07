# cost-meter
> Live session cost estimate in the status line, from real token usage.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
After every completed turn (the main conversation and each subagent) cost-meter reads the real token usage the
API reported (input, output, cache reads, cache writes) and the model that answered, prices it per million tokens
by model family, adds it to a running total kept in `$.state`, and shows the total in the status line:
`$0.42 · 128k tok`. `/cost-reset` zeroes the counters.

The figure is an estimate: it prices what the turns reported, at list prices and the 5-minute cache-write rate.
It does not include side requests the engine makes outside turns, and it is not your invoice. `~` in front
(`~$0.42`) means a turn ran on a model the table does not know and was priced as an Opus 5.5 (the default model).

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install cost-meter@claude-mods
```

## Usage
- Status line: `$0.42 · 128k tok`, `<$0.01 · 120 tok`, `$20.00 · 2.0M tok`. The token count adds up input, output, cache reads and cache writes.
- `/cost-reset` starts the meter over and tells you what it read before (`Counters reset (they read $0.42 · 128k tok).`).
- The counters live for the session in this process: they survive a plugin reload, not a restart or `--resume`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `pricing` | string | empty | JSON override of the price table, USD per million tokens, keyed by a model-id fragment: `{"opus":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}}`. `cacheRead`/`cacheWrite` default to 0.1x/1.25x input. Invalid JSON is ignored. |
| `showTokens` | boolean | `true` | Show the token count after the cost. |

Built-in table (USD per million tokens: input / output / cache read / cache write), the one every Claude Mod shares
(`shared/prices.ts`), first match in the model id wins: `fable-5-1` and `mythos-5-1` 10 / 50 / 0.25 / 12.5,
`fable` and `mythos` 10 / 50 / 1 / 12.5, `opus-5-5` 4 / 20 / 0.2 / 5, legacy `opus-4-0`/`opus-4-1`/`3-opus` 15 / 75 / 1.5 / 18.75,
`opus` 5 / 25 / 0.5 / 6.25, `sonnet-5` 2 / 10 / 0.2 / 2.5, `sonnet` 3 / 15 / 0.3 / 3.75, `3-5-haiku` 0.8 / 4 / 0.08 / 1,
`3-haiku` 0.25 / 1.25 / 0.03 / 0.3125, `haiku` 1 / 5 / 0.1 / 1.25; anything else is priced as Opus 5.5.
Prices change: check them against the pricing page and override what is out of date.

## How it works
- `turn.complete` reads `e.usage` (the four token counts and the `model`), prices it, and adds to `cost-meter.spend` in `$.state` with a versioned update; `$.ui.status` shows the total.
- `session.start` registers `/cost-reset` and shows the current total; `command.run` answers it.
- Limits: a turn that was interrupted or hit an API error reports no usage and is not counted; cache writes cannot be split by TTL, so 1-hour writes are priced low.
- With [mods-hub](../mods-hub) installed, cost-meter says hello on the hub's bus. It keeps its own total rather than reading the hub's `cost.update`: both price with the same shared table, and cost-meter also counts subagent turns and your `pricing` overrides. Without the hub nothing changes.

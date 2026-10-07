# error-buzz
> A short buzz when a command or test run fails.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
When a Bash command Claude runs fails, error-buzz plays a short low buzz so you notice without watching the terminal. It also catches test runners (jest, vitest, pytest, go test, cargo test, npm test and friends) that print failures yet exit 0. A cooldown keeps a burst of failures down to one buzz.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install error-buzz@claude-mods
```

## Usage
Nothing to run. A failing command or test run buzzes once; the next buzz waits for the cooldown (10 seconds by default).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `cooldownSeconds` | number | `10` | Minimum time between two buzzes. |
| `onlyTests` | boolean | `false` | Buzz only for failing test-runner commands, not for every failing command. |

## How it works
- Hooks `tool.call` for Bash and looks at the result after the command ran: an errored result (non-zero exit), or a test-runner command whose output reports failures.
- Plays the bundled `assets/buzz.wav` with `$.audio.play`, which uses `afplay` on macOS only; on Linux and Windows terminals nothing is played.
- It only observes: the result goes back to Claude untouched and the sound never delays it.
- With **mods-hub** installed it consumes the hub's events instead of re-reading the output: for a test run the verdict is the hub's `test.result` for that very call (matched by time and command; a run the hub did not see, or a `test.result` from another run, is ignored), and a command the hub reports as `error.repeated` (the same command failed three times) buzzes once even inside the cooldown. The hub publishes both just after the tool returns, so the buzz comes about a quarter of a second later. Without the hub, or when it has no event for the call, the output is read here as before, with `shared/test-runners` deciding what a test run is and what its summary says.

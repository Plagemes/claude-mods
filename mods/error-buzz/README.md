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

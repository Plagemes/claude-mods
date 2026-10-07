# celebrate
> Celebrates when failing tests go green again.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Watches the test commands Claude runs (jest, vitest, pytest, mocha, rspec, go test, cargo test, npm/yarn/pnpm test and more). When a runner that failed earlier in the session passes again, you get a `🎉 All green` toast and a short fanfare. Runs that were never red, and repeated passes, stay quiet.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install celebrate@claude-mods
```

## Usage
Nothing to run. After Claude fixes a failing suite and the rerun passes you see `🎉 All green: vitest passes again`. Each runner is tracked on its own, so a pytest failure is only celebrated by a later pytest pass.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `sound` | boolean | `true` | Play the bundled fanfare (`assets/celebrate.wav`) with the toast. |

## How it works
- Hooks `tool.call` for Bash. A run counts as failed when the command errored, or when its output reports failures although it exited 0 (for example `npm test | tail`).
- State lives in memory for the session: it remembers which runners are red and celebrates on the first pass after that.
- The fanfare is played with `$.audio.play`, which uses `afplay` on macOS only; on Linux and Windows terminals you get the toast without the sound.
- With **mods-hub** installed the verdict of each test run is the hub's `test.result` for that call (matched by time and command), and the celebration is a hub notification at level `success` (your phone channels too while you are away; held while Silent); the fanfare is not started while the hub's Silent or Night mode is on. The hub publishes the event just after the tool returns, so the celebration comes about a quarter of a second later. Without the hub, or when it has no event for the call, the output is read here as before, with `shared/test-runners` deciding what a test run is and what its summary says.

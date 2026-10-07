# long-run-alert
> Alerts you when a single command has been running too long.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Starts a timer whenever Claude runs a Bash command. If the command is still going after the threshold (60 seconds by default), a toast tells you which one: `⏱ still running (1m): npm run build`. A command that finishes in time never triggers anything.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install long-run-alert@claude-mods
```

## Usage
Nothing to run. Watch for the toast in the top right of the transcript when a build, test run or install drags on. Commands started with `run_in_background` are ignored, since they return immediately.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `seconds` | number | `60` | How long one command may run before the alert appears. |
| `repeat` | boolean | `false` | Alert again every interval while the command is still running. |

## How it works
- Hooks `tool.call` for Bash, starts a `$.clock.after` (or `$.clock.every` with `repeat`) timer, and cancels it when the command's result comes back or the dispatch is aborted.
- The toast is a plain display call; it never touches the command or its result.
- Limit: it measures wall-clock time of the tool call, so time Claude spends waiting for your permission approval counts too.

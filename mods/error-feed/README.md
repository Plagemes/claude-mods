# error-feed
> Collects every failed command and tool error in one pane.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Every tool call that comes back as an error (a Bash command exiting non-zero, an Edit whose text was not found, a failed fetch, an MCP tool error) is recorded with the tool, what it was called with, the first 300 characters of the error and the time. `/errors` shows them all in one pane, newest first, and one press hands any of them back to Claude to fix.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install error-feed@claude-mods
```

## Usage
- The status line keeps count: `⚠ 3 errors · /errors`.
- `/errors` opens the **Errors** pane. Each entry shows the tool, its call, the exit code and time, and the first lines of the error.
- **Ask Claude to fix** submits a prompt with the call and its error, asking Claude to find the root cause, fix it and re-run. The button then reads **Ask again**.
- **Dismiss** removes one entry; **Clear all** (`c`) empties the feed; **Close** (`x`) closes the pane.
- `/errors clear` and `/errors close` do the same from the prompt.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxErrors` | number | `50` | How many of the most recent errors the feed keeps. |
| `showStatus` | boolean | `true` | Show the error count in the status line. |
| `includeSubagents` | boolean | `true` | Also collect errors from tool calls made by subagents (tagged `subagent`). |

## How it works
- A `tool.call` hook passes every call through untouched and looks at the result: one flagged `isError` is recorded. A Bash command that exits non-zero is reported that way (its exit code is parsed from the output), except exit codes the Bash tool reads as normal, such as `grep` finding nothing.
- Refusals are not failures: calls you declined or interrupted are skipped.
- The feed lives in session state (it survives a hot reload, not a new session). Only the first 300 characters of each error are kept and sent.

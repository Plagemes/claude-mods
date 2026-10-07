# desktop-notify
> Native desktop notifications when Claude finishes or needs you.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Sends a native desktop notification when a long turn finishes ("Finished in 1m 35s: <start of Claude's answer>") and when Claude needs you (a permission request or a wait for input). Short turns stay quiet, so you only get pinged for work you probably walked away from. If the notifier is missing or fails, nothing happens and the session is unaffected.

## Install
```
/plugin install desktop-notify --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. The notification title is `Claude Code · <project folder>` and the body says what happened. It uses `osascript` on macOS, `notify-send` on Linux and a Windows PowerShell toast on Windows.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `minSeconds` | number | `30` | Notify on turn completion only when the turn took at least this many seconds. |
| `attention` | boolean | `true` | Also notify when Claude needs you (permission requests, waiting for input). |

## How it works
- Hooks `turn.complete` (main conversation only; interrupted turns and subagents are skipped) and `classic.Notification`.
- Detects the platform with `$.env` (`OS`) and `uname -s`, then runs the notifier through `$.process.run` with a 5 second timeout; the message text is passed as arguments or environment variables, never spliced into a script.
- Limits: it cannot tell whether your terminal is focused, so use `minSeconds` to keep it quiet while you watch. Linux needs `notify-send` (libnotify) and a notification daemon; the Windows toast needs Windows PowerShell 5 (`powershell`), not PowerShell 7.

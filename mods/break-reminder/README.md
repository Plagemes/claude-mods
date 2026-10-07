# break-reminder
> Reminds you to stand up and stretch every 50 minutes of active work.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Counts the time you actually spend working with Claude and shows a friendly toast every 50 minutes of it: stand up, drink water, look away from the screen, roll your shoulders. Time counts as active while Claude is working on a turn and for five minutes after your last prompt or Claude's last answer; time you spend away does not. The reminders rotate, and the rotation carries over between sessions.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install break-reminder@claude-mods
```

## Usage
Nothing to run. A toast such as `🧍 Stand up and stretch your legs. (50 min of active work)` appears in the top right of the transcript for about twelve seconds. Headless runs (`claude -p`) never remind.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `minutes` | number | `50` | Minutes of active work between two reminders. |
| `idleMinutes` | number | `5` | How long after your last prompt (or Claude's last answer) you still count as working. |

## How it works
- A `$.clock.every` tick every 30 seconds, started from `session.start`, adds the elapsed time to the active total whenever a turn is running or your last prompt was recent. `prompt.submit`, `turn.start` and `turn.complete` keep that activity state.
- The rotation position is kept in `$.store`; the active-time total lives in memory, so it starts from zero in a new session or after the mod reloads.
- Limit: it can only see your prompts, not your keyboard. Reading a long answer for more than five minutes counts as a break.

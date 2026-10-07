# daily-goal
> /daily-goal sets today's goal, keeps it in view above the prompt and asks at day's end if you got there.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
Give each working day one goal per project. daily-goal keeps the goal in a band above the prompt and tells Claude about it, so suggestions lean toward it. In the evening the band asks whether you got there; if you never said, it asks the next morning. Every answer goes into a 14-day history with ✓ and ✗, so you can see how often you reach what you set out to do.

Claude Code ships its own `/goal` command (a stop condition for Claude), so this mod's command is **`/daily-goal`**.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install daily-goal@claude-mods
```

## Usage
- `/daily-goal ship the login fix` sets today's goal for this project. Setting it again replaces it.
- **Band above the prompt:** `🎯 Goal: ship the login fix · set 2 h ago`
  - **Done** (`d`) marks it reached, with a 🎉 toast.
  - **Edit** (`e`) puts `/daily-goal <goal>` in the prompt box to change it.
  - **Hide** (`h`) hides the band for this session.
- **The evening question,** from 18:00 (configurable) or in the first session after it: `🎯 Did you reach today's goal?`
  - **Yes, done** marks it reached.
  - **Not yet** keeps it open; the next day asks again.
  - **Later** hides the band for this session.
- **The next morning,** a goal left open is asked about as "yesterday's goal" (up to a week back), with **Yes** and **No**.
- `/daily-goal` shows today's goal. `/daily-goal done` marks it reached. `/daily-goal clear` removes it.
- `/daily-goal history` lists the last 14 days, `✓` reached, `✗` missed, `?` unanswered, `·` no goal, with how many you reached and your streak.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `askAfterHour` | number | `18` | From this hour (local time, 0–24) the band asks whether you reached today's goal. |
| `tellClaude` | boolean | `true` | Add today's open goal to the system prompt, so Claude keeps it in mind. |

## How it works
- Goals are kept per project (the session's root) in `$.store`, the last 60 days of them.
- What it hooks:
  - `session.start` and `turn.complete` re-read the goals, so another session's answer, the evening hour and midnight are all noticed.
  - The `AbovePrompt` band draws the goal or the question from `$.state`, with the engine's own band below it.
  - `prompt.compose` adds one short section while the goal is open. It changes only when the goal does, so the prompt cache holds.
- Limits:
  - One goal per project per day.
  - Days and hours are in your machine's time zone.
  - The question appears when you're at Claude Code. It never sends a notification.

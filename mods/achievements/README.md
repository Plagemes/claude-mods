# achievements
> Unlock achievements as you work: first commit, 100 green test runs, a week-long streak and more.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
achievements counts what you and Claude do: prompts, commits, test runs, edits, subagents, the days you show up. When a count reaches a goal, an achievement unlocks with a toast and a short fanfare. Progress is global, so it adds up across every project and session. `/achievements` shows a grid of all 26, unlocked ones in green and locked ones with a progress bar.

| Group | Achievements |
| --- | --- |
| Getting started | Hello, Claude (first prompt) · Regular (100 prompts) · Delegator (first subagent) · Collector (install a mod) |
| Git | First commit · Committed (10) · Centurion (100) · Pull request (`gh pr create`) · Shipper (10 pushes) · Branching out (5 branches) |
| Tests | Green light (a passing run) · Evergreen (100 green runs) · Bug squasher (a failing run turned green, 10 times) |
| Craft | Refactorer (20 files in one session) · Polyglot (5 languages) · Toolsmith (1,000 tool calls) · Checklist (a todo list of 5+ finished) · Deep work (a 10-minute turn) · Flawless day (25+ tool calls, none failing) |
| Habits | Night owl (midnight–4 a.m.) · Early bird (5–7 a.m.) · Weekend warrior · On a roll (3-day streak) · Week-long streak (7) · Habit (30) · Achievement hunter (10 unlocked) |

## Install
```
/plugin install achievements --marketplace plagemes/claude-mods
```

## Usage
- **Unlock toast:** `🏆 Unlocked: 🦉 Night owl · Send a prompt between midnight and 4 a.m.`, with a short fanfare.
- **`/achievements` opens the pane:**
  - overall progress bar and count, and your latest unlock
  - a **Show** picker: all, unlocked, locked, or one group
  - a grid of cards: green with `✓ unlocked 2 days ago`, or dim with `████░░░░░░ 4/10`
  - **Close** with `q`
- Where no pane can be shown, `/achievements` prints the list into the transcript.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `sound` | boolean | `true` | Play a short fanfare when an achievement unlocks. Sound plays on macOS only. |

## How it works
- What it hooks:
  - `prompt.submit` counts your own prompts and the days you worked. Prompts other plugins send don't count.
  - `tool.call` counts tool calls and failures, and reads what each one did:
    - Bash `git commit`, `git push`, new branches, `gh pr create` and test runs that pass or fail
    - `Edit` and `Write` targets
    - `Agent` calls
    - finished `TodoWrite` lists
  - `turn.complete` catches long turns.
  - `process.run` catches the mod store's `claude plugin install`.
- Everything is recorded after the hook returns, so no tool call waits on it. Progress lives in `$.store` and is saved two seconds after activity, at once on an unlock, and at session end. Each save is merged into what the store holds, so sessions running side by side add up.
- Limits:
  - Counts start when the mod is installed.
  - Commits, pushes and test runs are seen only when Claude runs them through Bash, not when you run them in another terminal.
  - Days and hours are in your machine's time zone.
  - Flawless day is awarded once the day is over, on your next activity.

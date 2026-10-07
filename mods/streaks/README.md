# streaks
> Shows your consecutive days of coding with Claude in the status line.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
streaks counts the calendar days (by your own clock) on which you sent Claude a prompt. At the start of a session it shows your current streak in the status line for 10 seconds (`🔥 12 days streak`), a toast celebrates milestones of 7, 30 and 100 days, and `/streak` shows your current and longest streaks with a calendar of the last 30 days.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install streaks@claude-mods
```

## Usage
Nothing to run: it keeps count while you work. `/streak` prints something like:

```
🔥 Current streak: 12 days (send a prompt today to keep it going)
🏆 Longest streak: 31 days, ended 2026-08-14
📅 Active on 25 of the last 30 days, and on 142 days since 2026-03-02

       M  T  W  T  F  S  S
Sep 07    ·  ●  ●  ·  ●  ●
Sep 14 ●  ●  ●  ·  ●  ●  ●
Sep 21 ●  ●  ●  ●  ●  ●  ●
Sep 28 ●  ●  ●  ·  ●  ●  ●
Oct 05 ●  ● [●]

● active day   · quiet day   [ ] today
```

A streak stays alive through today until you have sent a prompt, so opening Claude on the morning after a good run still shows it. Only your own prompts count: typed, from the Remote Control app or SDK, or pinged from Slack; scheduled runs, background-task notifications and messages from other sessions do not.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `persistent` | boolean | `false` | Leave the streak in the status line all session instead of clearing it after 10 seconds. |
| `milestones` | string | `7,30,100` | Comma-separated streak lengths, in days, that get a toast. |

## How it works
- Hooks `prompt.submit`; the first person prompt of a day adds that date to a list in the mod's own store (`$.store`), written from a timer so the prompt never waits for it. `session.start` reads the list and shows the alive streak. The status line waits for a streak of two days.
- The store keeps the last 400 active days and, separately, your longest streak ever, so a record that scrolls out of the list is not forgotten.
- Limits: days follow the clock of the machine Claude Code runs on, so a prompt sent after midnight there belongs to the new day, and the record is per machine (the store is local; `settings-sync` does not move it).

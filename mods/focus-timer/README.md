# focus-timer
> A Pomodoro timer in the status line with focus and break cycles.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Runs focus rounds and breaks in the status line under the prompt (`🍅 18:42`, then `☕ 4:12 break`), updated every second. When a round ends you get a toast and a short bell, and the break starts by itself; every fourth round earns a long break. The timer is kept by its end time, so it carries on in your next session.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install focus-timer@claude-mods
```

## Usage
- `/pomodoro` starts a 25-minute focus round (`🍅 Focus round 1: 25 min, until 14:35.`); `/pomodoro 50` sets another length.
- `/pomodoro break [minutes]` starts a break now; `/pomodoro status` shows the time left and the rounds done; `/pomodoro stop` ends the timer.
- At the end of a round: `🍅 Round 2 done: take a 5-minute break.`; after the break: `☕ Break over. /pomodoro starts round 3.`
- Claude Code already ships `/focus` (its focus view), so this timer answers to `/pomodoro` instead.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `focusMinutes` | `25` | Length of a round started with plain `/pomodoro`. |
| `breakMinutes` | `5` | Break after each round; `0` skips breaks. |
| `longBreakMinutes` | `15` | Break after every fourth round. |
| `sound` | `true` | Play the bell at the end of a round or a break. |

## How it works
- The timer (phase, end time, round) lives in `$.state` and in `$.store`; `$.clock.every(1000)` redraws `$.ui.status` and ends the phase when its time is up.
- `session.start` picks a stored timer back up (one that ran out within the last two minutes still rings; an older one is dropped). After a plugin reload the countdown resumes on the next command or prompt.
- The bell is `assets/bell.wav` through `$.audio.play`, which Claude Code plays on macOS; elsewhere only the toast shows.

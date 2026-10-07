# done-chime
> Plays a chime when a long turn finishes.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
When Claude finishes a turn that took longer than 20 seconds (configurable), a short two-tone chime plays, so you can look away while it works. Quick replies stay silent, and so do interrupted turns, failed turns and subagents.

## Install
```
/plugin install done-chime --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. Start a long task, do something else, and listen for the chime: a soft E5 then A5 bell, under a second long. The sound is `assets/chime.wav`, a 16-bit mono 44.1 kHz file of about 75 KB bundled with the mod.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `seconds` | number | `20` | Play the chime only when the turn took longer than this many seconds. |
| `volume` | number | `1` | Loudness: `0` is silent, `1` is the clip's own level, up to `4`. |

## How it works
- Hooks `turn.complete` and plays the clip with `$.audio.play` when the main conversation's turn ended with an answer and `durationMs` is over the threshold.
- The sound is started from a zero-delay timer, so it never holds up the end of the turn. If the machine cannot play it, the failure is swallowed and nothing else happens.
- Limits: Claude Code plays clips with `afplay`, which only macOS has, so on Linux and Windows terminals the chime is silent for now. It plays on the machine Claude Code runs on, not on a remote client.

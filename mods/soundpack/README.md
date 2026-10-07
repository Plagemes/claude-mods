# soundpack
> Sound packs for Claude Code events: minimal, retro or nature.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
Gives four moments of a Claude Code session a sound, in the style you pick: a long turn ends (**done**), a command fails (**error**), Claude needs your approval (**permission**) and a test run passes (**green**). Three packs ship with it, twelve short clips in all, about 430 KB.

| Pack | done | error | permission | green |
| --- | --- | --- | --- | --- |
| `minimal` | two soft bell notes rising | two low rounded notes stepping down | two marimba notes, the second left hanging | four-note bell sparkle |
| `retro` | 8-bit "level complete" arpeggio | falling chip buzzes with a crunchy hit | two rising beep-boop pairs | fast power-up run into a chord |
| `nature` | wind chime | two hollow wood knocks | a bird's tweet-tweet and trill | rising water droplets |

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install soundpack@claude-mods
```

## Usage
Nothing to run once it is configured. `/soundpack` plays the four sounds of the current pack one after another and shows what is on; `/soundpack retro` previews another pack, `/soundpack error` plays one sound. Pick the pack and the switches in `/config`.

**Sound only plays on macOS.** Claude Code plays clips with `afplay`; on Linux and Windows terminals it skips them without an error, so the mod is silent there for now, and `/soundpack` says so. Sound plays on the machine Claude Code runs on, not on a remote client.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `pack` | string | `minimal` | `minimal`, `retro` or `nature`. |
| `done` | boolean | `true` | Play the done sound when a long turn ends. |
| `error` | boolean | `true` | Play the error sound when a Bash command fails (at most once every 8 seconds). |
| `permission` | boolean | `true` | Play the permission sound when an approval prompt opens. |
| `green` | boolean | `true` | Play the green sound when a test command finishes without failures. |
| `longTurnSeconds` | number | `20` | A turn is long, and gets the done sound, when it took more than this many seconds. |
| `volume` | number | `1` | Loudness: `0` is silent, `1` is the clips' own level, up to `4`. |

## How it works
- Hooks `turn.complete` (main conversation, answered turns only), `tool.call` on `Bash` (a failed result, or a test runner that printed failures, is an error; a test command that passed is green; background runs are skipped), and `classic.PermissionRequest` and `classic.Notification` for the approval prompt, which raises both, so a 2-second cooldown makes it one sound.
- Every sound starts from a zero-delay timer and is never awaited, so nothing waits for a clip to end. The clips go through `$.audio.play`, so the quiet-mode mod silences them too.
- The clips are synthesised, not sampled (sine bells, chip pulse waves, FM chirps, filtered noise), as 16-bit mono 22.05 kHz WAV files at one average loudness, so no pack or event jumps out.
- Limits: it can only hear what the hooks see, so a test run inside a script it does not recognise is not green, and a failure that Claude Code does not report as an error (such as `grep` finding nothing) is not an error.
- With [mods-hub](../mods-hub) installed, it also listens to the hub's bus every 3 seconds: a test run test-watch or quick-commands made (`test.result`) plays green or error, and a guard's refusal (`risk.blocked`) plays the error sound. The hub's own test reports are the Bash runs already played for, and the hub holds every sound while Silent and at night. Without the hub nothing changes.

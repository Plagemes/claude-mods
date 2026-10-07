# speak-summary
> Reads a one-line summary of what Claude did out loud when a turn ends.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
When a turn that took a while finishes, a small model condenses Claude's final message into one spoken sentence of at most 15 words ("Fixed the flaky login test; all tests pass now.") and your computer reads it aloud. You can walk away from a long task and hear what happened without looking at the screen.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install speak-summary@claude-mods
```

## Usage
- Nothing to do: after any turn longer than the threshold (20 s by default) you hear the summary.
- `/speak` shows whether it is on, the threshold and the voice.
- `/speak off` / `/speak on` silence or re-enable it (remembered across sessions).
- `/speak test` speaks a test phrase so you can check your voice setup.
- If speech is unavailable, one toast says why: `🔇 speak-summary: cannot speak here (...)`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `minDurationSec` | number | `20` | Only speak after turns that took at least this many seconds. |
| `voice` | string | `""` | Exact name of a system voice (e.g. `Samantha`). Empty uses the default voice. |
| `model` | string | `haiku` | Model alias or id that writes the spoken one-liner. |

## How it works
- Hooks `turn.complete` for main-loop turns that ended with an answer (not interrupted, not subagents) and lasted past the threshold; the work runs after the turn has finished, so it never delays you.
- Calls `$.model.complete` (low effort, 12 s timeout) for the one-liner, falling back to the answer's first sentence; then `$.audio.speak` with your voice. One utterance at a time: a turn ending while it still speaks is skipped.
- Speech uses the platform synthesizer (`say` on macOS). Where none exists (most Linux terminals) it warns once and stays quiet. Speaking rate is not configurable: the API exposes only the voice.

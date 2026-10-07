# model-advisor
> Suggests a cheaper model when your prompt is simple, and a stronger one when it is hard.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Rates every prompt you send as light, standard or heavy from its words and length (rename, typo, formatting on one side; architecture, debugging, concurrency, security, migrations, stack traces on the other) and compares it with the model the session runs. When they do not match, a band above the prompt says so, e.g. `↓ Simple task (a rename): /model haiku would do`. It never blocks a prompt and never changes the model: switching stays your call.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install model-advisor@claude-mods
```

## Usage
- Send prompts as usual; a hint appears above the prompt when another model fits better:
  - `↓ Simple task (a typo fix): /model haiku would do` while on Sonnet or Opus.
  - `↑ Hard task (debugging and concurrency): /model opus is stronger` while on Haiku or Sonnet.
- Band buttons: **Type /model haiku** (`u`) puts the command in the prompt box for you to send, **Dismiss** (`d`), **Mute** (`m`) for the rest of the session. A dismissed suggestion rests for a few prompts before it can return.
- `/model-advisor off` / `/model-advisor on` (or no argument to toggle).
- Short replies like "yes, go ahead" and prompts sent by plugins or background tasks get no hint.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `useModel` | `false` | Also ask the classifier model to rate each prompt (one tiny completion, a few tokens, per prompt). |
| `classifierModel` | `haiku` | Model alias or id used when `useModel` is on. |
| `display` | `band` | `band`, `toast` or `both`. |

## How it works
- A `prompt.submit` hook lets the prompt enter first (`next(e)`), then rates it, so the turn never waits on it; with `useModel` on it calls `$.model.complete` (10 s timeout) and falls back to the local rules when that fails.
- The current model comes from `$.session.model()`; the hint lives in `$.state` and a `ui.render` hook on `AbovePrompt` draws it.
- The rules are keyword heuristics: they read the prompt alone, not the conversation behind it, so treat the hint as a nudge.

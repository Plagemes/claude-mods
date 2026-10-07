# prompt-lint
> Gently flags vague prompts like 'fix it' and suggests what to add.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Before a prompt goes to Claude, prompt-lint checks it for the usual signs of vagueness: "fix it", "it doesn't work", a lone "this", a bare "add tests", a single unexplained word. When it finds one it shows a short tip, such as "Name the file, function or ticket you mean", and sends the prompt anyway. Specific prompts, one-word replies like "yes" or "continue", slash commands and questions are never flagged.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install prompt-lint@claude-mods
```

## Usage
Type as usual. A vague prompt raises a toast for a few seconds:
```
Say what to change and where: a file, a function or an error message.
```
In strict mode the prompt is held back instead, with the tip and "Send it again unchanged to go ahead anyway." Sending the same text a second time goes through, so strict mode never traps you.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `strict` | boolean | `false` | Hold a vague prompt back with the tip instead of only showing it. |

## How it works
- Hooks `prompt.submit` and applies a few English-language rules to what you typed, taking the first that fits: a bug report with no error, a "fix it" with nothing named, a prompt made only of pronouns, a three-word action with no file or identifier, or a tiny unexplained prompt.
- A prompt counts as naming a target when it has a file name, path, backticked or camelCase or snake_case identifier, number, link, quote or `@mention`.
- Skipped: slash commands, `!` and `#` prompts, prompts typed over a running turn, prompts with images or files attached, anything not typed by a person, and text that is not Latin script.
- Limits: these are heuristics, so some vague prompts slip by and an occasional specific one gets a tip. A follow-up like "fix it", sensible after Claude has just shown a bug, is flagged too; the tip is only a nudge.
- With [mods-hub](../mods-hub) installed: in `warn` mode the tip goes through `notify` at `info` level instead of a 7-second toast (held while Silent). Strict mode's refusal is unchanged. It publishes no events. Without the hub nothing changes.

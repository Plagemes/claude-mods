# concise-mode
> /concise toggles short, to-the-point answers.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
`/concise` flips a switch. While it is on, a short brevity instruction is added to Claude's system prompt: lead with the answer, skip preambles and recaps, prefer one sentence over three. The instruction still asks Claude to name every file it changed and any risk or decision you need to make, so shorter never means unsafe. The status line shows `concise` while the mode is on.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install concise-mode@claude-mods
```

## Usage
```
/concise        toggle on or off
/concise on     turn it on
/concise off    turn it off
```
The mode lasts for the session. Turning it on or off changes the system prompt, so the next reply is the first to reflect it.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `startOn` | boolean | `false` | Begin every session with concise mode already on. |

## How it works
- Keeps the on/off flag in `$.state`, so it survives a plugin reload within the session.
- Hooks `prompt.compose` and appends a `concise-mode:brevity` section while the flag is on; a `--bare` session is left alone.
- Registers `/concise` at session start and shows `concise` in the status line while on.
- Limits: it asks the model for brevity, it cannot enforce a length. Switching the mode changes the system prompt once, which costs a single prompt-cache miss.

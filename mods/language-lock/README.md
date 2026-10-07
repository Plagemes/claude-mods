# language-lock
> Makes Claude always answer in your language while keeping code in English.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Adds one short section to Claude's system prompt: always reply to you in the language you choose, whatever language you type in, while code, identifiers, code comments, file names, commit messages and pull request titles stay in English. Say "answer in French this once" and Claude will, since the rule yields to an explicit request.

## Install
```
/plugin install language-lock --marketplace plagemes/claude-mods
```

## Usage
Set your language once in the plugin's config row (`/config`, or `pluginConfigs` in settings) and chat as usual. With the default, English, the mod does the reverse job: you can type in any language and still get English replies.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `language` | string | `English` | The language Claude answers in, for example `Spanish`, `Deutsch` or `日本語`. |

## How it works
- Hooks `prompt.compose` and appends a `language-lock:language` section after the engine's own sections, in the session part of the prompt (it varies per person, so it is never shared across users).
- The setting is squeezed to one short line, so it cannot carry extra instructions; a blank value falls back to English.
- Limits: it asks the model, it does not translate. Tool output, file contents and error messages stay as they are, and a `--bare` session, which sends a one-line prompt, is left alone.

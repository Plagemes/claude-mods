# snippet-vault
> Save and reuse code snippets across projects with /save-snippet and /snippet.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
A personal snippet library inside Claude Code. `/save-snippet <name>` saves the text you have selected with the mouse, or else the last fenced code block Claude wrote; `/snippet <name>` puts it back into your prompt as a fenced block, ready to send. The vault is shared by all your projects and survives restarts.

## Install
```
/plugin install snippet-vault --marketplace plagemes/claude-mods
```

## Usage
- `/save-snippet <name>` saves a snippet (names: letters, digits, `.`, `_`, `-`, up to 40 characters). Saving an existing name updates it.
- `/snippet <name>` inserts it into the prompt at the cursor. A bare `/snippet`, or an unknown name, lists what you have.
- `/snippets` lists the vault with language, size and date.
- `/delete-snippet <name>` removes one.

## Configuration
No configuration needed.

## How it works
- Registers the four commands at `session.start` and answers them with `command.run`. The source is `$.ui.selection()` when something is selected (fullscreen terminal), otherwise the newest closed code fence found in the assistant's messages (`$.session.messages()`).
- Snippets live in `$.store` under one key, at most 200 of up to 50,000 characters each. They are inserted with `$.prompt.fill`, fenced with enough backticks to survive code that contains fences itself.
- Limits: selection works only where the engine sees it (not in headless runs), and `/snippet` needs a prompt box.

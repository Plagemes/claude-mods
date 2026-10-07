# quote-selection
> /quote pastes your mouse selection into the prompt as a Markdown quote.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Select text in the transcript with the mouse (an error message, a paragraph of Claude's answer, a diff hunk), type `/quote`, and the selection lands in your prompt as a Markdown block quote, ready for you to add a question underneath. `/quote-code` does the same but wraps the selection in a fenced code block.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install quote-selection@claude-mods
```

## Usage
- `/quote` inserts `> selected text` at the cursor of the prompt box, followed by a blank line.
- `/quote-code [language]` inserts a fenced block; `/quote-code ts` opens it as ```` ```ts ````. The fence is lengthened automatically when the selection itself contains backticks.
- With nothing selected, the command says so and leaves the prompt alone.

## Configuration
No configuration needed.

## How it works
- Registers `/quote` and `/quote-code` at `session.start` and answers them with `command.run` hooks.
- Reads the selection with `$.ui.selection()` and inserts it with `$.prompt.fill({ mode: 'insert' })`, so what you had already typed stays on either side.
- The selection is only visible to the mod in the fullscreen terminal and the desktop app; in a `-p` run, or with fullscreen off, there is nothing to quote.

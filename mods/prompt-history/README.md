# prompt-history
> /history searches every prompt you have sent across sessions and reuses one.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Keeps every prompt you type, with when you sent it and from which project, across all sessions (the newest 1,000). `/history` opens a pane with a search field: results narrow as you type, newest first, and **Use** puts the prompt back in the prompt box to edit or send. A toggle limits the search to the current project.

## Install
```
/plugin install prompt-history --marketplace plagemes/claude-mods
```

## Usage
- `/history` opens the **History** pane with the keyboard in the search field (`prompt-history: 834 prompts kept.`).
- Type words: a prompt matches when it holds all of them, in any case (`fix flaky` finds "Fix the flaky queue test"). The newest 30 matches are listed with project and time.
- **Use** replaces the prompt draft with that prompt and closes the pane; **This project** / **All projects** switches the scope.
- `/history migration` opens the pane already searching for "migration"; `/history clear` forgets the whole history.

## Configuration
No configuration needed.

## How it works
- A `prompt.submit` hook lets the prompt enter first, then adds it to `$.store`: only prompts you typed (terminal or Remote Control), not ones from plugins, background tasks or other sessions. A repeated prompt moves to the top instead of being kept twice.
- The pane is a `ui.render` hook on `Pane` with an `Input` whose changes re-run the search over a cached copy of the history; **Use** calls `$.prompt.fill`.
- Prompts longer than 4,000 characters are kept cut (marked `cut`), and the history stays under about 2.5 MB. It is plain text in Claude Code's plugin data folder: anything secret you typed is in it until `/history clear`.

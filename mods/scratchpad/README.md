# scratchpad
> A persistent per-project notes pane you can type into without leaving Claude Code.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Keeps a list of notes for each project (by its root folder), across sessions. `/notes` opens a pane with a text field at the top: type, press Enter, and the note is saved. Every note has **To prompt**, which drops its text into the prompt box at the cursor, and **Delete**. `/note <text>` adds one straight from the prompt.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install scratchpad@claude-mods
```

## Usage
- `/notes` opens the **Notes** pane with the keyboard in it (`3 notes for my-app.`). Esc gives the keyboard back to the prompt.
- Type in the field and press Enter to add; newest notes come first, each with its date and time.
- **To prompt** inserts the note into your prompt draft (nothing is sent); **Delete** removes it.
- `/note ask Sam about the schema` adds a note without opening the pane (`Noted. 4 notes for my-app.`).
- On the mobile app the list shows without the text field.

## Configuration
No configuration needed.

## How it works
- Notes are kept in `$.store` under `notes:<project root>` (`$.session.root()`), at most 200 per project and 4,000 characters per note; the store is re-read before each change, so two sessions on one project do not drop each other's notes.
- The pane is a `ui.render` hook on `Pane` drawing an `Input` and the list from `$.state`; **To prompt** uses `$.prompt.fill` in `insert` mode.
- The pane shows the project it was opened for; after `/cd` run `/notes` again to switch.
- With [mods-hub](../mods-hub) installed the same view is the **Notes** tab of the shared Claude Mods panel (tab order 280; `registerTab`, drawn by hooking the hub's `claude-mods` pane while that tab is shown), this project's notes are loaded at session start so the tab is never empty, and `/notes` opens the tab. In the tab the note field does not take the keyboard by itself (the hub's tab strip owns the digit keys 0–9): click or Tab into it. The mod trades no events. Without the hub the own pane and `/notes` are exactly as above.

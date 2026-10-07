# todo-pane
> A live pane of Claude's current task list with progress.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Follows Claude's task list as it changes, from the `TodoWrite` tool and from the newer `TaskCreate` / `TaskUpdate` / `TaskList` tools, and draws it in a pane: a progress bar with `3/8 done`, then every item marked ☐ pending, ◐ in progress (shown with its "-ing" phrasing, in bold) or ☑ completed (struck through). While the pane is open its tab reads `Todos 3/8`.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install todo-pane@claude-mods
```

## Usage
- `/todos` opens the pane at any width and prints `3 of 8 done.`
- **Hide done** (`h`) leaves completed items out of a long list; **Show done** brings them back. **Close** closes the pane.
- On a wide terminal (144 columns or more) the pane opens by itself when the session starts and docks beside the transcript in fullscreen; on a narrower one it stays closed until you run `/todos`.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `autoOpen` | `true` | Open the pane at session start when the terminal is wide enough for an unrequested pane. |

## How it works
- `tool.call` hooks on `TodoWrite`, `TaskCreate`, `TaskUpdate` and `TaskList` call `next(e)` first and update the list in `$.state` only when the tool succeeded; a subagent's own `TodoWrite` list is left out so the pane shows the main conversation's plan.
- The pane is a `ui.render` hook on `Pane`; at session start it is opened unasked and closed again when the engine does not place it (`isPlaced: false`), so it never pops up later by surprise.
- The list lives for the session; a resumed session starts empty until Claude next writes its todos.
- With [mods-hub](../mods-hub) installed the same list is the **Tasks** tab of the shared Claude Mods panel (tab order 260; `registerTab`, drawn by hooking the hub's `claude-mods` pane while that tab is shown, without a Close button; the tab title carries the progress, `Tasks 3/8`), `/todos` opens that tab, and no pane of its own opens at session start (`autoOpen` only applies without the hub). An item that turns in progress is published as `task.started`, one that is completed as `task.finished` (outcome `ok`), and an open one that is removed as `task.finished` (outcome `cancelled`), for autopilot and workflow-studio; TodoWrite lists are matched item by item by their text, since they renumber when rewritten. Without the hub the own pane, its auto-open and `/todos` are exactly as above.

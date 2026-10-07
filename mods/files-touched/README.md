# files-touched
> A pane of every file read, edited or created in the session, with counts.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
files-touched keeps a tally of every file Claude reads, edits or creates during the session, subagents included. `/files` lists them in a pane, grouped by directory, with how many times each was read or edited and whether it's new. Each file has one button to copy its path and one to drop an `@mention` of it into your prompt.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install files-touched@claude-mods
```

## Usage
`/files` opens the pane:

```
6 files  4 read  3 edited  1 created                       [ Changed only ]

./
  README.md                          1 edit           copy @
src/
  app.ts                             2 edit  3 read   copy @
  new.ts                      new                     copy @
/etc/
  hosts                                      1 read   copy @
```

- **copy** puts the file's absolute path on the clipboard of the surface you pressed it on.
- **@** inserts `@src/app.ts` at the cursor in the prompt box (quoted when the path has spaces).
- **Changed only** (hotkey `e`) hides the files that were only read.

Paths inside the project are shown relative to it. Files outside it keep their absolute directory.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` after each call finishes and counts the successful ones:
  - Read counts as a read.
  - Edit, MultiEdit and NotebookEdit count as edits.
  - Write counts as an edit, or as a create when it made a new file.
- Keeps the tally in `$.state`, so the pane redraws as Claude works. A `/clear` resets it.
- Limits:
  - Files changed by Bash commands (`sed`, `mv`, generators) and paths matched by Grep or Glob aren't counted.
  - The tally lasts for the session only.
- With [mods-hub](../mods-hub) installed the same list is a section of the **Changes** tab of the shared Claude Mods panel (tab order 250, drawn by hooking the hub's `claude-mods` pane while that tab is shown), beneath [diff-pane](../diff-pane)'s changed-files list when that mod is installed too; whichever of the two registers the tab first owns it, and either one alone is enough. `/files` opens the tab. The mod trades no events: what a file was (read, edited, created) is known only from Claude's own tool calls. Without the hub `/files` opens the own pane as above.

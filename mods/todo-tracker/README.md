# todo-tracker
> Notices every TODO, FIXME and HACK Claude adds and lists them at turn end.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
Claude sometimes leaves `// TODO` or `FIXME` comments behind instead of finishing the job, and they scroll past in the diff. This mod notices every marker (`TODO`, `FIXME`, `HACK`, `XXX`) that an edit or write adds, tells you how many appeared when the turn ends, and lets you list them with their file and line.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install todo-tracker@claude-mods
```

## Usage
- At the end of a turn that added markers, a toast: `todo-tracker: 2 markers added this turn (1 TODO, 1 FIXME). /todos-added lists them`.
- `/todos-added` lists the markers of the latest turn that added any, as `src/a.ts:42  // TODO: handle errors`.
- `/todos-added all` lists every marker added this session. `/clear` forgets them.

## Configuration
No configuration needed.

## How it works
- A `tool.call` hook on `Edit`, `Write` and `MultiEdit` compares the text a call replaces with the text it puts in; only marker lines that were not already there count, so editing a line next to an old TODO does not re-announce it. Markers are matched as whole upper-case words, so `todoList` and `todos` are ignored.
- Line numbers come from re-reading the file after the call (or the line in the written content for `Write`); if the file cannot be read the item is listed without a line.
- Files changed through Bash (`sed -i`, a formatter, a heredoc) are not seen. The list is kept in `$.state` and capped at 200 items.

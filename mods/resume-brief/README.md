# resume-brief
> Shows what you were working on last time when a new session starts.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Start Claude Code in a project and a band above the prompt reminds you where you left off: when, on which branch, your last request, the files you edited and how many todos were open. Press **Continue** and Claude gets a ready-made "continue where we left off" prompt with all of that; press **Dismiss** or just type something else and it gets out of the way.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install resume-brief@claude-mods
```

## Usage
At session start, when the project has an earlier session:

```
↩ Last session · 2 h ago · feat/orders
You asked: “Also cover the admin endpoint”
Edited orders.test.ts, api.ts, admin.ts +1 · 1 open todo
[ Continue ]  [ Dismiss ]
```

- **Continue** (`c`) submits, as your own message: *Continue where we left off. In the last session (on branch feat/orders, 2 h ago): my last requests ..., files you edited ..., todos still open ..., where you stopped ...*
- **Dismiss** (`x`) hides the band; typing any prompt hides it too.
- `/resume-brief` shows the band again.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAgeDays` | number | `14` | Briefs older than this are not shown. |

## How it works
- After each main-loop `turn.complete` (in the background) and again at `session.end`, it reads `$.session.messages()`: your last three requests, files touched by Edit/Write/MultiEdit/NotebookEdit, the open items of the last TodoWrite list and the first line of Claude's last answer, plus the branch from `git rev-parse`. One brief per project root is kept in `$.store`.
- On `session.start` (interactive sessions only) the previous brief is put in `$.state` and drawn by an `AbovePrompt` hook with `Button`s, on the terminal and the desktop app alike. A brief of the very session being resumed is not shown.
- Sessions without any request never overwrite the last useful brief. Nothing is sent to a model until you press Continue.

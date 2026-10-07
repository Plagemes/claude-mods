# mission-control
> One dashboard for every Claude session on your machine: what each is doing, cost, blockers, with pause and priorities.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Every session with mission-control installed reports what it is doing every few seconds: project, branch, model, state (idle, working, waiting for an approval, waiting for an answer), the task it was given, how long the turn or the wait has lasted, its cost and tokens, running subagents, the last error and what it is blocked on. `/mission` shows them all as cards, with a totals bar (sessions, working, waiting, spend today). From any card you can **Pause** a session, **Resume** it, **Stop** its turn, send it a **Note** (it runs there as your own prompt when that session is idle) or set its **Priority**. A session that has waited for you too long is announced where you are typing, and through mods-hub on your phone while you are away.

Nothing is ever done to a session without your click or your typed `/mission` command.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install mission-control@claude-mods
```
Install it in every session you want to see (user scope does that for all of them).

## Usage
- **`/mission`** opens the cockpit: a pane of its own, or the **Mission Control** tab of the Claude Mods panel when mods-hub is installed.
  ```
  Mission Control                   3 sessions · 1 working · 1 waiting · $4.12 today
  [ Sort: status ] [ Show: all ] [ Refresh ]

  ◆ api main · #b2c3                                           needs approval 5m00s
    ↳ Publish the 2.0 release
    $1.20 · 80.0k tok · 1 agent · claude-sonnet-5
    ⚠ Approve Bash: npm publish
    [ Pause ] [ Stop turn ] [ Note ] [ Priority: normal ]
  ```
  `s` cycles the sort (status, recent, cost, project), `f` the filter (all, working, waiting, idle), `r` refreshes. Sessions that only mods-hub knows (no mission-control there) are listed without actions.
- **`/mission status`** prints the same as text. **`/mission pause|resume|stop <session>`**, **`/mission note <session> <text>`**, **`/mission priority <session> high|normal|low`** act from the keyboard; a session is named by its label (`api#b2c3`), the start of its id, or its project. `/mission close` closes the pane.
- In a paused session the status line reads `⏸ paused from Mission Control · /mission resume`; elsewhere `⏳ 1 session waiting for you · /mission` while one waits on you.

What each action does in the target session:
| Action | Effect |
| --- | --- |
| Pause | No automatic prompts start there (other plugins' prompts and scheduled ones are dropped; yours still run). A running turn is asked to finish its current step and stop. With mods-hub it also raises `control.pause` in that session, so autopilot, task-queue, night-shift and workflow-studio there pause too (they send their prompts as your words, which the drop alone cannot tell from yours). |
| Resume | Lifts the pause (and, with mods-hub, raises `control.resume` there); a turn that stopped for it is told to carry on. |
| Stop turn | Cancels the running turn (`$.turn.abort`). |
| Note | Your text, run as your own prompt as soon as that session is idle. |
| Priority | Recorded in its heartbeat, in `priority.json` and as the fact `mission-control.priority`, for smart-router and autopilot. |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `alertMinutes` | number | `3` | Minutes a session may wait on an approval or a question before you are alerted. |
| `shareSession` | boolean | `true` | Write this session's heartbeat (so cockpits list it) and accept actions from them. Off: this session only watches. |
| `statusLine` | boolean | `true` | Show the paused / waiting-sessions status line. |

## How it works
- **Heartbeats:** each session writes `~/.claude/claude-mods/mission/sessions/<id>.json` (one writer per file) when something changes, checked every 5 s and rewritten at least every 10 s; a heartbeat older than 30 s is a gone session. State comes from `turn.start`/`turn.complete`, `classic.PermissionRequest` and `classic.Notification` (approvals, MCP input), `AskUserQuestion` calls and `agent.spawn`; cost from each turn's usage priced with `shared/prices` (subagents included; an estimate when the model is unknown). Task text and approval details are masked with `shared/secrets` before they are written.
- **Actions:** a click appends a command to `inbox/<id>/<your session id>.jsonl` (one file per sending session, so two cockpits never overwrite each other's clicks); that session polls its inbox every 2 s, runs each command once (ids it handled are listed in its heartbeat, so writers prune them) and ignores commands older than 10 minutes. Pause appends a line Claude reads at its next step; a Note goes through `$.prompt.submit(..., asUser)`. Commands from anything other than you (a model-run command) are refused.
- **Alerts:** a session waiting longer than `alertMinutes` calls `notify(warning)` through mods-hub (toast here, your channels while you are away); the session you typed in last (`activity.json`) also gets a toast about the others.
- **With mods-hub:** the cockpit is the Mission Control tab (order 30), long waits are routed by the hub, sessions only the hub knows (`hub/sessions.json`) are listed, each command is published as `x.mission-control.command`, and `paused` / `priority` are shared as facts. It obeys the hub's `control.*` (a STOP from the phone, `/hub pause`): a pause holds the notes waiting to run as your prompt, a resume lets them go, a stop drops them. **Without it:** its own pane, toasts and files; everything else works the same. session-sync draws a "Same repo" section under the cards when installed.
- **Limits:** a session must have mission-control installed to report and to be controlled. Files cannot be deleted by a mod, so `sessions/` keeps one small file per past session (ended ones are skipped). Pause cannot hold prompts typed by you or sent by the person through a phone bridge, by design; a subagent's own approvals show as the session waiting.

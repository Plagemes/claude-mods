# night-shift
> Runs your queued tasks at a scheduled time, like overnight, and leaves you a report.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Queue up tasks during the day with `/night-shift add <task>`, schedule them with `/night-shift at 02:00`, and leave the session open. At that time, on a clean git tree, Claude works through them one by one, each as a turn of its own. After every task it updates a Markdown report in `.claude/night-shift/<date>.md` (outcome, duration, files changed, what Claude said), and the first prompt you type in the morning gets a toast with the result.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install night-shift@claude-mods
```

## Usage
- `/night-shift add <task>` queues a task (up to 30); `list`, `remove <n>`, `clear` manage them.
- `/night-shift at <HH:MM>` (also `2am`, `11:30pm`) schedules the next shift; `now` starts at once; `off` cancels the schedule, or stops a running shift after its current task.
- `/night-shift away` (with [mods-hub](../mods-hub)) starts the next shift as soon as the hub says you are away, instead of at a set time.
- `/night-shift report` shows the last shift's results; `/night-shift` opens the **Night shift** pane: schedule, tasks with `✕`, **Add task** and **Start at** fields, **Run now** (`n`), **Cancel schedule** (`x`), **Stop after this task** (`s`), and the last shift's results.
- Status line: `🌙 night shift at 02:00 · 3 tasks`, then `🌙 night shift 2/3 · 14m`, then `🌙 night-shift report ready`.
- Morning toast: `🌙 night shift: 3/3 done · .claude/night-shift/2026-10-08.md`.

Safety rails:
- Refuses to start when the working tree has uncommitted changes, or outside a git repository, unless `allowDirty` is on: the night's work is then exactly `git diff <base>`. Tasks are told not to commit or push.
- Never submits while a turn is running; waits for yours to finish.
- Stops a task that runs past `taskMinutes` and moves on; ends the shift after 2 tasks in a row fail or time out, or when you interrupt one.
- Ends after the current task as soon as you type a prompt yourself ("you took over"); tasks not run go back to the queue.
- Runs at most `maxTasks` tasks per shift; a start missed by more than 2 hours (session closed) is not made up later.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowDirty` | boolean | `false` | Start even with uncommitted changes or outside git. |
| `maxTasks` | number | `10` | Most tasks one shift runs (1–50). |
| `taskMinutes` | number | `45` | A task running longer is stopped (5–240). |

## How it works
- A `$.clock.every(60 s)` check starts the shift when due and the session is idle; each task goes out with `$.prompt.submit({ asUser: true })` plus a short note that it runs unattended, and the next one 3 s after its `turn.complete`. Overlong tasks end with `$.turn.abort`.
- Files changed per task come from `git diff --numstat` snapshots against the starting commit plus the Edit/Write calls seen; the report ends with `git diff --stat` for the whole night.
- The session must stay open (a sleeping laptop sleeps the shift), and permission prompts still wait for you, so give Claude the permissions the tasks need (e.g. accept edits) before you go; a task stuck on a prompt is stopped at the time limit.
- With [mods-hub](../mods-hub) installed:
  - `/night-shift away` starts the shift once the hub's presence turns `away` (`session.away`: no activity in any session for a while, `/hub away`, or "I'm away" from a channel);
  - each task is published as `task.started` and `task.finished` (ok, failed, cancelled) for autopilot, workflow-studio and mission-control;
  - a stop or pause raised through the hub (`control.stop` / `control.pause`, e.g. a STOP from your phone) ends a running shift after its current task, or calls off a scheduled one, checked every minute;
  - "started" is an `info` notice, "did not start" an `error`, and "over" a `success` (all done) or `error` notice, so the night's outcome reaches your channels while you are away.
  Without the hub nothing changes, and `/night-shift away` says it needs the hub.

# autopilot
> Give it a goal and success criteria; it plans, delegates, verifies and retries until the criteria pass or it needs you.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
`/autopilot <goal>` opens a setup card with success criteria found in your project (tests, lint, typecheck, build), a custom command, a budget, a time limit and how it may interrupt you. Press **Start** and it drives the session for you: it asks Claude for a numbered plan (following smart-router's rules: parallel subagents for independent work, a workflow only if you ticked "allow workflow"), sends one step at a time as your own words, and after every turn runs the criteria commands **itself**. Failures go back to Claude as the next prompt; the second failed fix is retried with harder thinking and a stronger model; it stops when everything passes, at a cap, or after N failed rounds in a row.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install autopilot@claude-mods
```

## Usage
- **`/autopilot <goal>`** opens the setup card (the **Autopilot** tab of the Claude Mods panel, or its own pane without mods-hub):
  - **Success criteria:** `[x] Tests pass — npm test`, `[x] Lint clean`, `[x] Typecheck clean`, `[x] Build OK` (from `package.json` scripts and lockfile, `tsconfig.json`, `pyproject.toml` with ruff/mypy, `Cargo.toml`, `go.mod`, `Makefile`), a **Custom command** field (must exit 0), **Budget ≤ $X** and **Max time** with their own fields.
  - **Interaction:** *Follow the hub* (default: mods-hub's Interaction mode; off means never ask), *Ask when blocked*, *Never ask*. When it never asks, Claude states `ASSUMPTION:` lines and parks `QUESTION:` lines instead of stopping.
  - **Allow workflow:** lets Claude use the Workflow tool for a big step; off, the prompts say not to.
  - **Start** (`s`) or `/autopilot go`.
- While it runs, the same tab shows the goal, each criterion with ✓/✗ and its last result, budget and time against their caps, the current step, turns and failures in a row, parked questions, a timeline, and **Pause** (`p`) / **Resume** (`r`) / **Stop** (`x`).
- Status line: `✈ autopilot · step 2/4 · $0.84 · 12m`, `✈ autopilot · fixing 2/3 …`, `✈ autopilot · needs you`.
- `/autopilot pause`, `/autopilot resume [answer]` (your answer to a blocking question), `/autopilot stop`, `/autopilot status`, `/autopilot cancel` (discard the card). These run mid-turn.
- When Claude ends a turn with `BLOCKED: <question>` (and interaction allows asking), the run waits and notifies you with a question; answer in the tab's **Answer** field, with `/autopilot resume <answer>`, or from your phone through a channel mod.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `budgetUsd` | `5` | The budget new setup cards start with (USD, list prices of turns and subagents). |
| `maxMinutes` | `60` | The time limit new cards start with; paused and blocked time do not count. |
| `maxFailures` | `3` | Failed check rounds (or failed turns) in a row before it stops (1–10). |
| `maxTurns` | `30` | Most prompts one run sends (2–100). |
| `checkTimeoutSeconds` | `300` | How long one criterion's command may run (5–600). |
| `allowWorkflow` | `false` | Tick "allow workflow" on new cards. |

## How it works
- **Driving:** each prompt goes out with `$.prompt.submit({ asUser: true })` only when no turn runs and nothing else is in flight; it ends with a tag (`[autopilot <id> step 3]`) so `turn.start`/`turn.complete` tell its turns from yours and from background-task notifications. Typing a prompt yourself pauses the run ("you took over"); interrupting its turn pauses it too.
- **Checks:** every ticked criterion runs as `sh -c "<command>"` in the project root via `$.process.run` with the timeout; exit 0 passes, test runs are also read for counts (vitest, jest, pytest, go, cargo, …). After a plan step a failing check is expected (the next step goes out); after the last step failures become fix prompts with the output's tail.
- **Hard limits:** turns (never more than 100), failed rounds in a row (never more than 10), budget, time; a cap hit mid-turn ends the run after that turn. Spend is priced from each turn's usage with the shared price table (an estimate on Bedrock, Vertex or a plan).
- **Resumable:** the run lives in `$.state` (survives a hot reload) and in the plugin's store per project; a session that closed mid-run comes back **paused** and resends the step it was on when you press Resume.
- **With mods-hub:** it registers the **Autopilot** tab (order 40), reads the Interaction mode, routes `notify` on success (success), failure (error), stop (warning) and blocked (warning, a question); publishes `task.started`/`task.finished`, `approval.requested` when blocked, `test.result`/`build.result` from its own checks, and `x.autopilot.started|step|check|blocked|paused|finished`. Every 5 s it pulls the bus (the hub's `control.stop|pause|resume` first; a resume lifts a pause but never answers a question Claude is blocked on): an owner's `stop`/`pause`/`resume`/answer arriving as `channel.inbound` from a bridge (whatsapp, telegram, slack or discord; `isOwner` from any other source is ignored), `approval.answered` for its question, any `x.<mod>.stop-all` (a hub-wide stop) and `budget.threshold` at 100 % stop or steer it. Without the hub everything works the same with toasts and its own pane.
- On success it writes `~/.claude/claude-mods/autopilot/last-plan.json` (goal, steps, checks) for workflow-studio's `/recipe save`.
- **Limits:** the checks need a POSIX `sh`; permission prompts still wait for you, so allow what the goal needs before you walk away; the plan comes from Claude's own reply (a reply without a numbered list becomes a one-step plan).

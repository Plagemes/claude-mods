# subagent-monitor
> Watch running subagents live: type, status, duration and last activity.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Opens a live pane that lists every subagent of the session: its type, the task it was given, its status, how long it has been running and the last tool it called (for example `Grep authenticate (3s ago)`). Finished agents stay listed with their outcome, tool count and tokens spent, so you can see at a glance what a fan-out of agents actually did.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install subagent-monitor@claude-mods
```

## Usage
- `/agents-live` opens the **Subagents** pane. It refreshes every 2 seconds while open.
- `/agents-live clear` drops finished agents from the list; `/agents-live close` closes the pane.
- In the pane: **Clear finished** (`c`) and **Close** (`x`).
- While subagents run, the status line reads `◐ 2 subagents running · /agents-live`.

Each agent takes two lines:
```
● Explore · Find auth handlers                    running 1m 08s
  ↳ Grep authenticate (3s ago)                  14 tools · 12.0k tok
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `showStatus` | boolean | `true` | Show the running-subagent count in the status line. |
| `keepFinished` | number | `20` | How many finished subagents stay listed in the pane. |

## How it works
- `agent.spawn` records each new subagent (type, task, model, start time); `tool.call` events carrying an `agentId` update its last activity; `turn.complete` for that agent records the outcome and token usage.
- While the pane is open or an agent is running, `$.agent.list()` is polled with `$.clock.every(2000)` to follow status changes and agents spawned elsewhere; polling stops once the pane is closed and nothing runs.
- Limits: start times of agents the mod did not see spawn (e.g. started before it loaded) are when it first listed them. An agent the engine drops from its list is shown as `ended`.
- With [mods-hub](../mods-hub) installed, each row shows the tier smart-router routed the agent to (its `agent.routed`: light, standard, deep), and each finished agent the router did not route is published as `agent.finished` (type, outcome, duration) for workflow-studio and mission-control; routed agents are reported by the router itself, with their cost. The pane stays its own (mission-control shows subagents across sessions). Without the hub nothing changes.

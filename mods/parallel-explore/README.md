# parallel-explore
> /explore sends three subagents to investigate different parts of the codebase and merges their findings.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
`/explore how does the session token get refreshed?` splits the question into three angles (a quick Haiku call; or the fixed implementation / usage & tests / config & docs), then starts three of Claude Code's built-in read-only **Explore** agents at once, one per angle. The **Explore** pane shows each one working with its elapsed time. When all three have reported, their findings are merged by one model call into a single answer with `path:line` references, which you can hand to Claude with one key. Your main conversation stays free while they work.

## Install
```
/plugin install parallel-explore --marketplace plagemes/claude-mods
```

## Usage
- `/explore <question>` — start. The transcript line names the angles: `Exploring with 3 agents in parallel: Refresh logic · Callers & tests · Config.`
- The pane: `◐ Refresh logic 0:42`, `✓ Callers & tests 1:05`, … then the merged answer. Buttons: **Send to Claude** (`s`, submits the findings as context), **Copy** (`c`), **Show reports** (`t`, the three raw reports), **Close**.
- `/explore` alone reopens the pane with the last exploration. One exploration runs at a time.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `planAngles` | boolean | `true` | Let Haiku split the question into three angles; off: the fixed three. |
| `mergeModel` | string | `inherit` | Model that merges the reports: `inherit` (the session's), an alias (`sonnet`, `haiku`) or a full id. |
| `timeoutMinutes` | number | `10` | How long to wait for the explorers before merging what came back (1–60). |

## How it works
- `command.run` plans the angles with `$.model.complete` and starts the agents with `$.agent.spawn({ subagentType: 'Explore' })`; when that type is unavailable, it falls back to its own `parallel-explore:scout` agent (registered at `session.start`, hidden from the model by `agent.offer`). Each explorer's `turn.complete` carries its report; the last one triggers the merge.
- A `tool.call` guard holds every explorer this mod started to reading: no `Edit`/`Write`, and Bash only for read programs (`rg`, `grep`, `find` without `-delete`/`-exec`, `cat`, `git log`/`show`/`diff`, …) with no redirection. Their completion notices are kept out of the main conversation; the merged answer reaches Claude only through **Send to Claude**.
- Limits: each exploration costs three agent runs plus two small model calls; an explorer that misses the deadline is merged as "no report", and the merge only knows what the reports say (check references before relying on them).

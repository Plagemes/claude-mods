# agent-presets
> Ready-made subagents for focused jobs: debugger, test writer, doc writer and migrator.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Adds four subagent types Claude can delegate to, each with a carefully written brief, a minimal tool set and a write scope a guard enforces. The **debugger** reproduces a bug, isolates the root cause, applies the minimal fix and adds a regression test. The **test writer** writes tests only and never touches source code. The **doc writer** edits docs, plus comments and docstrings in code, never the code itself. The **migrator** applies one mechanical change across many files after taking a build/test baseline, then verifies.

## Install
```
/plugin install agent-presets --marketplace plagemes/claude-mods
```

## Usage
- Ask in plain words: "Use the agent-presets:debugger agent to find why the cart total is off by a cent". Claude also picks them by itself when a task fits.
- `/presets` shows a card per preset (what it does, what it may write) with a **Use …** button that starts your prompt with `Use the agent-presets:<name> agent to …`, keeping what you had typed.
- `/presets <name> <task>` hands a task over directly, e.g. `/presets test-writer cover src/cart.ts`.

| Preset | Tools | May write |
| --- | --- | --- |
| `debugger` | Read, Grep, Glob, Edit, Write, NotebookEdit, Bash | anywhere in the project (and /tmp) |
| `test-writer` | same | test files, fixtures and snapshots only |
| `doc-writer` | Read, Grep, Glob, Edit, Write, NotebookEdit (no shell) | docs anywhere; in code only comments and docstrings |
| `migrator` | same as debugger | anywhere in the project (and /tmp) |

A refused call reads, for the subagent, like `agent-presets: the test-writer preset may only write test files and fixtures, not src/cart.ts; report bugs in the code instead of fixing them.`

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `inherit` | The presets' model: `inherit`, `sonnet`, `opus`, `haiku`, or a full id. |

## How it works
- `session.start` registers the four types with `$.agent.register` (tools limited to those this build has); `agent.spawn` notes which agent ids run a preset, with `$.agent.list()` as a fallback.
- A `tool.call` guard on Edit, Write, NotebookEdit and Bash checks only those agents' calls: paths are resolved (symlinks and `..`) against the project root; the doc writer's code edits are applied to the file and compared with comments and docstrings stripped; no preset may commit, push, reset, stash or switch branches. It fails closed for a known preset.
- Shell checks are best effort: redirections, `tee`, `cp`/`mv`/`rm`/`touch`/`mkdir` and `sed -i` are seen, a script that writes files itself (`python -c`, `node -e`) is not. The Edit/Write rules are the firm ones.

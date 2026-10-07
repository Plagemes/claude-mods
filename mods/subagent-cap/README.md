# subagent-cap
> Caps how many subagents can run at the same time.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Refuses a new `Agent` call while the maximum number of subagents is already running, so a burst of parallel delegation cannot swamp your machine, your rate limit or your attention. Claude gets a clear message (wait for one to finish, or do the work itself), you get a toast, and the status line shows `agents 2/3` while any agent runs.

## Install
```
/plugin install subagent-cap --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. When the cap is hit, Claude sees:

```
subagent-cap: 3 of 3 subagents are already running. Wait for one to finish before starting another,
or do the work yourself. The user can raise the limit in the mod settings.
```

Several `Agent` calls issued in the same message are counted one by one, so the cap holds even when they arrive together.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | number | `3` | How many subagents may run at the same time (1 or more). |

## How it works
- A `tool.call` guard on `Agent` (and `Task`, its name in older builds) counts the agents `$.agent.list()` reports as `pending`, `running` or `waiting`, plus calls it has admitted that are not listed yet, and denies the call at the cap. `idle` teammates and finished agents do not count.
- An `agent.spawn` hook, each agent's `turn.complete` and a 3-second poll (only while agents run) keep the status line current.
- Limits: it fails open (if the list cannot be read, the call goes through), counts every agent of the session including ones started by other plugins, and does not cap agents a workflow script starts.

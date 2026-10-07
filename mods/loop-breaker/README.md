# loop-breaker
> Stops Claude when it repeats the same failing command three times and suggests a different approach.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Watches Bash commands and file edits. When the very same call fails three times in a row, Claude is told to step back, read the error and try something else, and every further identical call is refused instead of run. You get a toast when it happens, so you know why Claude changed course.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install loop-breaker@claude-mods
```

## Usage
Nothing to run. On the third failure Claude's tool result carries a note:

```
loop-breaker: This exact call (npm run build) has now failed 3 times in a row. Stop repeating it.
Step back, read the error it printed, work out why it fails, and try a different approach: another
command, another way to the same result, or ask the user.
```

A fourth identical call is refused with the same advice. Your next prompt lifts the block.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | number | `3` | How many times in a row the same call may fail before identical calls are refused (2 or more). |

## How it works
- A `tool.call` hook on `Bash`, `Edit`, `MultiEdit`, `Write` and `NotebookEdit` keys each call by agent, tool and input (a shell command with its whitespace normalized). A failure is a tool result flagged as an error, so a non-zero exit status counts.
- Failures must be consecutive and identical. A successful edit, or a successful command that is not read-only, may have changed what the failing call depends on, so it clears all counts: running the tests, fixing the code and running them again is progress, not a loop.
- A `prompt.submit` hook clears the counts when a person sends a prompt (typed, remote or SDK; background notifications and other plugins do not).
- Limits: it only sees tool calls that are exactly equal; a model that keeps trying slightly different failing commands is not stopped. Counts live in memory, so a mod reload forgets them.
- With [mods-hub](../mods-hub) installed, a stopped loop becomes a `warning` notice (it reaches your channels while you are away) and is published as `error.repeated` (what failed, how often, the tool) for error-feed, lessons-learned, issue-drafter and guardian. A Bash command failing three or more times is left to the hub, whose own sensor already reports it. Without the hub nothing changes.

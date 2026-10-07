# review-agent
> Adds a dedicated code-reviewer subagent and a /review command.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Registers a `review-agent:reviewer` subagent with a thorough review brief (correctness, security, tests, readability) that labels every finding `[critical]`, `[major]`, `[minor]` or `[nit]` with a file, line and concrete fix. It works read-only: Read, Grep and Glob, plus Bash held to plain git read commands. `/review` hands it your current diff in the background, and the findings land in a pane with severity counts and an **Ask Claude to fix** button. Claude can also delegate to the reviewer on its own.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install review-agent@claude-mods
```

## Usage
- `/review` — review uncommitted changes (staged and unstaged) against `HEAD`.
- `/review main` — review everything since your branch forked from `main` (committed or not).
- `/review 123` or a pull request URL — still goes to Claude Code's built-in pull request review.
- The **Review** pane shows progress, then the report with `1 critical · 2 major · …` counts, and **Ask Claude to fix** (`f`), **Copy** (`c`), **Review again** (`r`), **Close**. A toast tells you when it is ready.
- Or just ask: "have the reviewer look at my changes".

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `inherit` | Reviewer model: `inherit` (the session's), `sonnet`, `opus`, `haiku`, or a full id. |
| `maxTurns` | number | `40` | Most steps the reviewer takes before it must report (5–200). |

## How it works
- `session.start` registers the agent type with `$.agent.register` (tools limited to Read, Grep, Glob, Bash, whichever this build has); `/review` computes the diff with git and starts it via `$.agent.spawn`; its `turn.complete` carries the report.
- `tool.call` on `Bash` refuses any reviewer command that is not a plain `git diff/log/show/status/blame/grep…` (no shell operators, no output files), failing closed; other agents and the main loop are untouched.
- Claude Code ships its own `/review` for pull requests, so this mod shares that command (PR numbers and URLs pass through) and relabels it in the menu. Untracked files are not part of `git diff`; `git add -N` them to include them. Diffs over 60,000 characters are reviewed file by file.
- With [mods-hub](../mods-hub) installed the mod says hello and, when the reviewer ends, publishes `agent.finished` (agent type `review-agent:reviewer`, outcome `ok` or `failed`, how long it took, the agent id) for workflow-studio, and the "Review ready" message goes out as a success notice (a warning when the review did not finish) through the hub: a toast, and your phone channel while you are away, since the review runs in the background. Without the hub it is the toast above.

# second-opinion
> /second-opinion has a different model critique Claude's last answer or plan.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
`/second-opinion` takes Claude's last answer, the prompt it answered, the file changes it made in that turn (as small diffs) and the commands it ran, and sends them to a different model with a critical-review brief: factual errors, wrong assumptions, bugs, security problems, missed requirements, risky steps, simpler alternatives, and no style nitpicks. By default the reviewer is the other tier of your session's model (Sonnet when you run Opus, Opus otherwise). The verdict lands in a pane in the background: agreement level, a summary, concerns ranked by severity and concrete suggestions.

## Install
```
/plugin install second-opinion --marketplace plagemes/claude-mods
```

## Usage
- `/second-opinion` — review the last answer. `/second-opinion <focus>` — e.g. `/second-opinion security of the token handling`.
- The **Second opinion** pane shows `◐ Partly agrees`, the summary, **Concerns** (`● high` / `● medium` / `● low`), **Suggestions**, and the tokens used. A toast says when it is ready: `Second opinion from sonnet: partly agrees · 2 concerns (1 high)`.
- **Send to Claude** (`s`) submits the critique and asks Claude to weigh it (agree, push back, revise). **Copy** (`c`) copies it as Markdown. **Ask again** (`r`), **Cancel** (`x`, while it runs), **Close**.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `auto` | Reviewer model: `auto` (the other tier of the session's model), or an alias (`haiku`, `sonnet`, `opus`) or a full model id. |
| `timeoutSeconds` | number | `120` | How long to wait for the reviewer (10–600). |

## How it works
- `command.run` reads `$.session.messages()` to find the last answered turn (its prompt, assistant text, `Edit`/`Write`/`NotebookEdit` inputs and `Bash` commands), then runs `$.model.complete` in the background with a JSON-only reviewer brief; a reply that is not JSON is shown as written.
- The review lives in `$.state` for the pane; nothing is added to the conversation until you press **Send to Claude**.
- Limits: the reviewer sees the transcript, not your files, so its view of the code is the diff Claude made (capped at 12k characters, the answer at 20k); it costs one extra model call per review.

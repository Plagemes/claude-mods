# task-queue
> /queue lines up prompts that run one after another whenever Claude is free.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Type `/queue <prompt>` while Claude is busy (or idle) and the prompt waits its turn. Each time a turn ends cleanly, the next queued prompt is sent as your own words, one at a time, so you can line up "write the tests", "update the README", "run the linter" and walk away. The queue is saved per project and has a pane to reorder, remove and add prompts.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install task-queue@claude-mods
```

## Usage
- `/queue <prompt>` (or `/queue add <prompt>`) adds a prompt. It works mid-turn: the command runs at once.
- `/queue` opens the **Queue** pane: the running prompt, the waiting ones with `↑` `↓` `✕` buttons, an **Add** field, **Pause** (`p`) / **Resume** (`r`), **Clear**, and the last few results (`✓` done, `⏹` interrupted, `✗` failed).
- `/queue list`, `/queue remove <n>`, `/queue clear`, `/queue pause`, `/queue resume`.
- Status line: `⏭ queue 3` (waiting), `▶ queue · 2 waiting` (one running), `⏸ queue 3 paused`.

Safety rails:
- Never submits while a turn is running, while a prompt you typed is starting, or while you have a draft in the prompt box.
- Pauses when you interrupt a turn (Esc) or a turn ends in an error or refusal.
- Pauses after `maxRuns` queued prompts in a row without you typing anything (default 20).
- Prompts left from an earlier session come back **paused**; nothing runs until you `/queue resume`.
- At most 50 waiting prompts; each prompt runs once and leaves the queue as it starts.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxRuns` | number | `20` | Most queued prompts run back to back without you typing (1–100); then the queue pauses. |

## How it works
- `turn.start` / `turn.complete` (main loop only) track whether Claude is busy; 1.5 s after a clean turn ends, the next item goes out with `$.prompt.submit({ asUser: true })`. A prompt you typed during the turn is started by Claude Code first, and the queue waits for that turn too.
- `prompt.submit` sees your own prompts (terminal, desktop, remote) to reset the runaway count; the queue lives in `$.state` for the pane and in `$.store` under the project root.
- A queued prompt is matched to the first turn that starts after it is sent; if none starts within two minutes it is marked failed and the queue pauses, so it can never stall silently.

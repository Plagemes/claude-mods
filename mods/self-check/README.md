# self-check
> At the end of each editing turn, has the model double-check it actually did what you asked.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
When a turn that edited files ends, self-check asks the model one more question over the same conversation: did that turn really satisfy every requirement of your request, is anything left half-done (TODOs, stubs), were the relevant tests or builds run, and does the final message claim anything the edits do not support? If it finds gaps, they appear above the prompt with a **Fix gaps** button that sends them back to Claude as your next prompt.

## Install
```
/plugin install self-check --marketplace plagemes/claude-mods
```

## Usage
Nothing to type. After an editing turn:
- Status line: `🔎 self-check…` while it checks, then `✓ self-check: done as asked` or `⚠ self-check: 2 gaps`.
- With gaps, a band above the prompt lists them (`You asked: …`, one `•` per gap) with **Fix gaps** (`f`) and **Dismiss** (`d`). It goes away when you start another turn.
- In `auto` mode the gaps are sent back by themselves, once, with a toast: `🔎 2 gaps found · asked Claude to close them`.

Safety rails:
- The fix turn is never checked again: one round at most, so it cannot loop.
- Nothing is ever submitted while a turn runs, while your own prompt is starting, or (auto mode) while you have a draft in the prompt box; a verdict that arrives after you started a new turn is dropped.
- Auto mode sends at most 10 fixes per session; after that it only shows the band.
- Only main-loop turns that ended normally and edited at least one file are checked; questions, interrupted turns and subagents are left alone.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `notify` \| `auto` | `notify` | `notify` shows the gaps with a Fix gaps button; `auto` also sends them back once by itself. |

## How it works
- `turn.start` records your request, `tool.call` (Edit, Write, NotebookEdit) the files the turn edited, and `turn.complete` starts the check in the background.
- The check is `$.model.fork`: the main conversation as last sent (served from the prompt cache) plus a checklist that also quotes your request and Claude's final message, answered as JSON `{complete, gaps}`. Each checked turn costs one extra request over the cached context.
- Gaps live in `$.state` and are drawn in the `AbovePrompt` band (terminal and desktop), composed above whatever else draws there; **Fix gaps** uses `$.prompt.submit({ asUser: true })`.

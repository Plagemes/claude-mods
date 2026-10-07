# session-replay
> /replay steps through the session — prompts, tool calls, edits — in a pane, like a video timeline.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
`/replay` turns the session into a timeline of steps: every prompt you sent, every answer Claude wrote, and every tool call with its input and outcome. You step through them one per page in a pane, with a scrubber that shows where you are. Commands show as code with their output, and edits as a coloured diff. Steps carry the time they happened and how long they took. `/replay export` saves the whole timeline as Markdown, for a write-up, a review or a bug report.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install session-replay@claude-mods
```

## Usage
- `/replay` opens the **Replay** pane on the newest step. While you stay on the last step it follows the session (`live`), and each finished turn adds its steps.
  - **Header:** `Step 12 / 87`, and the step's place in the whole session when a filter is on.
  - **Scrubber:** `━━━━━━●──────────`
  - **Controls:** **⏮ First** (`f`), **◀ Prev** (`p`), **Next ▶** (`n`), **Last ⏭** (`l`).
  - **Show** picker: everything, prompts, answers, tool calls, commands, edits or errors.
  - **Export** (`x`), **Refresh** (`r`), **Close** (`q`).
  - **The step:** its type and time, how long it took and whether it failed (`$ Command · 14:03:26 · 2.3 s · ✗ failed`), then its content:
    - prompts and answers as Markdown
    - commands as code
    - edits as a diff
    - todo lists as checklists
    - any other tool's input as JSON

    The tool's output follows the content.
- `/replay 12` opens the replay at step 12.
- `/replay export` writes `.claude/replays/<date-time>.md` in the project: one section per step, with code fences and outputs.
- Where no pane can be shown, `/replay` lists the last 30 steps in the transcript.

## Configuration
No configuration needed.

## How it works
- The timeline is built from `$.session.messages()`: the prompts you typed (not engine reminders or tool results), each answer's text, and each tool use with its input and the result the model read.
- What it records itself, in `$.state`:
  - from `tool.call`: when each tool call started, how long it took and whether it failed
  - from `prompt.submit`: when each prompt came in, matched to its message by text
- The pane keeps only the step on screen in `$.state`; the rest of the timeline is built when you open or refresh it. A finished turn rebuilds it only while the pane is open.
- Limits:
  - Steps from before the mod loaded (a resumed session, a hot reload) have no times.
  - Edits show the replaced text as a diff without the file's real line numbers.
  - Long contents are cut in the middle in the pane (8,000 characters), and less so in the export.
  - Only the newest 4,096 messages of very long sessions are read.

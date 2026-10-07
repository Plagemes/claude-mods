# session-journal
> Writes a dated journal entry of what was done when the session ends.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
When you leave a session, it appends an entry to `.claude/journal/YYYY-MM-DD.md`: a model-written summary of the work done and the open questions, the files that were changed, your requests, and the todos still open. A week later you can read what happened on any day without digging through transcripts.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install session-journal@claude-mods
```

## Usage
- Nothing to do: exiting the session (`/exit`, ctrl+c, `/resume` to another one) writes the entry.
- `/journal` writes one right now, with a fresh summary, e.g. `📓 session-journal: added an entry to .claude/journal/2026-10-07.md.` Exiting afterwards adds nothing unless you did more work.
- An entry looks like:

```markdown
## 18:06 · shop · main

### Work done
- Fixed the login redirect loop
### Open questions
- Should sessions expire after 7 days?

### Files changed
- `src/auth.ts`
### Requests
- Fix the login redirect loop
### Open todos
- [ ] Add a regression test

_2 prompts · 1 command · session abcdef12 · ended: prompt_input_exit_
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | string | `.claude/journal` | Folder for the daily files, relative to the project root. |
| `summarizeWhenIdle` | boolean | `true` | Refresh the model-written summary after 90 s of idle time, so the exit entry has one. |
| `includeClear` | boolean | `false` | Also write an entry when `/clear` ends a conversation. |

## How it works
- `session.end` gives every hook together only about 1.5 s, too short for a model call. So the summary is prepared earlier: 90 s after a turn ends (if you have not typed again), `$.model.fork` summarizes the transcript from the prompt cache; `/journal` does the same on demand. At exit the entry is assembled from that summary plus facts read from `$.session.messages()` (Edit/Write/MultiEdit/NotebookEdit paths, Bash count, the last TodoWrite list).
- If the summary is older than the last prompts, the entry says so; if none could be made, the factual sections are still written.
- Headless (`claude -p`) runs and empty sessions are not journaled. Each idle refresh is one extra (mostly cached) model call; turn `summarizeWhenIdle` off to avoid it.
- With [mods-hub](../mods-hub) installed, the entry also lists what other mods reported on the bus this session: **Commits** (`git.commit`, from commit-composer), **Decisions** (`decision.recorded`, decision-log), **Lessons** (`lesson.learned`, lessons-learned), the **Last test run** (`test.result`), and the session's cost (`session.ended`, else the last `cost.update`). Each written entry is published as `x.session-journal.entry` (path, project, prompts) for every session. Without the hub nothing changes.

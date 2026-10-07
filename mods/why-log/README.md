# why-log
> Records why each file was changed; /why shows the reasoning behind any file's edits.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
Every time Claude edits files, why-log notes which files a turn changed, how many edits each got, and what you had asked. When the turn ends, a small model reads your request and Claude's final message and writes one line per file saying why it changed ("Round totals to cents so receipts match the payment provider"). Months later, `/why src/cart.ts` tells you the story of that file, change by change.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install why-log@claude-mods
```

## Usage
- `/why` shows the last turn that changed files:
  ```
  Last change, 2026-10-07 14:32 · asked: "Round the cart total to cents and skip free items"
  - src/cart.ts: Skip free items and round the total to cents (2 edits)
  - src/money.ts: Add a shared rounding helper
  ```
- `/why <file>` lists that file's history, newest first, with what you asked each time (the 20 latest, then a count). A path, a project-relative path or just a file name works; an ambiguous name lists the candidates.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | The small model that writes the reasons. |

## How it works
- `turn.start` notes your request (its first 200 characters); `tool.call` on Edit, Write and NotebookEdit counts each successful edit per file (subagents' edits during the turn included); failed or refused edits are not recorded.
- At `turn.complete` the entries are saved at once, then one batched `$.model.complete` call (low effort) writes the reasons in the background; if it fails, the first sentence of Claude's own summary stands in, marked "Turn summary:". A turn cut short by the end of the session is recorded without a reason.
- The log is kept per project in `$.store`, capped at 2,000 entries (oldest dropped). Edits made from the shell (`sed`, code generators) and by background agents after the turn ended are not seen.

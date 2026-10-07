# output-trimmer
> Trims huge command outputs to head, tail and error lines before they flood the context.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
When a Bash command prints more than 12,000 characters, Claude reads the first 60 lines, the last 80 lines and, from the part in between, every distinct line that mentions an error, failure, warning, exception, traceback, panic or fatal, each with its line number. A one-line note says how many lines were cut and how to get the whole output. A 5 MB test log becomes a few kilobytes that still show what broke.

## Install
```
/plugin install output-trimmer --marketplace plagemes/claude-mods
```

## Usage
- Nothing to run: it works on every Bash call. The status line keeps the tally: `✂ 18.4k tokens trimmed from 3 outputs`.
- Claude sees a note at the cut, e.g. `[output-trimmer: 4,812 lines cut (lines 61-4,872). The 12 that mention errors or warnings follow, numbered. Add "# no-trim" to the command for the whole output.]`
- Ending a command with `# no-trim` (Claude can do it too) keeps that output whole.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `maxChars` | `12000` | Outputs (stdout and stderr together) longer than this are trimmed. |
| `headLines` | `60` | Lines kept from the start. |
| `tailLines` | `80` | Lines kept from the end. |

## How it works
- `tool.call` on Bash runs the command, then returns Bash's own result record with `stdout`/`stderr` trimmed, so the engine maps and validates it as the tool's result; the transcript row shows the trimmed text too.
- A failing command (non-zero exit) comes back as an errored call with no record to rewrite, so its text is trimmed in `session.append`, where the tool-result row is kept: Claude reads the trimmed text while the transcript row still draws the full output.
- Lines longer than 400 characters are clipped, and at most 60 error lines are listed (repeats left out). Background commands and image output are left alone. The token figure is an estimate (4 characters per token).

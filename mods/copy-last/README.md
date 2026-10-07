# copy-last
> /copy-last copies Claude's last answer (or its last code block) to the clipboard.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Two commands put Claude's output on your clipboard without selecting anything: `/copy-last` copies the whole last answer, `/copy-code` copies just the last fenced code block, without the fence lines. Each reports what was copied, or why nothing was.

## Install
```
/plugin install copy-last --marketplace plagemes/claude-mods
```

## Usage
- `/copy-last` copies the last assistant message that has text.
- `/copy-code` copies the last fenced code block of the latest answer that has one. `/copy-code 2` copies the second most recent block, and so on, across answers.
- Feedback in the transcript: `Copied the ts code block (212 characters, 9 lines).` or the reason, such as `Nothing to copy to: this session draws no screen`.

## Configuration
No configuration needed.

## How it works
- Reads the conversation with `$.session.messages()` and copies with `$.ui.copy`, the same path `/copy` uses (the machine's clipboard tool, or OSC 52 in the terminal).
- Fenced blocks are parsed the way Markdown does: ``` and ~~~ fences, longer fences that contain shorter ones, an unclosed block at the end, list indentation removed.
- Limits: OSC 52 gives no confirmation, so a terminal that ignores it still reports a successful copy; a remote surface (phone, web) may have no clipboard path.

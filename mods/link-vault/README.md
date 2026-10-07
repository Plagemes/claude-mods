# link-vault
> Collects every URL from the conversation into one list.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Long sessions scatter links through prompts and answers. `/links` gathers every URL from your prompts and Claude's replies into one numbered, de-duplicated list that shows who mentioned each one; `/links-copy` puts them all on your clipboard, one per line. Nothing is stored: the list is rebuilt from the conversation each time, so it also works on a resumed session.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install link-vault@claude-mods
```

## Usage
- `/links` prints `1. https://example.com/docs — you + Claude`, in order of first appearance. Add a filter to narrow it: `/links github`.
- `/links-copy [filter]` copies the same list to the clipboard. Where no clipboard is reachable it prints the URLs instead.

## Configuration
No configuration needed.

## How it works
- Registers both commands at `session.start` and reads the conversation on demand with `$.session.messages()` (the newest 4,096 messages). Markdown links and trailing punctuation are cleaned up; Wikipedia-style URLs with parentheses survive.
- Copies with `$.ui.copy`; the terminal clipboard write cannot confirm that a terminal honoured it.
- Limits: it reads the text of your prompts and Claude's answers, not links inside tool output such as web search results, and rows the engine injects (system reminders, command output) are skipped.

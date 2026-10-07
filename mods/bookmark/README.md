# bookmark
> /bookmark saves the last answer; /bookmarks lists and reuses them.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Keeps the answers worth remembering. `/bookmark` stores Claude's last answer (the first 2,000 characters) with a label and a timestamp; `/bookmarks` lists them; `/bookmark-insert <n>` drops one into your prompt box so you can reuse it in a new session or a different chat. Bookmarks are kept per project and survive restarts.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install bookmark@claude-mods
```

## Usage
- `/bookmark [label]` saves the last answer. Without a label, the start of the answer is the label. Replies: `📌 bookmark #3 saved: race fix`.
- `/bookmarks` lists this project's bookmarks, newest first, as `#3 · 2026-10-07 14:02 · race fix — Use a mutex around…` (times are UTC).
- `/bookmark-insert <n>` inserts bookmark `#n` into the prompt at the cursor.
- `/bookmark-delete <n>` removes it. Numbers are never reused, so `#2` always means the same bookmark.

## Configuration
No configuration needed.

## How it works
- Registers the four commands at `session.start` and answers them with `command.run`; it reads the last non-empty assistant message with `$.session.messages()`.
- Stores one list per project root in `$.store` (key `bookmarks:<root>`), at most 50 bookmarks per project (the oldest drop off).
- Limits: only text is saved, not tool output or images, and `/bookmark-insert` needs a prompt box (it says so in headless runs or while a dialog is open).

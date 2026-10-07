# persona-switch
> /persona switches Claude between reviewer, architect, teacher and other roles.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Gives Claude a working persona that lasts until you switch it off: a code reviewer that hunts bugs before writing, an architect that weighs options first, a teacher that explains as it goes, and more. The persona goes into the system prompt (not your messages), is shown in the status line, and is remembered per project, so `/persona reviewer` in one repo stays on there next time.

## Install
```
/plugin install persona-switch --marketplace plagemes/claude-mods
```

## Usage
- `/persona reviewer` switches a persona on (names complete as you type); `/persona off` switches it off; `/persona` says which is on.
- `/personas` lists them all, the active one marked `●`.
- The status line shows the active one: `◆ Code reviewer`.

| Persona | Works like |
| --- | --- |
| `reviewer` | Reviews before it writes: bugs, edge cases and missing tests first. |
| `architect` | Thinks in systems: boundaries, data flow, trade-offs, then code. |
| `teacher` | Explains what and why as it goes, at your level. |
| `pair-programmer` | Small visible steps, checks in at decisions, keeps tests green. |
| `security-auditor` | Reads every change with an attacker's eyes. |
| `product-minded` | Starts from the user problem and the smallest change that solves it. |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `customPersonas` | string (JSON) | `""` | Your own personas, `{"name": "instructions"}` or `{"name": {"label": "...", "summary": "...", "prompt": "..."}}`. A name equal to a built-in replaces it. |

Example: `{"terse": "Answer in at most three sentences.", "rust-mentor": {"label": "Rust mentor", "summary": "Idiomatic Rust, explained.", "prompt": "Prefer ownership over cloning; explain borrow-checker errors."}}`

## How it works
- `prompt.compose` appends a `session`-scoped section (`persona-switch:persona`) with the persona's instructions, after the engine's own sections, so the shared prompt cache is untouched; skipped under `--bare`.
- The active persona is kept in session state and in the mod's `$.store`, keyed by project root; `session.start` restores it and sets the status line.
- Switching personas changes the system prompt, so the next request re-reads the session part of the prompt cache once. Invalid `customPersonas` JSON is reported in a toast at session start and the built-ins keep working.

# learning-mode
> Claude explains the why behind each change and leaves small TODOs for you to complete yourself.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
`/learning on` adds a short instruction to Claude's system prompt: explain the reasoning behind each change in a sentence or two, and for up to two small, well-scoped pieces per task (a helper, a condition, a test case) leave a `TODO(you): <hint>` comment for you to write instead of writing it. The surrounding code stays complete and working. The status line shows `🎓 learning`, and when a turn ends you get a toast with how many `TODO(you)` were left and in which files.

## Install
```
/plugin install learning-mode --marketplace plagemes/claude-mods
```

## Usage
```
/learning        toggle on or off
/learning on     turn it on
/learning off    turn it off
```
After a turn that left markers, a toast reads like `🎓 3 TODO(you) left for you: slug.ts (2), new.ts`. Search your project for `TODO(you)` to find them all.

`TODO(you)` is never left in security-critical code. The instruction says so, and the mod enforces it: an edit that adds a `TODO(you)` to a file whose path names authentication, crypto, secrets, passwords, tokens, sessions, permissions, payments and the like is refused, and Claude is told to write that code completely.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `startOn` | boolean | `false` | Begin every session with learning mode on. |
| `maxTodos` | number | `2` | How many `TODO(you)` pieces Claude may leave per task. |

## How it works
- The on/off flag lives in `$.state`; `prompt.compose` appends a `learning-mode:instructions` section while it is on (a `--bare` session is left alone). Switching mode changes the system prompt once, which costs one prompt-cache miss.
- `tool.call` on `Edit`, `Write` and `NotebookEdit` counts the markers a change adds (new text minus what the replaced text already had) once the call succeeds, and refuses markers in security-looking paths. `turn.complete` of the main loop shows the toast.
- Limits: the "at most N" and "explain the why" parts are instructions Claude may not follow perfectly (the toast flags an overshoot); the security check looks at file paths, not at what the code does.

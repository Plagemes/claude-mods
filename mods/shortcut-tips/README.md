# shortcut-tips
> One tip a day about Claude Code shortcuts and features you might not know.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
The first time a session starts each day, shortcut-tips shows one tip in a toast: a keyboard shortcut, a slash command or a command-line flag you may not have met. The tips rotate through a built-in list of more than 50 and remember where they are across sessions, so you do not see the same one twice until you have seen them all. `/tip` shows the next one whenever you want.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install shortcut-tips@claude-mods
```

## Usage
```
/tip        show the next tip
```
A daily toast looks like this:

```
💡 Went down the wrong path? Double-tap esc (or run /rewind) to roll the code and/or the conversation back to an earlier point. Claude checkpoints your files before every edit.  ·  /tip for another
```

Every tip is checked against Claude Code 2.1.292 and nothing is invented: slash commands against the command definitions in the binary, shortcuts against its default keybindings and the `?` shortcuts panel, flags against `claude --help`. Commands that no longer exist (`/agents` is removed, `/vim` and `/todos` are gone) are not advertised, and there is no tip for the old `#` memory shortcut.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `showAtStart` | boolean | `true` | Show the daily tip when a session starts. Turn off to get tips only from `/tip`. |

## How it works
- `session.start` registers `/tip` and, in an interactive session that has not shown a tip today (local calendar day), toasts the next tip. `$.store` keeps the day it last showed one and the position in the list.
- `/tip` takes the next tip off the same rotation without using up the daily one.
- Limits: tips describe the default key bindings, so a key you rebound with `/keybindings` will differ; a few shortcuts (alt+p, for example) need your terminal to send the Option or Alt key as Meta. If the store cannot be read the mod stays silent instead of failing the session start.

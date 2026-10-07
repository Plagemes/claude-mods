# date-context
> Gives Claude the current date, time zone, branch and OS on every prompt.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Attaches one tiny line to each prompt you send, which only Claude reads: the local date and time to the minute with its UTC offset, your time zone, the git branch you are on and your operating system. Claude can then answer "what's the date?", "is this the right branch?" or "what shell syntax fits this OS?" without guessing.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install date-context@claude-mods
```

## Usage
Nothing to run. Claude sees, beside your prompt:
```
Current context: 2026-10-07T14:03+02:00 (Europe/Madrid), git branch feature/login, Linux.
```
The branch is left out when the directory is not a git repository (a detached HEAD reads `detached HEAD`). Slash commands and notifications from background tasks get no line.

## Configuration
No configuration needed.

## How it works
- Hooks `prompt.submit` and adds the line to the prompt's `context`, which the model reads after your words and you never see. This is deliberate: a changing date and time in the *system prompt* would change it on every request and throw away the prompt cache, so the fresh facts ride along with each prompt instead.
- The branch comes from `git symbolic-ref` and the OS from `uname -s` (asked once per session), each with a 2 second timeout; if either is missing the line simply omits it.
- The time zone name needs the runtime's `Intl`; without it the UTC offset alone is shown.
- Limits: each prompt adds about 30 tokens to the conversation. Only the branch checked out in the session's directory is reported.

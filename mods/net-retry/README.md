# net-retry
> Automatically retries commands that failed because of a temporary network error.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
When a Bash command that only fetches things (an install, `git fetch`/`pull`/`clone`, a `curl` GET, `docker pull`, ...) fails with a temporary network error such as `ETIMEDOUT`, `ECONNRESET`, `Could not resolve host` or a 502/503/504 from a registry, net-retry runs it again, waiting 2 s and then 4 s. Claude gets the last result plus a note listing the retries, so a flaky connection no longer derails the turn.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install net-retry@claude-mods
```

## Usage
Nothing to run. While it waits you see a toast such as `network error (ETIMEDOUT); retrying in 2 s (1/2)`. The command's result then reads as if it ran once, with this note added for Claude:

```
net-retry: this command hit a temporary network error and was run again 2 times (ETIMEDOUT, waited 2 s; ETIMEDOUT, waited 4 s); it worked on the last try.
```

Only commands that are safe to run twice are retried: every part of the line has to be a fetch-type command (npm/yarn/pnpm/bun install, pip, uv, cargo fetch/build, go get/mod download, apt/brew, git fetch/pull/clone/submodule update, curl without a body or a non-GET method, wget, docker pull/build, terraform init) or something harmless beside one (`cd`, `rm`, `tar`, a pipe into `tar`). `npm install && npm test`, `git push`, `curl -X POST`, background commands and anything with `$(...)`, `&` or `>>` are never repeated. Errors that are not temporary (a 404, a bad package name, `Connection refused`) are not retried either.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `retries` | number | `2` | How many times to run the command again (0 turns the mod off, at most 5). |
| `backoffSeconds` | number | `2` | The wait before the first retry; each further one waits twice as long. |

## How it works
- Hooks `tool.call` on `Bash`, lets the command run, and if it failed with a known transient pattern calls `next(e)` again after a `$.clock.sleep`. It returns the last result, so Claude sees one tool call.
- Waits count against the hook's 10-second budget, so net-retry stops early when a wait plus a 2-second margin would not fit, and stops at once if you interrupt. With the defaults the two waits use 6 s.
- Limits: it matches the error text, so an unusual tool or message is not recognised, and a retry runs the same command again from scratch (a half-finished `git clone` target directory can make the second attempt fail for a different reason). Each retry sends the same call through the rest of the chain again, so a permission prompt for it may appear again.

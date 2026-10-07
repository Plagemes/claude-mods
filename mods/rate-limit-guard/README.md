# rate-limit-guard
> Stops Claude from hammering external APIs with curl loops.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
rate-limit-guard counts the requests Claude's Bash commands send to each external host with `curl`, `wget` or httpie, in a sliding 60-second window. Past 20 calls to one host, the next call is refused and that host is paused for a minute, with advice to batch or cache instead. A `for`, `while` or `xargs` loop that fetches with nothing slowing it down is let through, but Claude is warned that every round is a separate request. `localhost` and private network addresses are never limited.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install rate-limit-guard@claude-mods
```

## Usage
Nothing to run. On the 21st call within a minute Claude reads `rate-limit-guard: 20 requests to api.example.com in the last 60 s, and the limit is 20. Requests to api.example.com are paused for 60 s. Wait for the pause to end, get what you need in fewer requests ...` and you see a toast (`paused requests to api.example.com for 60 s (20 in the last 60 s)`). Calls during the pause are refused with the seconds left; afterwards counting starts fresh.

For `for i in $(seq 1 200); do curl https://api.example.com/items/$i; done` the command runs, and Claude gets `rate-limit-guard: this command fetches in a loop (about 200 rounds) with nothing slowing it down, so every round is a separate request. External hosts are limited to 20 calls per 60 s here. Add a sleep between rounds ...`. A loop that sleeps or waits is not warned about.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxCalls` | number | `20` | Requests to one external host allowed within the window. |
| `windowSec` | number | `60` | The sliding window, in seconds; also how long a host stays paused. |

## How it works
- Hooks `tool.call` for `Bash`. The command line is read with the shared claude-mods shell reader (quotes, `&&`, `|`, `;`, heredocs), looked through `sudo`, `env`, `time`, `timeout` and `xargs`, and into `bash -c`, `su -c`, `eval`, `$(…)` and heredocs fed to a shell, and each URL argument of `curl`, `wget`, `http`, `https` and `xh` is reduced to its host (userinfo and ports ignored). A command that mentions a host twice counts twice; if one host of a command is over the limit the whole command is refused and nothing is recorded for the others.
- The counters live in memory for the session (a plugin reload starts them over). It fails open: if anything goes wrong the command runs.
- With [mods-hub](../mods-hub) installed, every refusal is also published as `risk.blocked` (rule `limit-reached` or `paused`, severity `low`, the command with secrets masked), and the "paused requests to …" note goes through the hub's notifications (`warning`) instead of a toast. Without the hub nothing changes.
- Limits: a loop counts as one request however many rounds it makes (the warning gives an estimate when the range is written out); requests from scripts, `npm run`, `python -c` or `fetch` in Node are not seen, and a URL in a shell variable has no readable host.

# log-tail
> /tail follows a log file or container in a live pane, with an errors-only filter.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
`/tail` follows a log in a pane while you keep working. The log can be a file, a Docker container or a Compose service. Errors show in red and warnings in yellow. You can filter the lines by text or regex, show errors only, or pause the view. **Send to Claude** asks Claude about the lines you selected. Each tail has its own id and pane, so several can run at once.

## Install
```
/plugin install log-tail --marketplace plagemes/claude-mods
```

## Usage
- `/tail logs/app.log` follows a file. The path can be relative, absolute or start with `~/`. The tail starts with the file's last 200 lines and keeps reading as the file grows or rotates. A file that doesn't exist yet is followed as soon as it appears.
- `/tail docker:web` follows a container's logs. `/tail compose:worker` follows a Compose service.
- `/tail` lists the tails and their ids. `/tail stop <id>` stops one, and `/tail stop all` stops them all. A plain `/tail stop` is enough when only one runs.
- Running `/tail` again on the same target opens its pane again, or follows it again if it ended.
- The pane shows:
  - a header: `● following  /work/logs/app.log · 1,204 lines · 3 errors`. When paused it reads `⏸ paused · 12 new`.
  - **Filter**: a case-insensitive substring, or `/regex/flags`. It applies as you type.
  - buttons: **Errors only** (`e`), **Pause** / **Resume** (`p`), **Send to Claude** (`c`), **Stop** (`s`) or **Follow again** (`f`), and **Close**
  - the last 1,000 lines, newest at the bottom, filtered as set
- **Send to Claude** submits the text you selected with the mouse (fullscreen terminal or desktop). With nothing selected, it sends the last 40 lines the pane shows, with your filter applied, and asks Claude to explain them and find the cause.
- Status line: `⇣ tail app.log · ✗ 3 errors`, or `⇣ 2 tails` while several run. A toast says when a tail ends on its own, for example when a container stops.

## Configuration
No configuration needed.

## How it works
- Each tail streams a process with `$.process.spawn`:
  - files: `tail -n 200 -F <path>`
  - containers: `docker logs -f --tail 200 <name>`
  - Compose services: `docker compose logs -f --tail 200 --no-color --no-log-prefix <service>`
- A background loop splits the output into lines, strips colors and keeps a ring buffer of 1,000 lines per tail. It publishes the buffer to the pane's state at most 5 times a second. Filters run when the pane draws, so changing one never loses lines.
- Stop, `session.end` and reloading the mod all close the stream, and the engine kills the process.
- Limits:
  - Errors are recognised from the text: log levels, `level=error`, JSON `"level":"error"`, `Error:` prefixes and exceptions.
  - Very long lines are cut at 2,000 characters.
  - Mobile has no text field, so the filter can't be set there.

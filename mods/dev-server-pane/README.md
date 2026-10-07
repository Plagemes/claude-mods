# dev-server-pane
> Starts your dev server in the background and shows its errors in a live pane.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
`/dev` finds your project's dev command and runs it in the background, inside the session. A **Dev server** pane follows its output live, with errors in red and warnings in yellow. It shows the address the server listens on. When something breaks, **Ask Claude to fix** sends the last error and its stack trace to Claude. Claude is also told the server is already running, so it doesn't start a second one on the same port.

| Project | Command `/dev` runs |
| --- | --- |
| package.json with a `dev`, `start`, `serve` or `develop` script | `npm run dev`, `pnpm dev`, `yarn dev` or `bun run dev` (from `packageManager` or the lockfile) |
| Django (`manage.py`) | `.venv/bin/python manage.py runserver` (a virtualenv's python first, else `python3`) |
| Rails | `bin/dev`, else `bin/rails server`, else `bundle exec rails server` |
| Phoenix / Laravel | `mix phx.server` / `php artisan serve` |

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install dev-server-pane@claude-mods
```

## Usage
- `/dev` starts the detected command and opens the pane. While the server runs, `/dev` just opens the pane again.
- `/dev <command>` runs your own command through `sh`, e.g. `/dev PORT=4000 npm start`.
- `/dev restart` restarts the server. `/dev stop` stops it.
- The pane shows:
  - a header: `● running  pnpm dev  localhost:5173  2 errors`, then where the command came from and the folder it runs in
  - **Stop** (`s`) or **Start**, **Restart** (`r`), **Ask Claude to fix** (`f`, shown once an error appears) and **Close**
  - the last 500 lines of output, colors stripped. Progress lines are redrawn in place, as a terminal shows them.
- Status line: `▶ dev · localhost:5173`, with `· ✗ 2 errors` added after errors. When the server dies on its own, it changes to `✗ dev exited (1) · /dev` and a toast says so.
- Closing the pane leaves the server running. The server stops with `/dev stop` or when the session ends.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | string | `""` | The command `/dev` runs, e.g. `pnpm dev --port 4000`. Empty: detected as above. |

## How it works
- `/dev` starts `sh -c "<command>"` with `$.process.spawn` in the session's folder, with `BROWSER=none` so the server doesn't open a browser tab. A background loop reads the output stream piece by piece and keeps a ring buffer of 500 lines. It publishes the buffer to the pane at most 5 times a second. The URL comes from the first `http://localhost:…` (or "listening on port …") line.
- Stopping closes the stream, and the engine kills the whole process tree. `session.end` does the same, and so does reloading the mod.
- A `prompt.submit` hook adds one line of context the first time Claude sees the server running, and again when it stops. It doesn't add the line on every prompt.
- Limits:
  - Error detection reads the text, so a log line containing "error" counts as one.
  - The server gets no stdin, so interactive prompts like "port in use, use another?" can't be answered. Pass the port in the command instead.

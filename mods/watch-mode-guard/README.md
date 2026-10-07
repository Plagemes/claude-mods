# watch-mode-guard
> Blocks watch-mode and never-ending commands run in the foreground, where they'd hang the turn.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
A command that never exits, run in the foreground, holds the whole turn until it times out. watch-mode-guard refuses those before they start and tells Claude what to run instead: the one-shot variant (`vitest run`, `jest --ci`, `tsc --noEmit`) or the same command with `run_in_background: true`. It knows the test watchers (`jest --watch`, `vitest` without `run`, `mocha --watch`), build watchers (`tsc -w`, `webpack --watch`, `rollup -w`, `nodemon`), dev servers (`npm run dev`/`start`/`serve`, `vite`, `next dev`, `rails s`, `flask run`, `uvicorn`, `php artisan serve`, `python -m http.server`) and followers (`tail -f`, `docker compose up` without `-d`, `docker logs -f`, `kubectl logs -f`, `journalctl -f`, `ping` without `-c`).

## Install
```
/plugin install watch-mode-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. When Claude tries one of these commands it gets a message like:

```
watch-mode-guard: `npx vitest src/app.test.ts` keeps running until it is stopped, so in the foreground it would hang this turn. Run `vitest run` so it runs once and exits. To keep it running on purpose, start it with run_in_background: true.
```

Commands are let through when they run in the background (`run_in_background: true`, or a trailing `&`), are bounded (`timeout 60 npm run dev`, or a Bash `timeout` of 60 seconds or less), or are the one-shot form (`vitest run`, `jest --watchAll=false`, `docker compose up -d`, `tail -n 100 file`, `vite build`, `vite --help`). Vitest is also let through when `CI` is set in the environment or in the command. Compound commands are checked part by part, and the message names the part that never ends; here-document bodies (`cat <<'EOF' … EOF`) are text and are not checked.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | string | empty | Regular expression. A command that matches is never blocked, for example `^npm start$` when your start script exits. An invalid regex is ignored. |

## How it works
- A `tool.call` hook on `Bash` reads the command line (split at `&&`, `||`, `;`, `|`, newlines and `&`), strips what runs before the program (`NODE_ENV=x`, `sudo`, `npx`, `bundle exec`, `poetry run`) and matches the program and its flags against a table of watchers and servers. Nothing is run to decide.
- Package scripts are matched by name: `dev`, `start`, `serve`, `watch`, `preview`, `storybook`, `*:watch`, `*:dev` and the like, but not `build:dev`, `storybook:build` or `test:unit`.
- Limits: it judges by name, not by what the script does. `npm test` is never blocked because it is usually one-shot, even if your `test` script runs a watcher, and a start script that exits needs the `allow` option. Vitest only watches by default in a terminal, so a bare `vitest` may in fact run once under Claude; it is refused anyway, because `vitest run` is the explicit form.

# mock-server
> /mock starts a fake API server from your OpenAPI spec so you can build the frontend before the backend.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
`/mock` finds your `openapi.yaml` (or `swagger.json`, …) and serves it on `http://localhost:4010`: every operation answers with the example from the spec, or with a value made up from its schema (`$ref`, `allOf`, enums, formats like `date-time` and `uuid` included). Path parameters match any value, unknown paths get a 404 listing the real ones, wrong methods a 405, and CORS is open so your dev frontend can call it. When the project has `@stoplight/prism-cli` installed, Prism is used instead. A pane shows the operations and every request as it arrives; the status line shows `🧪 mock :4010`.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install mock-server@claude-mods
```

## Usage
- `/mock` — mock the spec found in the root, `api/`, `docs/`, `spec/`, `openapi/`, `public/`, `src/` … on the default port.
- `/mock path/to/openapi.yaml 5000` — a given spec and/or port (either can be left out).
- `/mock` again while it runs reopens the **Mock server** pane: status, URL, operations (`GET /products → 200`), output, and recent requests with status and timing. Buttons: **Stop** (`s`), **Restart** (`r`), **Copy URL** (`c`), **Clear requests**, **Close**.
- `/mock stop` — stop it. It also stops when the session ends (it keeps running through `/clear`).
- A busy port says so: `port 4010 is already in use; try /mock openapi.yaml 4011`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | number | `4010` | Port used when `/mock` names none. |
| `engine` | string | `auto` | `auto`: Prism when `node_modules/.bin/prism` exists, else the built-in mock. `prism`: always Prism (through `npx --yes @stoplight/prism-cli` when not installed; the first run downloads it). `builtin`: always the built-in mock. |

## How it works
- `command.run` reads the spec (a small YAML reader built in, JSON too), turns each operation's first 2xx response into a canned body, and starts `node -e <built-in server>` with those routes on stdin through `$.process.spawn`, bound to `127.0.0.1`. The server prints one JSON line per request, which the pane reads; Prism's log lines are read the same way.
- The child lives as long as the stream is read: `/mock stop`, a new `/mock`, `session.end` or unloading the mod ends it.
- Limits: the built-in mock needs Node.js on `PATH`, answers one response per operation (no `Prefer` header, no request validation; use Prism for those), and resolves only local `$ref`s; YAML anchors and aliases are not expanded. A body made up from schemas holds at most 1,000 values, so deeply linked schemas end in `null`s.

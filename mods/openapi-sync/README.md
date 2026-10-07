# openapi-sync
> Warns when your API routes change but openapi.yaml doesn't.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
Every time Claude edits a file that defines HTTP routes, the routes before and after the edit are compared. When the turn ends, new or renamed routes your OpenAPI/Swagger spec does not document, and removed routes it still documents, show up in a band above the prompt with an **Ask Claude to update the spec** button. A spec updated in the same turn (or any later one) is re-checked, so the band only lists what is really still out of sync.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install openapi-sync@claude-mods
```

## Usage
Nothing to run. After a turn that drifted from the spec you see:

```
⚠ openapi-sync 2 routes out of sync with openapi.yaml
  + POST /users/{id}/avatar  (src/routes/users.ts) — not in the spec
  − DELETE /users/{id}  (src/routes/users.ts) — removed, still in the spec
[ Ask Claude to update the spec ] [ Dismiss ]
```

**Ask Claude to update the spec** (`u`) sends Claude the list with the files involved; **Dismiss** (`d`) hides it.

Routes it reads: Express, Koa, Hono, Fastify (`app.get`, `router.post`, `fastify.route({...})`), NestJS (`@Controller` + `@Get`), Next.js (`app/**/route.ts` exports, `pages/api/**`), FastAPI and Flask (decorators, `APIRouter(prefix=)`, `Blueprint(url_prefix=)`), Django `urls.py`, Laravel `routes/*.php` (incl. `apiResource`), Go (`HandleFunc`, Go 1.22 `"GET /x"` patterns, gorilla `.Methods`, chi/gin/echo), Rails `config/routes.rb` and Spring `@GetMapping`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `specPath` | string | `""` | Your spec file from the project root. Empty: the best `openapi.*`/`swagger.*` (YAML or JSON) in the root, `api/`, `docs/`, `spec/`, `openapi/`, `public/`, `static/`, `src/` and similar folders. |

## How it works
- `tool.call` on `Edit`/`Write` reads a route file before and after the edit and keeps the added and removed routes of the turn (a route moved between files cancels out); subagent edits count toward the turn.
- `turn.complete` (main loop) reads the spec's `paths` (YAML or JSON, `servers`/`basePath` prefixes honoured, `{param}` names ignored) and stores what is still out of sync; the band is an `AbovePrompt` render that yields to surveys and running turns and composes with other bands.
- Limits: only routes changed through Claude's edits are tracked (not your own edits or shell commands), detection is pattern based (routes built from variables or mounted under a prefix in another file are seen without that prefix), and a project without a spec file stays silent.
- With [mods-hub](../mods-hub) installed: the greeting says it publishes `lint.result` (`tool: openapi-sync`, one warning per route out of sync, with the spec and the route files), each time a turn's check leaves routes out of sync. The band is unchanged and no notification is added. Without the hub nothing changes.
